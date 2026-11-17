/** Routes: Marafiq export imports, import history, expected lists, "data as of", tracker loader. */
import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTRACTOR_STATUSES, EXPORTS, LIST_KEYS, parseTrackerWorkbook, type TrackerRow } from '@sonu/core';
import { auditFromRequest } from '../audit.js';
import { currentUser, requireAuth, requireRole, requireTenant } from '../auth/guards.js';
import { withTx } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { runImport } from './imports.js';

const IMPORTERS = ['coordinator', 'manager', 'contractor_admin'] as const;

async function readUpload(request: FastifyRequest): Promise<{ fileName: string; buffer: Buffer; fields: Record<string, string> }> {
  if (!request.isMultipart()) throw badRequest('Send the file as multipart/form-data (field "file").');
  let fileName = '';
  let buffer: Buffer | null = null;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (buffer) throw badRequest('Send one file only.');
      fileName = path.basename(part.filename || 'upload.xlsx').slice(0, 200);
      buffer = await part.toBuffer();
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  if (!buffer || !buffer.length) throw badRequest('No file received.');
  if (!/\.(xlsx|xls)$/i.test(fileName)) throw new AppError(415, 'unsupported_file', 'Upload the export as an .xlsx or .xls file.');
  return { fileName, buffer, fields };
}

