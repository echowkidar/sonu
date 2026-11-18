/**
 * LPO (Local Purchase Order): once QF has approved the RFE of a work request and releases the LPO, the procurement team
 * enters it here BY HAND (there is no Marafiq import for it): number, issue date, vendor, approved amount and the document.
 * The LPO is linked to its work request (and so to its RFE) and, optionally, to one of that work request's material requests.
 * Nothing is ever deleted: a cancelled LPO stays as a row, and every change goes to lpo_history.
 * SONU only records this; nothing here ever writes to Marafiq.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isCompleted } from '@sonu/core';
import { auditFromRequest } from '../audit.js';
import { requireRole } from '../auth/guards.js';
import type { Role } from '../auth/roles.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { notify } from '../notifications/index.js';
import { scopeOf, scopeSql, seesMoney, sqlDateOut, todayFor, type Scope } from './context.js';
import { fileKind, readUploadForm, removeUploads, safeName } from './material.js';
import { findWr, sonuEvent } from './workRequests.js';

export const LPO_RFE_WARNING = 'RFE not approved yet in the imported Marafiq data';
const MAX_DOCS = 5;

/** Who may enter / change an LPO. */
const PROC_ROLES: readonly Role[] = ['purchasing', 'coordinator', 'manager', 'contractor_admin'];
/** Who may look (supervisors and foremen only for work requests in their scope). */
const VIEW_ROLES: readonly Role[] = ['supervisor', 'foreman', ...PROC_ROLES];

interface LpoRow {
  id: string;
  contractor_id: string;
  work_request_id: string;
  wr_code: string;
  material_request_id: string | null;
  lpo_no: string;
  issue_date: string;
  vendor_name: string;
  vendor_contact: string | null;
  approved_amount: number;
  rfe_amount_snapshot: number | null;
  rfe_approved_on: string | null;
  remarks: string | null;
  status: 'released' | 'cancelled';
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date;
  cancelled_reason: string | null;
  mr_no: number | null;
}

const LPO_SELECT = `
  SELECT l.*, uc.full_name AS created_by_name, m.mr_no
    FROM lpo l
    LEFT JOIN app_user uc ON uc.id = l.created_by
    LEFT JOIN material_request m ON m.id = l.material_request_id`;

const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'That date is not valid.');
const amount = z.number('Enter the approved amount.').min(0, 'The amount cannot be negative.').max(9999999999);

const createBody = z
  .object({
    wrCode: z.string().trim().min(1, 'Choose the work request.').max(40),
    lpoNo: z.string().trim().min(1, 'Enter the LPO number.').max(100),
    issueDate: isoDate,
    vendorName: z.string().trim().min(1, 'Enter the vendor name.').max(200),
    vendorContact: z.string().trim().max(300).nullish(),
    approvedAmount: amount,
    materialRequestId: z.string().uuid().nullish(),
    remarks: z.string().trim().max(2000).nullish(),
  })
  .strict();
