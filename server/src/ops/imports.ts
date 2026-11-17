/**
 * Import pipeline (ARCHITECTURE "Data flow of imports"): file -> core parse (all-or-nothing) -> ONE transaction:
 * import_batch -> mirror upsert -> diffMirror(before, after) -> wr_event / wr_stage_history -> gone flags.
 * Notifications are sent after the commit. SONU-owned data (wr_internal) is never written here.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  detectExportDetailed,
  diffMirror,
  EXPORTS,
  isCompleted,
  LIST_KEYS,
  parseExport,
  readSheet,
  type ListKey,
  type MirrorEvent,
  type TypedRow,
} from '@sonu/core';
import { withTx, type PoolClient } from '../db.js';
import { notify } from '../notifications/index.js';
import { sqlDateIn, todayFor } from './context.js';

export interface RunImportInput {
  contractorId: string;
  buffer: Buffer;
  fileName: string;
  listKey?: string;
  userId?: string;
  syncRunId?: string;
}

export interface RunImportResult {
  ok: boolean;
  batchId?: string;
  listKey?: string;
  rowsRead?: number;
  new?: number;
  changed?: number;
  gone?: number;
  events?: number;
  unchanged?: boolean;
  warnings?: string[];
  error?: { code: string; message: string; missingCaptions?: string[]; candidates?: string[] };
}

/** Lists that hold the full set of open WRs: a WR missing from a new file of one of them is "gone". */
const MASTER_LISTS: ListKey[] = ['pending_work_requests', 'wr_dashboard'];
/** Number of earlier snapshots kept per list (the newest is the "before" of the next import). */
const SNAPSHOTS_KEPT = 10;

const s = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function failedBatch(app: FastifyInstance, input: RunImportInput, listKey: string, hash: string, message: string): Promise<string> {
  const r = await app.db.query<{ id: string }>(
    `INSERT INTO import_batch (contractor_id, list_key, source, file_name, file_hash, user_id, sync_run_id, status, result, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'failed','failed',$8) RETURNING id`,
    [input.contractorId, listKey, input.syncRunId ? 'worker' : 'manual', input.fileName, hash, input.userId ?? null, input.syncRunId ?? null, message.slice(0, 2000)],
  );
  return r.rows[0]!.id;
}

/** Captions of the file, used for list detection when no listKey is given. */
function detect(buffer: Buffer): { key: ListKey | null; candidates: string[] } {
  try {
    const sheet = readSheet(buffer);
    const d = detectExportDetailed(sheet.captions);
    return { key: d.key, candidates: d.candidates.map((c) => c.key) };
  } catch {
    return { key: null, candidates: [] };
  }
}