export default async function importRoutes(app: FastifyInstance): Promise<void> {
  const importers = { preHandler: requireRole(...IMPORTERS) };

  app.post('/api/imports', importers, async (request, reply) => {
    const contractorId = requireTenant(request);
    const user = currentUser(request);
    const { fileName, buffer, fields } = await readUpload(request);
    const listKey = (fields.listKey || (request.query as Record<string, string | undefined>)?.listKey || '').trim() || undefined;
    const result = await runImport(app, { contractorId, buffer, fileName, listKey, userId: user.id });
    await auditFromRequest(request, {
      action: result.ok ? 'import.marafiq' : 'import.marafiq_failed',
      entityType: 'import_batch',
      entityId: result.batchId ?? null,
      summary: result.ok
        ? `${result.listKey} ${fileName}: ${result.rowsRead} rows, ${result.new} new, ${result.changed} changed, ${result.gone} gone${result.unchanged ? ' (no changes)' : ''}`
        : `${fileName} refused: ${result.error?.message ?? ''}`,
      details: { listKey: result.listKey ?? listKey ?? null, fileName, ok: result.ok, counts: { rowsRead: result.rowsRead, new: result.new, changed: result.changed, gone: result.gone, events: result.events }, error: result.error?.code ?? null },
    });
    if (!result.ok) {
      return reply.status(422).send({
        error: {
          code: result.error!.code === 'MISSING_CAPTION' ? 'missing_caption' : result.error!.code.toLowerCase(),
          message: result.error!.message,
          details: { batchId: result.batchId, listKey: result.listKey ?? null, missingCaptions: result.error!.missingCaptions ?? [], candidates: result.error!.candidates ?? [] },
        },
      });
    }
    return reply.status(201).send(result);
  });

  app.get('/api/imports', importers, async (request) => {
    const contractorId = requireTenant(request);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), listKey: z.string().max(60).optional() }).parse(request.query);
    const params: unknown[] = [contractorId, q.limit];
    let where = 'b.contractor_id = $1';
    if (q.listKey) {
      params.push(q.listKey);
      where += ` AND b.list_key = $${params.length}`;
    }
    const r = await app.db.query(
      `SELECT b.id, b.list_key AS "listKey", b.source, b.file_name AS "fileName", b.status, b.result, b.error,
              b.rows_read AS "rowsRead", b.rows_new AS "new", b.rows_changed AS "changed", b.rows_gone AS "gone", b.events,
              b.warnings, b.created_at AS "createdAt", b.sync_run_id AS "syncRunId",
              CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'fullName', u.full_name) END AS "user"
         FROM import_batch b LEFT JOIN app_user u ON u.id = b.user_id
        WHERE ${where} ORDER BY b.created_at DESC LIMIT $2`,
      params,
    );
    return {
      items: r.rows.map((x: Record<string, unknown>) => ({ ...x, title: EXPORTS[x.listKey as keyof typeof EXPORTS]?.title ?? x.listKey })),
    };
  });

  app.get('/api/imports/expected', importers, async (request) => {
    const contractorId = requireTenant(request);
    const r = await app.db.query<{ list_key: string; at: Date; rows_read: number; id: string }>(
      `SELECT DISTINCT ON (list_key) list_key, created_at AS at, rows_read, id FROM import_batch
        WHERE contractor_id = $1 AND status = 'ok' ORDER BY list_key, created_at DESC`,
      [contractorId],
    );
    const last = new Map(r.rows.map((x) => [x.list_key, x]));
    return {
      items: LIST_KEYS.map((k) => ({
        key: k,
        title: EXPORTS[k].title,
        menuPath: EXPORTS[k].menuPath,
        lastImportAt: last.get(k)?.at ?? null,
        rows: last.get(k)?.rows_read ?? null,
        lastBatchId: last.get(k)?.id ?? null,
      })),
    };
  });

  app.get('/api/data-as-of', { preHandler: requireAuth }, async (request) => {
    const contractorId = requireTenant(request);
    const r = await app.db.query<{ list_key: string; at: Date }>(
      `SELECT list_key, max(created_at) AS at FROM import_batch WHERE contractor_id = $1 AND status = 'ok' GROUP BY list_key`,
      [contractorId],
    );
    const lists: Record<string, Date | null> = Object.fromEntries(LIST_KEYS.map((k) => [k, null]));
    let overall: Date | null = null;
    for (const x of r.rows) {
      lists[x.list_key] = x.at;
      if (!overall || x.at > overall) overall = x.at;
    }
    return { overall, lists };
  });

  // ───── Tracker loader (one-time, re-runnable) ─────

  app.post('/api/imports/tracker', importers, async (request, reply) => {
    const contractorId = requireTenant(request);
    const user = currentUser(request);
    const { fileName, buffer } = await readUpload(request);
    const t = parseTrackerWorkbook(buffer);
    if (!t.ok) throw new AppError(422, 'tracker_invalid', t.error);
    const codes = [...new Set(t.rows.map((r) => r.wrCode))];
    const known = await app.db.query<{ wr_code: string; contractor_status: string | null; fc_remarks: string | null }>(
      `SELECT w.wr_code, i.contractor_status, i.fc_remarks FROM work_request w LEFT JOIN wr_internal i ON i.work_request_id = w.id
        WHERE w.contractor_id = $1 AND w.wr_code = ANY($2::text[])`,
      [contractorId, codes],
    );
    const cur = new Map(known.rows.map((x) => [x.wr_code, x]));
    const matched = t.rows.filter((r) => cur.has(r.wrCode));
    const unknownWrCodes = codes.filter((c) => !cur.has(c));
    const preview = {
      fileName,
      rows: t.rows.length,
      matched: matched.length,
      matchedItems: matched.slice(0, 500).map((r) => ({
        wrCode: r.wrCode, status: r.status, rawStatus: r.rawStatus, fcRemarks: r.fcRemarks || null,
        current: { contractorStatus: cur.get(r.wrCode)?.contractor_status ?? null, fcRemarks: cur.get(r.wrCode)?.fc_remarks ?? null },
      })),
      unknownWrCodes,
      unknownStatuses: t.unknownStatuses.map((u) => ({ ...u, suggested: u.candidates.length === 1 ? u.candidates[0] : null })),
      mappedStatuses: t.mapped,
    };
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ins = await app.db.query<{ id: string }>(
      `INSERT INTO tracker_load (contractor_id, file_name, file_hash, user_id, preview, rows) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [contractorId, fileName, hash, user.id, JSON.stringify(preview), JSON.stringify(t.rows)],
    );
    await auditFromRequest(request, { action: 'import.tracker_preview', entityType: 'tracker_load', entityId: ins.rows[0]!.id, summary: `${fileName}: ${t.rows.length} rows, ${matched.length} matched` });
    return reply.status(201).send({ id: ins.rows[0]!.id, ...preview });
  });

  app.post('/api/imports/tracker/confirm/:id', importers, async (request) => {
    const contractorId = requireTenant(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const names = CONTRACTOR_STATUSES.map((s) => s.name) as string[];
    const body = z
      .object({ statusMap: z.record(z.string(), z.string().refine((v) => names.includes(v), 'Not one of the contractor statuses.')).optional() })
      .parse(request.body ?? {});
    const load = await app.db.query<{ contractor_id: string; status: string; rows: TrackerRow[]; file_name: string }>(
      'SELECT contractor_id, status, rows, file_name FROM tracker_load WHERE id = $1',
      [id],
    );
    const l = load.rows[0];
    if (!l || l.contractor_id !== contractorId) throw notFound('Tracker load not found.');
    if (l.status === 'confirmed') throw conflict('This tracker load was already confirmed. Upload the file again to re-run it.');
    const map = new Map(Object.entries(body.statusMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
    let written = 0;
    await withTx(app.db, async (c) => {
      for (const r of l.rows) {
        const status = r.status ?? (r.rawStatus ? map.get(r.rawStatus.trim().toLowerCase()) ?? null : null);
        const remarks = r.fcRemarks?.trim() ? r.fcRemarks.trim() : null;
        if (!status && !remarks) continue;
        const wr = await c.query<{ id: string; contractor_status: string | null; fc_remarks: string | null }>(
          `SELECT w.id, i.contractor_status, i.fc_remarks FROM work_request w LEFT JOIN wr_internal i ON i.work_request_id = w.id
            WHERE w.contractor_id = $1 AND w.wr_code = $2`,
          [contractorId, r.wrCode],
        );
        const w = wr.rows[0];
        if (!w) continue;
        const newStatus = status ?? w.contractor_status;
        const newRemarks = remarks ?? w.fc_remarks;
        if (newStatus === w.contractor_status && newRemarks === w.fc_remarks) continue;
        await c.query(
          `INSERT INTO wr_internal (contractor_id, work_request_id, contractor_status, fc_remarks, status_source, updated_by)
           VALUES ($1,$2,$3,$4,'tracker_import',$5)
           ON CONFLICT (work_request_id) DO UPDATE SET contractor_status = EXCLUDED.contractor_status, fc_remarks = EXCLUDED.fc_remarks,
             status_source = 'tracker_import', updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [contractorId, w.id, newStatus, newRemarks, user.id],
        );
        await c.query(
          `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, user_id) VALUES ($1,$2,'wr.tracker_loaded','sonu',$3,$4)`,
          [contractorId, w.id, JSON.stringify({ trackerLoadId: id, status: { from: w.contractor_status, to: newStatus }, fcRemarks: { from: w.fc_remarks, to: newRemarks } }), user.id],
        );
        written++;
      }
      await c.query(`UPDATE tracker_load SET status = 'confirmed', confirmed_at = now(), rows_written = $2 WHERE id = $1`, [id, written]);
      await auditFromRequest(request, { action: 'import.tracker_confirm', entityType: 'tracker_load', entityId: id, summary: `${l.file_name}: ${written} work requests updated` }, c);
    });
    return { ok: true, written };
  });
}
