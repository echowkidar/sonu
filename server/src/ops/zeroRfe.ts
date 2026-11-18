/**
 * "0 RFE": a supervisor decides after the site survey that the material costs under QR 100, so it is bought locally with
 * petty cash and no RFE (estimate) goes to QF. SONU records the conversion, each local purchase with its receipt photos,
 * and the monthly report. Nothing here ever writes to Marafiq.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isCompleted } from '@sonu/core';
import { auditFromRequest } from '../audit.js';
import { requireRole } from '../auth/guards.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { effectiveStage, inTeams, loadComputeContext, scopeOf, seesMoney, todayFor, computedFor, type ComputeContext, type Scope, type WrRow } from './context.js';
import { imageType, MAX_PHOTO_BYTES } from './jobs.js';
import { ALL_SEEING, ensureInternal, findWr, loadWrs, sonuEvent, wrView } from './workRequests.js';

export const ZERO_RFE_LIMIT = 100;
export const MAX_RECEIPTS = 3;
const CONTRACTOR_STATUS_ON_CONVERT = 'Work In Progress - TDGI';
const STAGE_6_LABEL = '6. In Progress';

export interface PurchaseView {
  id: string;
  item: string;
  amount: number | null;
  purchasedOn: string;
  pettyCashRef: string | null;
  createdByName: string | null;
  createdById: string | null;
  createdAt: Date;
  attachments: { id: string; fileName: string; mime: string }[];
}

/** Local purchases of the given work requests (money is null for roles that do not see money). */
export async function purchasesFor(db: Queryable, contractorId: string, wrIds: string[], money: boolean): Promise<Map<string, PurchaseView[]>> {
  const out = new Map<string, PurchaseView[]>();
  if (!wrIds.length) return out;
  const r = await db.query<{
    id: string; work_request_id: string; item: string; amount: number; purchased_on: string; petty_cash_ref: string | null;
    created_by: string | null; created_by_name: string | null; created_at: Date;
    attachments: { id: string; fileName: string; mime: string }[];
  }>(
    `SELECT p.id, p.work_request_id, p.item, p.amount, p.purchased_on, p.petty_cash_ref, p.created_by, u.full_name AS created_by_name, p.created_at,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'fileName', t.file_name, 'mime', t.mime) ORDER BY t.created_at)
                        FROM attachment t WHERE t.contractor_id = p.contractor_id AND t.owner_type = 'local_purchase' AND t.owner_id = p.id), '[]') AS attachments
       FROM local_purchase p LEFT JOIN app_user u ON u.id = p.created_by
      WHERE p.contractor_id = $1 AND p.work_request_id = ANY($2::uuid[]) ORDER BY p.purchased_on, p.created_at`,
    [contractorId, wrIds],
  );
  for (const p of r.rows) {
    const list = out.get(p.work_request_id) ?? [];
    list.push({
      id: p.id, item: p.item, amount: money ? p.amount : null, purchasedOn: p.purchased_on, pettyCashRef: p.petty_cash_ref,
      createdByName: p.created_by_name, createdById: p.created_by, createdAt: p.created_at, attachments: p.attachments,
    });
    out.set(p.work_request_id, list);
  }
  return out;
}

export interface ZeroRfeItem {
  wrCode: string;
  buildingName: string | null;
  description: string | null;
  zone: string | null;
  discipline: string | null;
  convertedAt: Date;
  convertedByName: string | null;
  expected: number | null;
  spent: number | null;
  purchases: number;
  receipts: number;
  wrStatus: string | null;
  qfStageLabel: string;
}

export interface ZeroRfeReport {
  month: string;
  totals: { jobs: number; expected: number | null; spent: number | null; withoutReceipt: number };
  items: ZeroRfeItem[];
}