export async function runImport(app: FastifyInstance, input: RunImportInput): Promise<RunImportResult> {
  const hash = crypto.createHash('sha256').update(input.buffer).digest('hex');
  let listKey: ListKey | null = null;
  if (input.listKey) {
    if (!(LIST_KEYS as string[]).includes(input.listKey)) {
      const message = `Unknown list "${input.listKey}".`;
      const batchId = await failedBatch(app, input, input.listKey.slice(0, 60), hash, message);
      return { ok: false, batchId, error: { code: 'UNKNOWN_LIST', message } };
    }
    listKey = input.listKey as ListKey;
  } else {
    const d = detect(input.buffer);
    if (!d.key) {
      const message = d.candidates.length > 1
        ? `"${input.fileName}" could be one of several lists (${d.candidates.join(', ')}). Choose the list and upload again. Nothing was loaded.`
        : `"${input.fileName}" was not recognised as any Marafiq export (no matching column captions). Nothing was loaded.`;
      const batchId = await failedBatch(app, input, 'unknown', hash, message);
      return { ok: false, batchId, error: { code: 'UNKNOWN_FILE', message, candidates: d.candidates } };
    }
    listKey = d.key;
  }

  const parsed = parseExport(listKey, input.buffer, input.fileName);
  if (!parsed.ok) {
    const batchId = await failedBatch(app, input, listKey, hash, parsed.error.message);
    return { ok: false, batchId, listKey, error: { code: parsed.error.code, message: parsed.error.message, missingCaptions: parsed.error.missingCaptions } };
  }
  const rows = parsed.rows;
  const key = listKey;
  const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [input.contractorId])).rows[0]?.time_zone;
  const today = todayFor(app, tz);

  const outcome = await withTx(app.db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import:${input.contractorId}:${key}`]);
    // "before" = rows of the newest snapshot of this list.
    const prev = await c.query<{ id: string; file_hash: string | null; created_at: Date }>(
      `SELECT b.id, b.file_hash, b.created_at FROM import_batch b
        WHERE b.contractor_id = $1 AND b.list_key = $2 AND b.status = 'ok'
          AND EXISTS (SELECT 1 FROM list_snapshot ls WHERE ls.import_batch_id = b.id)
        ORDER BY b.created_at DESC LIMIT 1`,
      [input.contractorId, key],
    );
    const prevBatch = prev.rows[0];
    const source = input.syncRunId ? 'worker' : 'manual';

    if (prevBatch && prevBatch.file_hash === hash) {
      const b = await c.query<{ id: string }>(
        `INSERT INTO import_batch (contractor_id, list_key, source, file_name, file_hash, user_id, sync_run_id, status, result, rows_read, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ok','unchanged',$8,$9) RETURNING id`,
        [input.contractorId, key, source, input.fileName, hash, input.userId ?? null, input.syncRunId ?? null, parsed.rowsRead, JSON.stringify(parsed.warnings.slice(0, 200))],
      );
      return { batchId: b.rows[0]!.id, unchanged: true as const, counts: { new: 0, changed: 0, gone: 0, events: 0 }, notes: [] as Note[] };
    }

    const beforeRows: TypedRow[] = prevBatch
      ? (await c.query<{ row: TypedRow }>('SELECT row FROM list_snapshot WHERE import_batch_id = $1 ORDER BY row_no', [prevBatch.id])).rows.map((r) => r.row)
      : [];
    const beforeToday = prevBatch ? prevBatch.created_at.toISOString().slice(0, 10) : today;

    const b = await c.query<{ id: string }>(
      `INSERT INTO import_batch (contractor_id, list_key, source, file_name, file_hash, user_id, sync_run_id, status, result, rows_read, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ok','ok',$8,$9) RETURNING id`,
      [input.contractorId, key, source, input.fileName, hash, input.userId ?? null, input.syncRunId ?? null, parsed.rowsRead, JSON.stringify(parsed.warnings.slice(0, 200))],
    );
    const batchId = b.rows[0]!.id;

    // Snapshot of this file (the next import's "before").
    const def = EXPORTS[key];
    const keyField = def.columns.find((col) => col.caption.toLowerCase() === def.keyColumn.toLowerCase())!.field;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const params: unknown[] = [input.contractorId, key, batchId];
      const values = chunk.map((r, j) => {
        params.push(i + j + 1, s(r[keyField]), JSON.stringify(r));
        const p = params.length;
        return `($1,$2,$3,$${p - 2},$${p - 1},$${p})`;
      });
      await c.query(`INSERT INTO list_snapshot (contractor_id, list_key, import_batch_id, row_no, row_key, row) VALUES ${values.join(',')}`, params);
    }
    // Prune old snapshots of this list.
    await c.query(
      `DELETE FROM list_snapshot WHERE contractor_id = $1 AND list_key = $2 AND import_batch_id NOT IN (
         SELECT b.id FROM import_batch b WHERE b.contractor_id = $1 AND b.list_key = $2 AND b.status = 'ok'
            AND EXISTS (SELECT 1 FROM list_snapshot ls WHERE ls.import_batch_id = b.id)
          ORDER BY b.created_at DESC LIMIT $3)`,
      [input.contractorId, key, SNAPSHOTS_KEPT],
    );

    const created = await upsertMirror(c, input.contractorId, key, rows, batchId);
    const events = diffMirror(beforeRows, rows, key, { today, beforeToday });
    const res = await writeEvents(c, input.contractorId, key, events, batchId, created, !prevBatch);

    await c.query('UPDATE import_batch SET rows_new = $2, rows_changed = $3, rows_gone = $4, events = $5 WHERE id = $1', [
      batchId, res.counts.new, res.counts.changed, res.counts.gone, res.counts.events,
    ]);
    return { batchId, unchanged: false as const, counts: res.counts, notes: res.notes };
  });

  // Notifications after the commit (mail is sent inline by notify()).
  for (const note of outcome.notes) {
    try {
      await notify(app, { contractorId: input.contractorId, ...note });
    } catch (err) {
      app.log.warn({ err: (err as Error).message, event: note.event }, 'import notification failed');
    }
  }

  return {
    ok: true,
    batchId: outcome.batchId,
    listKey: key,
    rowsRead: parsed.rowsRead,
    new: outcome.counts.new,
    changed: outcome.counts.changed,
    gone: outcome.counts.gone,
    events: outcome.counts.events,
    unchanged: outcome.unchanged,
    warnings: parsed.warnings.slice(0, 50),
  };
}