const patchBody = z
  .object({
    lpoNo: z.string().trim().min(1, 'Enter the LPO number.').max(100),
    issueDate: isoDate,
    vendorName: z.string().trim().min(1, 'Enter the vendor name.').max(200),
    vendorContact: z.string().trim().max(300).nullable(),
    approvedAmount: amount,
    materialRequestId: z.string().uuid().nullable(),
    remarks: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .strict();
const idParam = z.object({ id: z.string().uuid() });

// ───────────────────────────── views ─────────────────────────────

interface DocView {
  id: string;
  fileName: string;
  mime: string;
  createdAt: Date;
  uploadedByName: string | null;
}

async function docsFor(db: Queryable, contractorId: string, lpoIds: string[]): Promise<Map<string, DocView[]>> {
  const map = new Map<string, DocView[]>();
  if (!lpoIds.length) return map;
  const r = await db.query<{ id: string; owner_id: string; file_name: string; mime: string; created_at: Date; uploaded_by_name: string | null }>(
    `SELECT t.id, t.owner_id, t.file_name, t.mime, t.created_at, u.full_name AS uploaded_by_name
       FROM attachment t LEFT JOIN app_user u ON u.id = t.uploaded_by
      WHERE t.contractor_id = $1 AND t.owner_type = 'lpo_doc' AND t.owner_id = ANY($2::uuid[]) ORDER BY t.created_at`,
    [contractorId, lpoIds],
  );
  for (const d of r.rows) {
    const list = map.get(d.owner_id) ?? [];
    list.push({ id: d.id, fileName: d.file_name, mime: d.mime, createdAt: d.created_at, uploadedByName: d.uploaded_by_name });
    map.set(d.owner_id, list);
  }
  return map;
}

function lpoView(l: LpoRow, user: Scope['user'], documents: DocView[], canEdit: boolean) {
  const money = seesMoney(user);
  return {
    id: l.id,
    wrCode: l.wr_code,
    materialRequestId: l.material_request_id,
    mrCode: l.mr_no === null ? null : `MR-${l.mr_no}`,
    lpoNo: l.lpo_no,
    issueDate: l.issue_date,
    vendorName: l.vendor_name,
    vendorContact: l.vendor_contact,
    approvedAmount: money ? l.approved_amount : null,
    rfeAmountSnapshot: money ? l.rfe_amount_snapshot : null,
    rfeApprovedOn: l.rfe_approved_on,
    remarks: l.remarks,
    status: l.status,
    cancelledReason: l.cancelled_reason,
    createdByName: l.created_by_name,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    documents,
    can: { edit: canEdit && l.status === 'released' },
  };
}

async function historyFor(db: Queryable, lpoId: string) {
  const r = await db.query<{ id: string; action: string; changes: unknown; at: Date; user_name: string | null }>(
    `SELECT h.id, h.action, h.changes, h.at, u.full_name AS user_name FROM lpo_history h LEFT JOIN app_user u ON u.id = h.user_id WHERE h.lpo_id = $1 ORDER BY h.at, h.id`,
    [lpoId],
  );
  return r.rows.map((h) => ({ id: h.id, action: h.action, changes: h.changes, at: h.at, userName: h.user_name }));
}

/** Money fields inside history are hidden from roles that do not see money. */
function historyForUser(items: Awaited<ReturnType<typeof historyFor>>, user: Scope['user']) {
  if (seesMoney(user)) return items;
  return items.map((h) => {
    const ch = { ...(h.changes as Record<string, unknown>) };
    delete ch.approvedAmount;
    return { ...h, changes: ch };
  });
}

/** All LPOs of one work request (cancelled too, newest first), for the WR detail and the MR detail. The caller already checked WR visibility. */
export async function lpoListFor(db: Queryable, scope: Scope, wrId: string, opts: { withHistory?: boolean } = {}) {
  if (scope.assignedOnly || !VIEW_ROLES.includes(scope.user.role)) return [];
  const r = await db.query<LpoRow>(`${LPO_SELECT} WHERE l.contractor_id = $1 AND l.work_request_id = $2 ORDER BY l.created_at DESC, l.id`, [scope.contractorId, wrId]);
  const docs = await docsFor(db, scope.contractorId, r.rows.map((x) => x.id));
  const canEdit = PROC_ROLES.includes(scope.user.role);
  const out = [];
  for (const l of r.rows) {
    const v = lpoView(l, scope.user, docs.get(l.id) ?? [], canEdit);
    out.push(opts.withHistory ? { ...v, history: historyForUser(await historyFor(db, l.id), scope.user) } : v);
  }
  return out;
}

/** LPOs linked to one material request. The caller already checked MR visibility. */
export async function lpoForMr(db: Queryable, scope: Scope, mrId: string) {
  if (!VIEW_ROLES.includes(scope.user.role)) return [];
  const r = await db.query<LpoRow>(`${LPO_SELECT} WHERE l.contractor_id = $1 AND l.material_request_id = $2 ORDER BY l.created_at DESC, l.id`, [scope.contractorId, mrId]);
  const docs = await docsFor(db, scope.contractorId, r.rows.map((x) => x.id));
  return r.rows.map((l) => lpoView(l, scope.user, docs.get(l.id) ?? [], false));
}

/** The RFE / LPO story of a work request, built only from what SONU holds (no invented data). */
export async function rfeHistoryFor(db: Queryable, contractorId: string, wr: { id: string; wr_code: string }) {
  type Item = { at: string; kind: string; text: string; source: 'marafiq' | 'sonu'; by: string | null };
  const items: Item[] = [];
  const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
  const rfe = (
    await db.query<{ submitted_on: string | null; approved_on: string | null; pending_with: string | null; bpa_release_ref: string | null; bpa_release_date: string | null }>(
      `SELECT ${sqlDateOut('submitted_on')} AS submitted_on, ${sqlDateOut('approved_on')} AS approved_on, pending_with, bpa_release_ref, ${sqlDateOut('bpa_release_date')} AS bpa_release_date
         FROM rfe_status WHERE contractor_id = $1 AND wr_code = $2`,
      [contractorId, wr.wr_code],
    )
  ).rows[0];
  if (rfe?.submitted_on) items.push({ at: rfe.submitted_on, kind: 'rfe_submitted', text: 'RFE submitted', source: 'marafiq', by: null });
  if (rfe?.approved_on) items.push({ at: rfe.approved_on, kind: 'rfe_approved', text: 'RFE approved', source: 'marafiq', by: null });
  if (rfe?.bpa_release_date) items.push({ at: rfe.bpa_release_date, kind: 'bpa_release', text: `BPA released${rfe.bpa_release_ref ? ` (${rfe.bpa_release_ref})` : ''}`, source: 'marafiq', by: null });
  const comments = await db.query<{ text: string | null; created_by_name: string | null; created_on: string | null }>(
    `SELECT text, created_by_name, ${sqlDateOut('created_on')} AS created_on FROM rfe_comment WHERE contractor_id = $1 AND wr_code = $2 AND created_on IS NOT NULL`,
    [contractorId, wr.wr_code],
  );
  for (const c of comments.rows) items.push({ at: c.created_on!, kind: 'comment', text: c.text ?? '(no text)', source: 'marafiq', by: c.created_by_name });
  const events = await db.query<{ type: string; source: 'marafiq' | 'sonu'; payload: Record<string, unknown> | null; at: Date; user_name: string | null }>(
    `SELECT e.type, e.source, e.payload, e.at, u.full_name AS user_name FROM wr_event e LEFT JOIN app_user u ON u.id = e.user_id
      WHERE e.contractor_id = $1 AND e.work_request_id = $2 AND (e.type LIKE 'rfe.%' OR e.type LIKE 'lpo.%')`,
    [contractorId, wr.id],
  );
  for (const e of events.rows) {
    const note = e.payload && typeof e.payload.note === 'string' ? e.payload.note : null;
    items.push({ at: iso(e.at), kind: e.type, text: note ?? e.type.replace(/[._]/g, ' '), source: e.source, by: e.user_name });
  }
  const stages = await db.query<{ from_stage: string | null; to_stage: string; source: 'marafiq' | 'sonu'; at: Date; user_name: string | null }>(
    `SELECT h.from_stage, h.to_stage, h.source, h.at, u.full_name AS user_name FROM wr_stage_history h LEFT JOIN app_user u ON u.id = h.user_id
      WHERE h.contractor_id = $1 AND h.work_request_id = $2 AND (h.to_stage ILIKE '%rfe%' OR h.from_stage ILIKE '%rfe%')`,
    [contractorId, wr.id],
  );
  for (const s of stages.rows) items.push({ at: iso(s.at), kind: 'stage', text: `${s.from_stage ?? '(new)'} → ${s.to_stage}`, source: s.source, by: s.user_name });
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ───────────────────────────── pending / summary ─────────────────────────────

interface PendingRow {
  wr_code: string;
  wr_status: string | null;
  building_name: string | null;
  description: string | null;
  rfe_amount: number | null;
  approved_on: string;
}

async function pendingRows(db: Queryable, scope: Scope): Promise<PendingRow[]> {
  const params: unknown[] = [scope.contractorId];
  const cond = scopeSql(scope, params);
  const r = await db.query<PendingRow>(
    `SELECT w.wr_code, w.wr_status, w.building_name, w.description, r.rfe_amount, ${sqlDateOut('r.approved_on')} AS approved_on
       FROM work_request w
       JOIN rfe_status r ON r.contractor_id = w.contractor_id AND r.wr_code = w.wr_code
      WHERE w.contractor_id = $1 AND w.gone_at IS NULL AND r.approved_on IS NOT NULL AND ${cond}
        AND NOT EXISTS (SELECT 1 FROM lpo l WHERE l.work_request_id = w.id AND l.status = 'released')
      ORDER BY r.approved_on, w.wr_code`,
    params,
  );
  return r.rows.filter((x) => !isCompleted(x.wr_status));
}

/** Numbers for the procurement dashboard. null when the role has no access. */
export async function lpoSummary(db: Queryable, scope: Scope, tz: string, month: string) {
  if (!VIEW_ROLES.includes(scope.user.role) || scope.assignedOnly) return null;
  const pending = (await pendingRows(db, scope)).length;
  const params: unknown[] = [scope.contractorId, month];
  const cond = scopeSql(scope, params);
  void tz;
  const r = await db.query<{ released: number; month: number }>(
    `SELECT count(*)::int AS released, count(*) FILTER (WHERE to_char(l.issue_date, 'YYYY-MM') = $2)::int AS month
       FROM lpo l JOIN work_request w ON w.id = l.work_request_id WHERE l.contractor_id = $1 AND l.status = 'released' AND ${cond}`,
    params,
  );
  return { pending, releasedThisMonth: r.rows[0]!.month, released: r.rows[0]!.released };
}

// ───────────────────────────── access ─────────────────────────────

async function loadLpo(db: Queryable, scope: Scope, id: string): Promise<LpoRow> {
  if (scope.assignedOnly || !VIEW_ROLES.includes(scope.user.role)) throw notFound('LPO not found.');
  const params: unknown[] = [id, scope.contractorId];
  const cond = scopeSql(scope, params);
  const r = await db.query<LpoRow>(`${LPO_SELECT} JOIN work_request w ON w.id = l.work_request_id WHERE l.id = $1 AND l.contractor_id = $2 AND ${cond}`, params);
  if (!r.rows[0]) throw notFound('LPO not found.');
  return r.rows[0];
}

async function detail(db: Queryable, scope: Scope, id: string) {
  const l = await loadLpo(db, scope, id);
  const docs = await docsFor(db, scope.contractorId, [id]);
  return { ...lpoView(l, scope.user, docs.get(id) ?? [], PROC_ROLES.includes(scope.user.role)), history: historyForUser(await historyFor(db, id), scope.user) };
}

const isUnique = (err: unknown) => (err as { code?: string })?.code === '23505';
const dupMessage = 'This LPO number is already used by another LPO. Cancel that one first, or check the number.';

// ───────────────────────────── routes ─────────────────────────────

export default async function lpoRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireRole(...VIEW_ROLES) };
  const procurers = { preHandler: requireRole(...PROC_ROLES) };

  async function tzOf(contractorId: string) {
    const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [contractorId])).rows[0]?.time_zone ?? 'Asia/Qatar';
    return { tz, today: todayFor(app, tz) };
  }

  async function checkMr(db: Queryable, contractorId: string, mrId: string, wrId: string) {
    const ok = await db.query('SELECT 1 FROM material_request WHERE id = $1 AND contractor_id = $2 AND work_request_id = $3', [mrId, contractorId, wrId]);
    if (!ok.rows.length) throw badRequest('That material request does not belong to this work request.');
  }

  // ───── create ─────
  app.post('/api/lpo', procurers, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const user = scope.user;
    const b = createBody.parse(request.body);
    const w = await findWr(app, scope, b.wrCode);
    if (b.materialRequestId) await checkMr(app.db, scope.contractorId, b.materialRequestId, w.id);
    const rfe = (
      await app.db.query<{ approved_on: string | null; rfe_amount: number | null }>(
        `SELECT ${sqlDateOut('approved_on')} AS approved_on, rfe_amount FROM rfe_status WHERE contractor_id = $1 AND wr_code = $2`,
        [scope.contractorId, w.wr_code],
      )
    ).rows[0];
    const warning = rfe?.approved_on ? null : LPO_RFE_WARNING;
    const mr = b.materialRequestId
      ? (await app.db.query<{ requested_by: string | null; mr_no: number }>('SELECT requested_by, mr_no FROM material_request WHERE id = $1', [b.materialRequestId])).rows[0]
      : undefined;
    let id: string;
    try {
      id = await withTx(app.db, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO lpo (contractor_id, work_request_id, wr_code, material_request_id, lpo_no, issue_date, vendor_name, vendor_contact, approved_amount,
                            rfe_amount_snapshot, rfe_approved_on, remarks, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
          [scope.contractorId, w.id, w.wr_code, b.materialRequestId ?? null, b.lpoNo, b.issueDate, b.vendorName, blank(b.vendorContact), b.approvedAmount,
            rfe?.rfe_amount ?? null, rfe?.approved_on ?? null, blank(b.remarks), user.id],
        );
        const lid = r.rows[0]!.id;
        const changes: Record<string, unknown> = {
          lpoNo: { from: null, to: b.lpoNo }, issueDate: { from: null, to: b.issueDate }, vendorName: { from: null, to: b.vendorName }, approvedAmount: { from: null, to: b.approvedAmount },
        };
        if (warning) changes.warning = warning;
        await c.query(`INSERT INTO lpo_history (contractor_id, lpo_id, action, changes, user_id) VALUES ($1,$2,'created',$3,$4)`, [scope.contractorId, lid, JSON.stringify(changes), user.id]);
        await sonuEvent(c, scope.contractorId, w.id, 'lpo.released', { lpoId: lid, lpoNo: b.lpoNo, note: `LPO ${b.lpoNo} released · ${b.vendorName}` }, user.id);
        await auditFromRequest(request, { action: 'lpo.create', entityType: 'lpo', entityId: lid, summary: `LPO ${b.lpoNo} for WR ${w.wr_code}`, details: { vendorName: b.vendorName, warning } }, c);
        return lid;
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(dupMessage);
      throw err;
    }
    const userIds = [...new Set([w.owner_id, mr?.requested_by].filter((x): x is string => Boolean(x) && x !== user.id))];
    if (userIds.length) {
      await notify(app, {
        contractorId: scope.contractorId, event: 'lpo.released', userIds, title: `LPO ${b.lpoNo} released for WR ${w.wr_code}`,
        body: `${b.vendorName}`, url: `/work-requests/${w.wr_code}`, entityType: 'lpo', entityId: id, workRequestId: w.id, channels: ['in_app', 'push'],
      });
    }
    return reply.status(201).send({ ...(await detail(app.db, scope, id)), warning });
  });

  // ───── lists ─────
  app.get('/api/lpo/pending', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { today } = await tzOf(scope.contractorId);
    const money = seesMoney(scope.user);
    const t = Date.parse(`${today}T00:00:00Z`);
    const rows = await pendingRows(app.db, scope);
    return {
      today,
      items: rows.map((x) => ({
        wrCode: x.wr_code, buildingName: x.building_name, description: x.description, wrStatus: x.wr_status, rfeAmount: money ? x.rfe_amount : null,
        approvedOn: x.approved_on, daysSinceApproval: Math.max(0, Math.round((t - Date.parse(`${x.approved_on}T00:00:00Z`)) / 86400000)),
      })),
    };
  });

  app.get('/api/lpo', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const q = z.object({ status: z.enum(['released', 'cancelled']).optional(), q: z.string().trim().max(100).optional() }).parse(request.query);
    const params: unknown[] = [scope.contractorId];
    const where = ['l.contractor_id = $1', scopeSql(scope, params)];
    if (q.status) {
      params.push(q.status);
      where.push(`l.status = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      where.push(`(l.lpo_no ILIKE $${params.length} OR l.vendor_name ILIKE $${params.length} OR l.wr_code ILIKE $${params.length})`);
    }
    const r = await app.db.query<LpoRow>(`${LPO_SELECT} JOIN work_request w ON w.id = l.work_request_id WHERE ${where.join(' AND ')} ORDER BY l.issue_date DESC, l.created_at DESC LIMIT 500`, params);
    const docs = await docsFor(app.db, scope.contractorId, r.rows.map((x) => x.id));
    const canEdit = PROC_ROLES.includes(scope.user.role);
    return { items: r.rows.map((l) => lpoView(l, scope.user, docs.get(l.id) ?? [], canEdit)) };
  });

  app.get('/api/lpo/:id', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    return detail(app.db, scope, id);
  });

  // ───── update ─────
  app.patch('/api/lpo/:id', procurers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = patchBody.parse(request.body);
    const cur = await loadLpo(app.db, scope, id);
    if (cur.status === 'cancelled') throw conflict('This LPO is cancelled; it can no longer be changed.');
    const next: Record<string, { col: string; from: unknown; to: unknown }> = {};
    const set = (key: string, col: string, from: unknown, to: unknown) => {
      if (to !== undefined && to !== from) next[key] = { col, from, to };
    };
    set('lpoNo', 'lpo_no', cur.lpo_no, b.lpoNo);
    set('issueDate', 'issue_date', cur.issue_date, b.issueDate);
    set('vendorName', 'vendor_name', cur.vendor_name, b.vendorName);
    set('vendorContact', 'vendor_contact', cur.vendor_contact, b.vendorContact === undefined ? undefined : blank(b.vendorContact));
    set('approvedAmount', 'approved_amount', cur.approved_amount, b.approvedAmount);
    set('materialRequestId', 'material_request_id', cur.material_request_id, b.materialRequestId);
    set('remarks', 'remarks', cur.remarks, b.remarks === undefined ? undefined : blank(b.remarks));
    if (!Object.keys(next).length) throw badRequest('Nothing to change.');
    if (b.materialRequestId) await checkMr(app.db, scope.contractorId, b.materialRequestId, cur.work_request_id);
    try {
      await withTx(app.db, async (c) => {
        const params: unknown[] = [id, scope.user.id];
        const sets = Object.values(next).map((n) => {
          params.push(n.to);
          return `${n.col} = $${params.length}`;
        });
        await c.query(`UPDATE lpo SET ${sets.join(', ')}, updated_by = $2, updated_at = now() WHERE id = $1`, params);
        const changes = Object.fromEntries(Object.entries(next).map(([k, n]) => [k, { from: n.from, to: n.to }]));
        await c.query(`INSERT INTO lpo_history (contractor_id, lpo_id, action, changes, user_id) VALUES ($1,$2,'updated',$3,$4)`, [scope.contractorId, id, JSON.stringify(changes), scope.user.id]);
        await auditFromRequest(request, { action: 'lpo.update', entityType: 'lpo', entityId: id, summary: `LPO ${b.lpoNo ?? cur.lpo_no}`, details: { fields: Object.keys(next) } }, c);
      });
    } catch (err) {
      if (isUnique(err)) throw conflict(dupMessage);
      throw err;
    }
    return detail(app.db, scope, id);
  });

  // ───── cancel ─────
  app.post('/api/lpo/:id/cancel', procurers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = z.object({ reason: z.string().trim().min(1, 'Say why the LPO is cancelled.').max(1000) }).strict().parse(request.body);
    const cur = await loadLpo(app.db, scope, id);
    await withTx(app.db, async (c) => {
      const r = await c.query(`UPDATE lpo SET status = 'cancelled', cancelled_reason = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND status = 'released'`, [id, b.reason, scope.user.id]);
      if (!r.rowCount) throw conflict('This LPO is already cancelled.');
      await c.query(`INSERT INTO lpo_history (contractor_id, lpo_id, action, changes, user_id) VALUES ($1,$2,'cancelled',$3,$4)`, [scope.contractorId, id, JSON.stringify({ reason: b.reason }), scope.user.id]);
      await sonuEvent(c, scope.contractorId, cur.work_request_id, 'lpo.cancelled', { lpoId: id, lpoNo: cur.lpo_no, note: `LPO ${cur.lpo_no} cancelled · ${b.reason}` }, scope.user.id);
      await auditFromRequest(request, { action: 'lpo.cancel', entityType: 'lpo', entityId: id, summary: `LPO ${cur.lpo_no}`, details: { reason: b.reason } }, c);
    });
    return detail(app.db, scope, id);
  });

  // ───── documents ─────
  app.post('/api/lpo/:id/documents', procurers, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const cur = await loadLpo(app.db, scope, id);
    if (cur.status === 'cancelled') throw conflict('This LPO is cancelled; documents can no longer be added.');
    const { raw } = await readUploadForm(app, request);
    if (!raw.length) throw badRequest('Choose at least one file.');
    const have = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM attachment WHERE contractor_id = $1 AND owner_type = 'lpo_doc' AND owner_id = $2`, [scope.contractorId, id])).rows[0]!.n;
    if (have + raw.length > MAX_DOCS) throw badRequest(`At most ${MAX_DOCS} documents per LPO.`);
    const saved: { rel: string; mime: string; size: number; sha256: string; name: string }[] = [];
    try {
      const dir = path.join(app.config.uploadDir, scope.contractorId);
      for (const f of raw) {
        const t = fileKind(f.buf, true);
        if (!t) throw new AppError(415, 'unsupported_file', 'Only JPEG, PNG, WebP or PDF files can be uploaded.');
        await fsp.mkdir(dir, { recursive: true });
        const fid = crypto.randomUUID();
        const rel = `${scope.contractorId}/${fid}.${t.ext}`;
        await fsp.writeFile(path.join(app.config.uploadDir, rel), f.buf, { flag: 'wx' });
        saved.push({ rel, mime: t.mime, size: f.buf.length, sha256: crypto.createHash('sha256').update(f.buf).digest('hex'), name: safeName(f.name, t.ext, `lpo-${fid.slice(0, 8)}`) });
      }
      await withTx(app.db, async (c) => {
        for (const p of saved) {
          await c.query(
            `INSERT INTO attachment (contractor_id, owner_type, owner_id, work_request_id, file_path, file_name, mime, size_bytes, sha256, uploaded_by, doc_kind)
             VALUES ($1,'lpo_doc',$2,$3,$4,$5,$6,$7,$8,$9,'lpo')`,
            [scope.contractorId, id, cur.work_request_id, p.rel, p.name, p.mime, p.size, p.sha256, scope.user.id],
          );
        }
        await c.query('UPDATE lpo SET updated_at = now(), updated_by = $2 WHERE id = $1', [id, scope.user.id]);
        await c.query(`INSERT INTO lpo_history (contractor_id, lpo_id, action, changes, user_id) VALUES ($1,$2,'document_added',$3,$4)`, [scope.contractorId, id, JSON.stringify({ files: saved.map((s) => s.name) }), scope.user.id]);
        await auditFromRequest(request, { action: 'lpo.attach', entityType: 'lpo', entityId: id, summary: `LPO ${cur.lpo_no}`, details: { files: saved.length } }, c);
      });
    } catch (err) {
      await removeUploads(app, saved);
      throw err;
    }
    return reply.status(201).send(await detail(app.db, scope, id));
  });

  app.delete('/api/lpo/:id/documents/:attId', procurers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id, attId } = z.object({ id: z.string().uuid(), attId: z.string().uuid() }).parse(request.params);
    const cur = await loadLpo(app.db, scope, id);
    if (cur.status === 'cancelled') throw conflict('This LPO is cancelled; documents can no longer be removed.');
    const a = (
      await app.db.query<{ file_path: string; file_name: string }>(`SELECT file_path, file_name FROM attachment WHERE id = $1 AND contractor_id = $2 AND owner_type = 'lpo_doc' AND owner_id = $3`, [attId, scope.contractorId, id])
    ).rows[0];
    if (!a) throw notFound('File not found.');
    await withTx(app.db, async (c) => {
      await c.query('DELETE FROM attachment WHERE id = $1', [attId]);
      await c.query('UPDATE lpo SET updated_at = now(), updated_by = $2 WHERE id = $1', [id, scope.user.id]);
      await c.query(`INSERT INTO lpo_history (contractor_id, lpo_id, action, changes, user_id) VALUES ($1,$2,'document_removed',$3,$4)`, [scope.contractorId, id, JSON.stringify({ file: a.file_name }), scope.user.id]);
      await auditFromRequest(request, { action: 'lpo.detach', entityType: 'lpo', entityId: id, summary: `LPO ${cur.lpo_no}`, details: { attachmentId: attId } }, c);
    });
    const root = path.resolve(app.config.uploadDir);
    const full = path.resolve(root, a.file_path);
    if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    return { ok: true };
  });
}