/** Work requests converted to 0 RFE in `month` (YYYY-MM, contractor time zone), within the caller's scope. */
export async function zeroRfeReport(app: FastifyInstance, scope: Scope, ctx: ComputeContext, month: string, keep?: (w: WrRow) => boolean): Promise<ZeroRfeReport> {
  const money = seesMoney(scope.user);
  const rows = (await loadWrs(app.db, scope, { includeGone: true })).filter((w) => w.zero_rfe_at && w.zero_rfe_month === month && (!keep || keep(w)));
  const ids = rows.map((w) => w.id);
  const agg = new Map<string, { purchases: number; spent: number }>();
  const rec = new Map<string, number>();
  if (ids.length) {
    const a = await app.db.query<{ work_request_id: string; n: number; s: number }>(
      `SELECT work_request_id, count(*)::int AS n, COALESCE(sum(amount), 0) AS s FROM local_purchase
        WHERE contractor_id = $1 AND work_request_id = ANY($2::uuid[]) GROUP BY work_request_id`,
      [scope.contractorId, ids],
    );
    for (const r of a.rows) agg.set(r.work_request_id, { purchases: r.n, spent: r.s });
    const b = await app.db.query<{ work_request_id: string; n: number }>(
      `SELECT p.work_request_id, count(*)::int AS n FROM attachment t JOIN local_purchase p ON p.id = t.owner_id
        WHERE t.contractor_id = $1 AND t.owner_type = 'local_purchase' AND p.work_request_id = ANY($2::uuid[]) GROUP BY p.work_request_id`,
      [scope.contractorId, ids],
    );
    for (const r of b.rows) rec.set(r.work_request_id, r.n);
  }
  const items: ZeroRfeItem[] = rows
    .map((w) => {
      const c = computedFor(w, ctx);
      const g = agg.get(w.id) ?? { purchases: 0, spent: 0 };
      return {
        wrCode: w.wr_code,
        buildingName: w.building_name,
        description: w.description,
        zone: c.zone,
        discipline: c.discipline,
        convertedAt: w.zero_rfe_at!,
        convertedByName: w.zero_rfe_by_name,
        expected: money ? w.zero_rfe_amount : null,
        spent: money ? g.spent : null,
        purchases: g.purchases,
        receipts: rec.get(w.id) ?? 0,
        wrStatus: w.wr_status,
        qfStageLabel: effectiveStage(w) === 6 ? STAGE_6_LABEL : (w.descriptive_status ?? ''),
      };
    })
    .sort((a, b) => a.convertedAt.getTime() - b.convertedAt.getTime() || a.wrCode.localeCompare(b.wrCode));
  const sum = (f: (i: ZeroRfeItem) => number | null) => items.reduce((t, i) => t + (f(i) ?? 0), 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    month,
    totals: {
      jobs: items.length,
      expected: money ? round(sum((i) => i.expected)) : null,
      spent: money ? round(sum((i) => i.spent)) : null,
      withoutReceipt: items.filter((i) => i.receipts === 0).length,
    },
    items,
  };
}

interface Receipt {
  rel: string;
  mime: string;
  size: number;
  sha256: string;
  name: string;
}

async function removeReceipts(app: FastifyInstance, files: Receipt[]) {
  for (const p of files) await fsp.rm(path.join(app.config.uploadDir, p.rel), { force: true }).catch(() => undefined);
}

/** Multipart purchase form: text fields + up to MAX_RECEIPTS images (saved under UPLOAD_DIR/<contractorId>/). */
async function readPurchaseForm(app: FastifyInstance, request: FastifyRequest, contractorId: string): Promise<{ fields: Record<string, string>; receipts: Receipt[] }> {
  if (!request.isMultipart()) throw badRequest('Send the purchase as a form (multipart).');
  const fields: Record<string, string> = {};
  const receipts: Receipt[] = [];
  const dir = path.join(app.config.uploadDir, contractorId);
  const cap = Math.min(MAX_PHOTO_BYTES, app.config.maxUploadBytes);
  try {
    for await (const part of request.parts({ limits: { files: MAX_RECEIPTS + 1, fileSize: cap, fields: 10 } })) {
      if (part.type === 'file') {
        if (receipts.length >= MAX_RECEIPTS) throw badRequest(`At most ${MAX_RECEIPTS} receipt photos per purchase.`);
        const buf = await part.toBuffer();
        if (part.file.truncated) throw new AppError(413, 'too_large', `A photo is larger than ${Math.round(cap / 1048576)} MB.`);
        if (!buf.length) continue;
        const t = imageType(buf);
        if (!t) throw new AppError(415, 'unsupported_file', 'Only JPEG, PNG or WebP photos can be uploaded.');
        await fsp.mkdir(dir, { recursive: true });
        const id = crypto.randomUUID();
        const rel = `${contractorId}/${id}.${t.ext}`;
        await fsp.writeFile(path.join(app.config.uploadDir, rel), buf, { flag: 'wx' });
        receipts.push({ rel, mime: t.mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), name: `receipt-${id.slice(0, 8)}.${t.ext}` });
      } else {
        fields[part.fieldname] = String(part.value ?? '').trim();
      }
    }
  } catch (err) {
    await removeReceipts(app, receipts);
    throw err;
  }
  return { fields, receipts };
}

const purchaseFields = z.object({
  item: z.string().trim().min(1, 'Say what was bought.').max(200),
  amount: z.coerce.number().gt(0, 'The amount must be more than 0.').max(10000),
  purchasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.'),
  pettyCashRef: z.string().trim().max(100).optional(),
});

const codeParam = z.object({ code: z.string().min(1).max(40) });