// ───────────────────────────── mirror upsert ─────────────────────────────

/** Upserts the mirror tables for one list; returns the WR codes whose work_request row was newly created. */
async function upsertMirror(c: PoolClient, contractorId: string, key: ListKey, rows: TypedRow[], batchId: string): Promise<Set<string>> {
  const created = new Set<string>();
  const byCode = new Map<string, TypedRow>();
  if (key === 'pending_work_requests') {
    for (const r of rows) byCode.set(String(r.wrCode), r);
    for (const r of byCode.values()) {
      const x = await c.query<{ inserted: boolean }>(
        `INSERT INTO work_request (contractor_id, wr_code, wr_status, sr_code, ptw_code, ptw_status, requestor_name, contractor_code,
            site_code, site_name, building_code, building_name, floor_code, room_code, directorate_code, department_code,
            equipment_code, equipment_standard, problem_type, problem_type_description, work_team_code, priority, description,
            date_requested, agreed_target_date, date_trade_assigned, est_total_cost, last_import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                 ${sqlDateIn(24)}, ${sqlDateIn(25)}, ${sqlDateIn(26)}, $27, $28)
         ON CONFLICT (contractor_id, wr_code) DO UPDATE SET
            wr_status = EXCLUDED.wr_status, sr_code = EXCLUDED.sr_code, ptw_code = EXCLUDED.ptw_code, ptw_status = EXCLUDED.ptw_status,
            requestor_name = EXCLUDED.requestor_name, contractor_code = EXCLUDED.contractor_code, site_code = EXCLUDED.site_code,
            site_name = EXCLUDED.site_name, building_code = EXCLUDED.building_code, building_name = EXCLUDED.building_name,
            floor_code = EXCLUDED.floor_code, room_code = EXCLUDED.room_code, directorate_code = EXCLUDED.directorate_code,
            department_code = EXCLUDED.department_code, equipment_code = EXCLUDED.equipment_code,
            equipment_standard = EXCLUDED.equipment_standard, problem_type = EXCLUDED.problem_type,
            problem_type_description = EXCLUDED.problem_type_description, work_team_code = EXCLUDED.work_team_code,
            priority = EXCLUDED.priority, description = EXCLUDED.description, date_requested = EXCLUDED.date_requested,
            agreed_target_date = EXCLUDED.agreed_target_date, date_trade_assigned = EXCLUDED.date_trade_assigned,
            est_total_cost = EXCLUDED.est_total_cost, last_import_id = EXCLUDED.last_import_id,
            last_seen_at = now(), gone_at = NULL, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          contractorId, String(r.wrCode), s(r.wrStatus), s(r.serviceRequestCode), s(r.ptwCode), s(r.ptwStatus), s(r.requestor), s(r.contractor),
          s(r.siteCode), s(r.siteName), s(r.buildingCode), s(r.buildingName), s(r.floorCode), s(r.roomCode), s(r.directorateCode), s(r.departmentCode),
          s(r.equipmentCode), s(r.equipmentStandard), s(r.problemType), s(r.problemTypeDescription), s(r.workTeamCode), s(r.priority), s(r.description),
          s(r.dateRequested), s(r.targetDate), s(r.dateTradeAssigned), n(r.estimatedTotalCost), batchId,
        ],
      );
      if (x.rows[0]?.inserted) created.add(String(r.wrCode));
    }
  } else if (key === 'wr_dashboard') {
    for (const r of rows) byCode.set(String(r.wrCode), r);
    for (const r of byCode.values()) {
      // The dashboard owns the descriptive status; other columns only fill gaps (Pending Work Requests is authoritative).
      const x = await c.query<{ inserted: boolean }>(
        `INSERT INTO work_request (contractor_id, wr_code, wr_status, wo_code, requestor_name, contractor_code, site_code, site_name,
            building_code, building_name, floor_code, room_code, equipment_code, problem_type, work_team_code, priority, description,
            date_requested, agreed_target_date, date_trade_assigned, est_total_cost, descriptive_status, last_import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, ${sqlDateIn(18)}, ${sqlDateIn(19)}, ${sqlDateIn(20)}, $21, $22, $23)
         ON CONFLICT (contractor_id, wr_code) DO UPDATE SET
            descriptive_status = EXCLUDED.descriptive_status,
            wr_status = COALESCE(work_request.wr_status, EXCLUDED.wr_status),
            wo_code = COALESCE(EXCLUDED.wo_code, work_request.wo_code),
            site_code = COALESCE(work_request.site_code, EXCLUDED.site_code),
            site_name = COALESCE(work_request.site_name, EXCLUDED.site_name),
            building_code = COALESCE(work_request.building_code, EXCLUDED.building_code),
            building_name = COALESCE(work_request.building_name, EXCLUDED.building_name),
            problem_type = COALESCE(work_request.problem_type, EXCLUDED.problem_type),
            work_team_code = COALESCE(work_request.work_team_code, EXCLUDED.work_team_code),
            description = COALESCE(work_request.description, EXCLUDED.description),
            last_import_id = EXCLUDED.last_import_id, last_seen_at = now(), gone_at = NULL, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          contractorId, String(r.wrCode), s(r.wrStatus), s(r.assignedToWorkOrder), s(r.requestor), s(r.contractor), s(r.siteCode), s(r.siteName),
          s(r.buildingCode), s(r.buildingName), s(r.floorCode), s(r.roomCode), s(r.equipmentCode), s(r.problemType), s(r.workTeamCode),
          s(r.workRequestPriority), s(r.description), s(r.dateRequested), s(r.targetDate), s(r.dateTradeAssigned), n(r.estimatedTotalCost),
          s(r.descriptiveStatus), batchId,
        ],
      );
      if (x.rows[0]?.inserted) created.add(String(r.wrCode));
    }
  } else if (key === 'review_approved_estimations') {
    for (const r of rows) byCode.set(String(r.wrCode), r);
    for (const r of byCode.values()) {
      await c.query(
        `INSERT INTO rfe_status (contractor_id, work_request_id, wr_code, submitted_on, approved_on, raw, last_import_id)
         VALUES ($1, (SELECT id FROM work_request WHERE contractor_id = $1 AND wr_code = $2), $2, ${sqlDateIn(3)}, ${sqlDateIn(4)}, $5, $6)
         ON CONFLICT (contractor_id, wr_code) DO UPDATE SET
            work_request_id = COALESCE(EXCLUDED.work_request_id, rfe_status.work_request_id),
            submitted_on = EXCLUDED.submitted_on, approved_on = EXCLUDED.approved_on, raw = rfe_status.raw || EXCLUDED.raw,
            last_import_id = EXCLUDED.last_import_id, last_seen_at = now(), gone_at = NULL`,
        [contractorId, String(r.wrCode), s(r.rfeSubmittedOn), s(r.rfeApprovedOn), JSON.stringify({ review_approved_estimations: r }), batchId],
      );
    }
  } else if (key === 'pending_rfe_status') {
    for (const r of rows) byCode.set(String(r.wrCode), r);
    for (const r of byCode.values()) {
      await c.query(
        `INSERT INTO rfe_status (contractor_id, work_request_id, wr_code, submitted_on, pending_with, rfe_amount, raw, last_import_id)
         VALUES ($1, (SELECT id FROM work_request WHERE contractor_id = $1 AND wr_code = $2), $2, ${sqlDateIn(3)}, $4, $5, $6, $7)
         ON CONFLICT (contractor_id, wr_code) DO UPDATE SET
            work_request_id = COALESCE(EXCLUDED.work_request_id, rfe_status.work_request_id),
            submitted_on = COALESCE(rfe_status.submitted_on, EXCLUDED.submitted_on),
            pending_with = EXCLUDED.pending_with, rfe_amount = EXCLUDED.rfe_amount, raw = rfe_status.raw || EXCLUDED.raw,
            last_import_id = EXCLUDED.last_import_id, last_seen_at = now()`,
        [contractorId, String(r.wrCode), s(r.dateRfeSubmitted), s(r.pendingWith), n(r.rfeAmount), JSON.stringify({ pending_rfe_status: r }), batchId],
      );
    }
  } else if (key === 'rfe_post_box') {
    for (const r of rows) {
      await c.query(
        `INSERT INTO rfe_comment (contractor_id, work_request_id, log_id, wr_code, text, created_by_name, created_on, send_to, raw, last_import_id)
         VALUES ($1, (SELECT id FROM work_request WHERE contractor_id = $1 AND wr_code = $3), $2, $3, $4, $5, ${sqlDateIn(6)}, $7, $8, $9)
         ON CONFLICT (contractor_id, log_id) DO UPDATE SET
            work_request_id = COALESCE(EXCLUDED.work_request_id, rfe_comment.work_request_id), wr_code = EXCLUDED.wr_code,
            text = EXCLUDED.text, created_by_name = EXCLUDED.created_by_name, created_on = EXCLUDED.created_on,
            send_to = EXCLUDED.send_to, raw = EXCLUDED.raw, last_import_id = EXCLUDED.last_import_id, last_seen_at = now()`,
        [contractorId, String(r.logId), s(r.wrCode), s(r.comments), s(r.createdBy), s(r.dateCreated), s(r.sendTo), JSON.stringify(r), batchId],
      );
    }
  } else if (key === 'manage_permit_to_work') {
    for (const r of rows) {
      await c.query(
        `INSERT INTO permit (contractor_id, ptw_code, status, date_start, date_upto, date_issued, applicant, controller, authority, wr_codes, raw, last_import_id)
         VALUES ($1,$2,$3, ${sqlDateIn(4)}, ${sqlDateIn(5)}, ${sqlDateIn(6)}, $7, $8, $9,
                 COALESCE((SELECT array_agg(wr_code ORDER BY wr_code) FROM work_request WHERE contractor_id = $1 AND ptw_code = $2), '{}'), $10, $11)
         ON CONFLICT (contractor_id, ptw_code) DO UPDATE SET
            status = EXCLUDED.status, date_start = EXCLUDED.date_start, date_upto = EXCLUDED.date_upto, date_issued = EXCLUDED.date_issued,
            applicant = EXCLUDED.applicant, controller = EXCLUDED.controller, authority = EXCLUDED.authority,
            wr_codes = CASE WHEN cardinality(EXCLUDED.wr_codes) > 0 THEN EXCLUDED.wr_codes ELSE permit.wr_codes END,
            raw = EXCLUDED.raw, last_import_id = EXCLUDED.last_import_id, last_seen_at = now(), gone_at = NULL`,
        [contractorId, String(r.ptwCode), s(r.ptwStatus), s(r.dateStart), s(r.dateUpto), s(r.dateIssued), s(r.permitApplicant), s(r.permitController), s(r.permitAuthority), JSON.stringify(r), batchId],
      );
    }
  } else if (key === 'end_to_end_wr_to_invoice') {
    const groups = new Map<string, TypedRow[]>();
    for (const r of rows) {
      const k = String(r.wrCode ?? '');
      if (k) (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const join = (list: TypedRow[], f: string) => {
      const set = [...new Set(list.map((x) => x[f]).filter((v) => v !== null && v !== undefined && v !== '').map(String))].sort();
      return set.length ? set.join('; ') : null;
    };
    const firstDate = (list: TypedRow[], f: string) => list.map((x) => s(x[f])).filter(Boolean).sort()[0] ?? null;
    for (const [code, list] of groups) {
      await c.query(
        `INSERT INTO money_trail (contractor_id, work_request_id, wr_code, demand_note, pr_no, pr_date, pr_status, po_no, po_date, po_status,
            wcc_no, wcc_date, wcc_status, invoice_no, invoice_status, raw, last_import_id)
         VALUES ($1, (SELECT id FROM work_request WHERE contractor_id = $1 AND wr_code = $2), $2, $3, $4, ${sqlDateIn(5)}, $6, $7, ${sqlDateIn(8)}, $9,
                 $10, ${sqlDateIn(11)}, $12, $13, $14, $15, $16)
         ON CONFLICT (contractor_id, wr_code) DO UPDATE SET
            work_request_id = COALESCE(EXCLUDED.work_request_id, money_trail.work_request_id),
            demand_note = EXCLUDED.demand_note, pr_no = EXCLUDED.pr_no, pr_date = EXCLUDED.pr_date, pr_status = EXCLUDED.pr_status,
            po_no = EXCLUDED.po_no, po_date = EXCLUDED.po_date, po_status = EXCLUDED.po_status, wcc_no = EXCLUDED.wcc_no,
            wcc_date = EXCLUDED.wcc_date, wcc_status = EXCLUDED.wcc_status, invoice_no = EXCLUDED.invoice_no,
            invoice_status = EXCLUDED.invoice_status, raw = EXCLUDED.raw, last_import_id = EXCLUDED.last_import_id, last_seen_at = now()`,
        [
          contractorId, code, join(list, 'demandNote'), join(list, 'prNumber'), firstDate(list, 'prDate'), join(list, 'prStatus'),
          join(list, 'poNumber'), firstDate(list, 'poDate'), join(list, 'poStatus'), join(list, 'wccNumber'), firstDate(list, 'wccCompletionDate'),
          join(list, 'wccStatus'), join(list, 'invoiceNumber'), join(list, 'invoiceStatus'),
          JSON.stringify({ lines: list.length, totalCostEstimated: list.reduce((a, x) => a + (n(x.costEstimated) ?? 0), 0), totalCostActual: list.reduce((a, x) => a + (n(x.costActual) ?? 0), 0) }),
          batchId,
        ],
      );
    }
  } else if (key === 'edit_update_wrs') {
    for (const r of rows) {
      await c.query(
        `UPDATE work_request SET progress_pct = COALESCE($3, progress_pct), date_to_perform = COALESCE(${sqlDateIn(4)}, date_to_perform),
            closure_comments = $5, ptw_code = COALESCE($6, ptw_code), ptw_status = COALESCE($7, ptw_status),
            raw = raw || jsonb_build_object('edit_update_wrs', $8::jsonb), updated_at = now()
          WHERE contractor_id = $1 AND wr_code = $2`,
        [contractorId, String(r.wrCode), n(r.progress), s(r.dateToPerform), s(r.wrClosureComments), s(r.ptwId), s(r.ptwStatus), JSON.stringify(r)],
      );
    }
  } else if (key === 'issue_wr') {
    for (const r of rows) {
      await c.query(
        `UPDATE work_request SET date_to_perform = COALESCE(${sqlDateIn(3)}, date_to_perform), ptw_code = COALESCE($4, ptw_code),
            ptw_status = COALESCE($5, ptw_status), raw = raw || jsonb_build_object('issue_wr', $6::jsonb), updated_at = now()
          WHERE contractor_id = $1 AND wr_code = $2`,
        [contractorId, String(r.wrCode), s(r.dateToPerform), s(r.permitToWorkCode), s(r.permitToWorkStatus), JSON.stringify(r)],
      );
    }
  } else if (key === 'estimate_and_schedule') {
    for (const r of rows) {
      const withRfe = r.withRfe === null || r.withRfe === undefined ? null : /^(y|yes|true|1)$/i.test(String(r.withRfe));
      await c.query(
        `UPDATE work_request SET with_rfe = COALESCE($3, with_rfe), ptw_status = COALESCE($4, ptw_status),
            raw = raw || jsonb_build_object('estimate_and_schedule', $5::jsonb), updated_at = now()
          WHERE contractor_id = $1 AND wr_code = $2`,
        [contractorId, String(r.wrCode), withRfe, s(r.ptwStatus), JSON.stringify(r)],
      );
    }
  }
  // boq_details: snapshot only.
  return created;
}

// ───────────────────────────── events ─────────────────────────────

export interface Note {
  event: string;
  recipients: string[];
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  workRequestId?: string | null;
  channels?: ('in_app' | 'email' | 'push' | 'whatsapp')[];
}

interface WrRef {
  id: string;
  owner_id: string | null;
  work_team_code: string | null;
  building_name: string | null;
}

async function writeEvents(
  c: PoolClient,
  contractorId: string,
  key: ListKey,
  events: MirrorEvent[],
  batchId: string,
  created: Set<string>,
  firstLoad: boolean,
): Promise<{ counts: { new: number; changed: number; gone: number; events: number }; notes: Note[] }> {
  const counts = { new: 0, changed: 0, gone: 0, events: 0 };
  const notes: Note[] = [];
  const isMaster = MASTER_LISTS.includes(key);

  // WR refs for every key referenced by WR-keyed events.
  const codes = [...new Set(events.filter((e) => !e.type.startsWith('ptw.')).map((e) => e.key))];
  const refs = new Map<string, WrRef>();
  if (codes.length) {
    const r = await c.query<WrRef & { wr_code: string }>(
      `SELECT w.id, w.wr_code, i.owner_id, w.work_team_code, w.building_name FROM work_request w
         LEFT JOIN wr_internal i ON i.work_request_id = w.id WHERE w.contractor_id = $1 AND w.wr_code = ANY($2::text[])`,
      [contractorId, codes],
    );
    for (const x of r.rows) refs.set(x.wr_code, x);
  }
  const purchasing = async () =>
    (await c.query<{ id: string }>(`SELECT id FROM app_user WHERE contractor_id = $1 AND role = 'purchasing' AND status = 'active'`, [contractorId])).rows.map((x) => x.id);
  const supervisorsByTeam = new Map<string, string[]>();
  const zoneSupervisors = async (team: string | null) => {
    const t = String(team ?? '').toLowerCase();
    if (!t) return [];
    if (!supervisorsByTeam.has(t)) {
      const r = await c.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM app_user u JOIN user_work_team ut ON ut.user_id = u.id JOIN work_team wt ON wt.id = ut.work_team_id
          WHERE u.contractor_id = $1 AND u.role = 'supervisor' AND u.status = 'active' AND lower(wt.code) = $2`,
        [contractorId, t],
      );
      supervisorsByTeam.set(t, r.rows.map((x) => x.id));
    }
    return supervisorsByTeam.get(t)!;
  };

  for (const e of events) {
    let type: string = e.type;
    const ref = e.type.startsWith('ptw.') ? undefined : refs.get(e.key);
    if (type === 'wr.gone' && !isMaster) type = 'wr.left_list';
    const payload: Record<string, unknown> = { listKey: key, key: e.key };
    if (e.changes) payload.changes = e.changes;
    if (e.stageField) payload.stageField = e.stageField;
    if (e.from !== undefined) payload.from = e.from;
    if (e.to !== undefined) payload.to = e.to;
    if (e.data) payload.data = e.data;

    if (e.type.startsWith('ptw.')) {
      // A permit event goes on the timeline of every WR linked to the permit (or stands alone).
      const linked = await c.query<{ id: string }>('SELECT id FROM work_request WHERE contractor_id = $1 AND ptw_code = $2', [contractorId, e.key]);
      const targets = linked.rows.length ? linked.rows.map((x) => x.id) : [null];
      for (const wrId of targets) {
        await c.query(
          `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, import_batch_id) VALUES ($1,$2,$3,'marafiq',$4,$5)`,
          [contractorId, wrId, type, JSON.stringify(payload), batchId],
        );
        counts.events++;
      }
      if (e.type === 'ptw.changed') counts.changed++;
      continue;
    }

    await c.query(
      `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, import_batch_id) VALUES ($1,$2,$3,'marafiq',$4,$5)`,
      [contractorId, ref?.id ?? null, type, JSON.stringify(payload), batchId],
    );
    counts.events++;

    if (type === 'wr.seen') {
      counts.new++;
      const stage = (e.data?.status as string | null) ?? null;
      if (ref && stage) {
        await c.query(
          `INSERT INTO wr_stage_history (contractor_id, work_request_id, source, from_stage, to_stage, import_batch_id) VALUES ($1,$2,'marafiq',NULL,$3,$4)`,
          [contractorId, ref.id, stage, batchId],
        );
      }
      if (ref && created.has(e.key) && isMaster && !firstLoad) {
        const sup = await zoneSupervisors(ref.work_team_code);
        if (sup.length) {
          notes.push({
            event: 'wr.new', recipients: sup, title: `New WR ${e.key} in ${ref.work_team_code}`,
            body: ref.building_name ? `Building: ${ref.building_name}` : null, link: `/wr/${e.key}`, entityType: 'work_request', entityId: e.key,
            workRequestId: ref.id, channels: ['in_app', 'push'],
          });
        }
      }
    } else if (type === 'wr.stage_changed') {
      counts.changed++;
      if (ref) {
        await c.query(
          `INSERT INTO wr_stage_history (contractor_id, work_request_id, source, from_stage, to_stage, import_batch_id) VALUES ($1,$2,'marafiq',$3,$4,$5)`,
          [contractorId, ref.id, e.from === null || e.from === undefined ? null : String(e.from), String(e.to ?? ''), batchId],
        );
        if (ref.owner_id && e.stageField === 'wrStatus' && isCompleted(e.to)) {
          notes.push({
            event: 'wr.closed', recipients: [ref.owner_id], title: `WR ${e.key} is now ${String(e.to)}`, link: `/wr/${e.key}`,
            entityType: 'work_request', entityId: e.key, workRequestId: ref.id, channels: ['in_app', 'push'],
          });
        }
      }
    } else if (type === 'wr.changed') {
      counts.changed++;
    } else if (type === 'wr.gone') {
      counts.gone++;
      if (ref) {
        await c.query(`UPDATE work_request SET gone_at = now(), updated_at = now() WHERE id = $1 AND gone_at IS NULL`, [ref.id]);
        await c.query(
          `INSERT INTO wr_stage_history (contractor_id, work_request_id, source, from_stage, to_stage, import_batch_id) VALUES ($1,$2,'marafiq',NULL,'gone',$3)`,
          [contractorId, ref.id, batchId],
        );
        if (ref.owner_id) {
          notes.push({
            event: 'wr.gone', recipients: [ref.owner_id], title: `WR ${e.key} left the open list (closed or cancelled by QF)`, link: `/wr/${e.key}`,
            entityType: 'work_request', entityId: e.key, workRequestId: ref.id, channels: ['in_app', 'push'],
          });
        }
      }
    } else if (type === 'rfe.returned') {
      counts.changed++;
      if (ref?.owner_id) {
        notes.push({
          event: 'wr.returned', recipients: [ref.owner_id], title: `WR ${e.key} returned by QF`, body: `QF stage: ${String(e.to ?? '')}`,
          link: `/wr/${e.key}`, entityType: 'work_request', entityId: e.key, workRequestId: ref.id, channels: ['in_app', 'push', 'email'],
        });
      }
    } else if (type === 'rfe.approved') {
      counts.changed++;
      const rec = [...new Set([...(ref?.owner_id ? [ref.owner_id] : []), ...(await purchasing())])];
      if (rec.length) {
        notes.push({
          event: 'rfe.approved', recipients: rec, title: `RFE approved for WR ${e.key} - LPO to be raised`, body: `Approved on ${String(e.to ?? '')}`,
          link: `/wr/${e.key}`, entityType: 'work_request', entityId: e.key, workRequestId: ref?.id ?? null, channels: ['in_app', 'push', 'email'],
        });
      }
    } else if (type === 'rfe.comment_received') {
      counts.new++;
      if (ref?.owner_id) {
        notes.push({
          event: 'rfe.comment', recipients: [ref.owner_id], title: `QF comment on WR ${e.key}`, body: (e.data?.comments as string | null) ?? null,
          link: `/wr/${e.key}`, entityType: 'work_request', entityId: e.key, workRequestId: ref.id, channels: ['in_app', 'push', 'email'],
        });
      }
    } else if (type === 'money.changed') {
      counts.changed++;
    }
  }
  return { counts, notes };
}