export default async function zeroRfeRoutes(app: FastifyInstance): Promise<void> {
  const convertRoles = { preHandler: requireRole('supervisor', ...ALL_SEEING) };
  const undoRoles = { preHandler: requireRole(...ALL_SEEING) };
  const purchaseRoles = { preHandler: requireRole('supervisor', 'foreman', 'purchasing', ...ALL_SEEING) };

  // ───── convert ─────
  app.post('/api/work-requests/:code/zero-rfe', convertRoles, async (request) => {
    const scope = await scopeOf(app, request);
    const { code } = codeParam.parse(request.params);
    const body = z
      .object({
        amount: z.number().gt(0, 'The expected amount must be more than 0.').lt(ZERO_RFE_LIMIT, `0 RFE is only for material under QR ${ZERO_RFE_LIMIT}.`),
        note: z.string().trim().max(500).nullish(),
      })
      .strict()
      .parse(request.body);
    const amount = Math.round(body.amount * 100) / 100;
    const w = await findWr(app, scope, code);
    const user = scope.user;
    const allSeeing = (ALL_SEEING as readonly string[]).includes(user.role);
    if (!allSeeing && w.owner_id !== user.id) throw forbidden('Take ownership first.');
    if (w.zero_rfe_at) throw conflict('This work request is already converted to 0 RFE.');
    if (w.gone_at || isCompleted(w.wr_status)) throw badRequest('This work request is already completed.');
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    if (ctx.rfeLookup.get(w.wr_code)?.approvedOn) throw badRequest('The RFE is already approved; 0 RFE no longer applies.');
    await withTx(app.db, async (c) => {
      await ensureInternal(c, scope.contractorId, w.id);
      await c.query(
        `UPDATE wr_internal SET zero_rfe_at = now(), zero_rfe_by = $2, zero_rfe_amount = $3, zero_rfe_note = $4,
                criterion = 2, contractor_status = $5, status_source = 'manual', updated_by = $2, updated_at = now()
          WHERE work_request_id = $1`,
        [w.id, user.id, amount, body.note || null, CONTRACTOR_STATUS_ON_CONVERT],
      );
      await sonuEvent(
        c, scope.contractorId, w.id, 'wr.zero_rfe',
        { amount, note: body.note || null, fromStatus: w.contractor_status, fromCriterion: w.criterion, fromStatusSource: w.status_source },
        user.id,
      );
      await auditFromRequest(request, { action: 'work_request.zero_rfe', entityType: 'work_request', entityId: w.wr_code, details: { amount, note: body.note || null } }, c);
    });
    return wrView(await findWr(app, scope, code), ctx, user);
  });

  // ───── undo ─────
  app.delete('/api/work-requests/:code/zero-rfe', undoRoles, async (request) => {
    const scope = await scopeOf(app, request);
    const { code } = codeParam.parse(request.params);
    const w = await findWr(app, scope, code);
    if (!w.zero_rfe_at) throw conflict('This work request is not converted to 0 RFE.');
    const n = (await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM local_purchase WHERE contractor_id = $1 AND work_request_id = $2', [scope.contractorId, w.id])).rows[0]!.n;
    if (n > 0) throw conflict('Local purchases are already recorded. Delete them first.');
    await withTx(app.db, async (c) => {
      const ev = (await c.query<{ payload: { fromStatus?: string | null; fromCriterion?: number | null; fromStatusSource?: string | null } }>(
        `SELECT payload FROM wr_event WHERE contractor_id = $1 AND work_request_id = $2 AND type = 'wr.zero_rfe' ORDER BY at DESC LIMIT 1`,
        [scope.contractorId, w.id],
      )).rows[0]?.payload ?? {};
      const source = ['manual', 'suggested', 'tracker_import'].includes(ev.fromStatusSource ?? '') ? ev.fromStatusSource! : 'manual';
      await c.query(
        `UPDATE wr_internal SET zero_rfe_at = NULL, zero_rfe_by = NULL, zero_rfe_amount = NULL, zero_rfe_note = NULL,
                criterion = $2, contractor_status = $3, status_source = $4, updated_by = $5, updated_at = now()
          WHERE work_request_id = $1`,
        [w.id, ev.fromCriterion ?? null, ev.fromStatus ?? null, source, scope.user.id],
      );
      await sonuEvent(c, scope.contractorId, w.id, 'wr.zero_rfe_undone', { restoredStatus: ev.fromStatus ?? null, restoredCriterion: ev.fromCriterion ?? null }, scope.user.id);
      await auditFromRequest(request, { action: 'work_request.zero_rfe_undone', entityType: 'work_request', entityId: w.wr_code }, c);
    });
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    return wrView(await findWr(app, scope, code), ctx, scope.user);
  });

  // ───── add purchase ─────
  app.post('/api/work-requests/:code/purchases', purchaseRoles, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { code } = codeParam.parse(request.params);
    const w = await findWr(app, scope, code);
    const user = scope.user;
    if (user.role === 'foreman' && !inTeams(scope, w.work_team_code) && w.owner_id !== user.id) throw forbidden();
    if (!w.zero_rfe_at) throw badRequest('Convert to 0 RFE first.');
    const { fields, receipts } = await readPurchaseForm(app, request, scope.contractorId);
    try {
      const f = purchaseFields.parse({ ...fields, pettyCashRef: fields.pettyCashRef || undefined });
      const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [scope.contractorId])).rows[0]?.time_zone;
      const today = todayFor(app, tz);
      if (Number.isNaN(Date.parse(`${f.purchasedOn}T00:00:00Z`)) || new Date(`${f.purchasedOn}T00:00:00Z`).toISOString().slice(0, 10) !== f.purchasedOn) throw badRequest('That date is not valid.');
      if (f.purchasedOn > today) throw badRequest('The purchase date cannot be in the future.');
      const amount = Math.round(f.amount * 100) / 100;
      const id = await withTx(app.db, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO local_purchase (contractor_id, work_request_id, item, amount, purchased_on, petty_cash_ref, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [scope.contractorId, w.id, f.item, amount, f.purchasedOn, f.pettyCashRef ?? null, user.id],
        );
        const pid = r.rows[0]!.id;
        for (const p of receipts) {
          await c.query(
            `INSERT INTO attachment (contractor_id, owner_type, owner_id, work_request_id, file_path, file_name, mime, size_bytes, sha256, uploaded_by)
             VALUES ($1,'local_purchase',$2,$3,$4,$5,$6,$7,$8,$9)`,
            [scope.contractorId, pid, w.id, p.rel, p.name, p.mime, p.size, p.sha256, user.id],
          );
        }
        await sonuEvent(c, scope.contractorId, w.id, 'wr.local_purchase', { purchaseId: pid, item: f.item, amount, receipts: receipts.length }, user.id);
        await auditFromRequest(request, { action: 'work_request.local_purchase', entityType: 'work_request', entityId: w.wr_code, details: { purchaseId: pid, amount, receipts: receipts.length } }, c);
        return pid;
      });
      const list = (await purchasesFor(app.db, scope.contractorId, [w.id], seesMoney(user))).get(w.id) ?? [];
      return reply.status(201).send(list.find((p) => p.id === id));
    } catch (err) {
      await removeReceipts(app, receipts);
      throw err;
    }
  });

  // ───── delete purchase ─────
  app.delete('/api/work-requests/:code/purchases/:id', purchaseRoles, async (request) => {
    const scope = await scopeOf(app, request);
    const { code, id } = z.object({ code: z.string().min(1).max(40), id: z.string().uuid() }).parse(request.params);
    const w = await findWr(app, scope, code);
    const p = (await app.db.query<{ id: string; created_by: string | null; amount: number; item: string }>(
      'SELECT id, created_by, amount, item FROM local_purchase WHERE id = $1 AND contractor_id = $2 AND work_request_id = $3',
      [id, scope.contractorId, w.id],
    )).rows[0];
    if (!p) throw notFound('Purchase not found.');
    const allSeeing = (ALL_SEEING as readonly string[]).includes(scope.user.role);
    if (!allSeeing && p.created_by !== scope.user.id) throw forbidden('Only the person who added it, or a coordinator, can delete a purchase.');
    const files = await withTx(app.db, async (c) => {
      const a = await c.query<{ file_path: string }>(
        `DELETE FROM attachment WHERE contractor_id = $1 AND owner_type = 'local_purchase' AND owner_id = $2 RETURNING file_path`,
        [scope.contractorId, id],
      );
      await c.query('DELETE FROM local_purchase WHERE id = $1', [id]);
      await sonuEvent(c, scope.contractorId, w.id, 'wr.local_purchase_deleted', { purchaseId: id, item: p.item, amount: p.amount }, scope.user.id);
      await auditFromRequest(request, { action: 'work_request.local_purchase_delete', entityType: 'work_request', entityId: w.wr_code, details: { purchaseId: id, amount: p.amount } }, c);
      return a.rows;
    });
    const root = path.resolve(app.config.uploadDir);
    for (const f of files) {
      const full = path.resolve(root, f.file_path);
      if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    }
    return { ok: true };
  });

  // ───── monthly report ─────
  app.get('/api/zero-rfe', { preHandler: requireRole('supervisor', 'foreman', 'purchasing', ...ALL_SEEING) }, async (request) => {
    const scope = await scopeOf(app, request);
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.').optional() }).parse(request.query);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    return zeroRfeReport(app, scope, ctx, q.month ?? ctx.today.slice(0, 7));
  });
}
