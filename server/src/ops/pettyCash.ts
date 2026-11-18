/**
 * Petty cash reimbursement claims: the contractor's "EXPENSE PETTY CASH REIMBURSEMENT CLAIM" form.
 * A supervisor (or coordinator / manager) prepares it, the contractor admin reviews it, the project manager approves it.
 * QF is not involved. Local purchases of 0 RFE work requests are pulled in as lines (linked, receipts not copied).
 * SONU only records this; nothing here ever writes to Marafiq.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { requireRole } from '../auth/guards.js';
import type { Role } from '../auth/roles.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notifications/index.js';
import { scopeOf, scopeSql, todayFor, type Scope } from './context.js';
import { imageType, MAX_PHOTO_BYTES } from './jobs.js';

export const PC_STATUSES = ['draft', 'submitted', 'returned', 'reviewed', 'approved', 'rejected'] as const;
export type PcStatus = (typeof PC_STATUSES)[number];
export const PC_STATUS_LABELS: Record<PcStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted (waiting for Admin review)',
  returned: 'Returned to preparer',
  reviewed: 'Reviewed (waiting for Project Manager)',
  approved: 'Approved',
  rejected: 'Rejected',
};

const MAX_LINES = 200;
const MAX_LINE_PHOTOS = 6;
const MAX_FILES_PER_UPLOAD = 6;

/** Who prepares a claim (and, for coordinator / manager, may also edit someone else's draft). */
const PREPARE_ROLES: readonly Role[] = ['supervisor', 'coordinator', 'manager'];
const EDIT_ANY_ROLES: readonly string[] = ['coordinator', 'manager'];
/** Who may open claims. Supervisors only their own. Foreman and technician: nobody. */
const VIEW_ROLES: readonly Role[] = ['supervisor', 'coordinator', 'manager', 'contractor_admin', 'purchasing'];
const SEES_ALL: readonly string[] = ['coordinator', 'manager', 'contractor_admin', 'purchasing'];

// Money: claims are about money and every role above sees it (seesMoney only excludes technicians, who have no access),
// so no amount is ever hidden on a claim.

export const pcCode = (no: number) => `PC-${no}`;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ───────────────────────────── rows ─────────────────────────────

interface ClaimRow {
  id: string;
  contractor_id: string;
  ref_no: number;
  project_name: string | null;
  month: string;
  purchase_type: 'materials' | 'services';
  status: PcStatus;
  prepared_by: string | null;
  prepared_by_name: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  total_amount: number;
  approved_amount: number | null;
  created_at: Date;
  updated_at: Date;
}

const CLAIM_SELECT = `
  SELECT c.*, up.full_name AS prepared_by_name, ur.full_name AS reviewed_by_name, ua.full_name AS approved_by_name
    FROM petty_cash_claim c
    LEFT JOIN app_user up ON up.id = c.prepared_by
    LEFT JOIN app_user ur ON ur.id = c.reviewed_by
    LEFT JOIN app_user ua ON ua.id = c.approved_by`;

interface LineRow {
  id: string;
  contractor_id: string;
  claim_id: string;
  line_no: number;
  work_request_id: string | null;
  wr_code: string | null;
  wr_status: string | null;
  local_purchase_id: string | null;
  holds_purchase: boolean;
  grn_code: string | null;
  gl_code: string | null;
  wbs: string | null;
  work_description: string | null;
  location: string | null;
  rfe_approved_amount: number;
  claimable: boolean;
  supplier: string | null;
  material_used: string | null;
  bill_date: string | null;
  bill_no: string | null;
  qty: number;
  unit: string | null;
  unit_cost: number;
  discount: number;
  total_amount: number;
  approved_total: number | null;
}

interface Access {
  isPreparer: boolean;
  canEdit: boolean;
  canReview: boolean;
  canApprove: boolean;
}

function accessOf(user: Scope['user'], c: ClaimRow): Access | null {
  if (!VIEW_ROLES.includes(user.role)) return null;
  const isPreparer = c.prepared_by === user.id;
  if (!SEES_ALL.includes(user.role) && !isPreparer) return null;
  const editable = c.status === 'draft' || c.status === 'returned';
  const prepares = PREPARE_ROLES.includes(user.role) && (isPreparer || EDIT_ANY_ROLES.includes(user.role));
  return {
    isPreparer,
    canEdit: editable && prepares,
    canReview: c.status === 'submitted' && user.role === 'contractor_admin',
    canApprove: c.status === 'reviewed' && user.role === 'manager',
  };
}

async function loadClaim(db: Queryable, scope: Scope, id: string): Promise<{ claim: ClaimRow; access: Access }> {
  const r = await db.query<ClaimRow>(`${CLAIM_SELECT} WHERE c.id = $1 AND c.contractor_id = $2`, [id, scope.contractorId]);
  const claim = r.rows[0];
  if (!claim) throw notFound('Claim not found.');
  const access = accessOf(scope.user, claim);
  if (!access) throw notFound('Claim not found.');
  return { claim, access };
}

function visibleSql(scope: Scope, params: unknown[]): string {
  const u = scope.user;
  if (SEES_ALL.includes(u.role)) return 'TRUE';
  if (u.role === 'supervisor') {
    params.push(u.id);
    return `c.prepared_by = $${params.length}`;
  }
  return 'FALSE';
}

/** Used by GET /api/attachments/:id: bill photos of a line, and the receipts of a local purchase that sits on a visible claim. */
export async function canViewPettyFile(db: Queryable, scope: Scope, ownerType: string, ownerId: string): Promise<boolean> {
  let claimIds: string[] = [];
  if (ownerType === 'petty_cash_line') {
    const r = await db.query<{ claim_id: string }>('SELECT claim_id FROM petty_cash_line WHERE id = $1 AND contractor_id = $2', [ownerId, scope.contractorId]);
    claimIds = r.rows.map((x) => x.claim_id);
  } else if (ownerType === 'local_purchase') {
    const r = await db.query<{ claim_id: string }>('SELECT claim_id FROM petty_cash_line WHERE local_purchase_id = $1 AND contractor_id = $2', [ownerId, scope.contractorId]);
    claimIds = r.rows.map((x) => x.claim_id);
  }
  for (const id of claimIds) {
    try {
      await loadClaim(db, scope, id);
      return true;
    } catch {
      /* not visible */
    }
  }
  return false;
}

/** Tiles of the Procurement dashboard. null when the role has no access to claims. */
export async function pettyCashSummary(db: Queryable, scope: Scope, tz: string, month: string) {
  if (!VIEW_ROLES.includes(scope.user.role)) return null;
  const params: unknown[] = [scope.contractorId, month, tz];
  const vis = visibleSql(scope, params);
  const r = await db.query<{ draft: number; pendingReview: number; pendingApproval: number; approved: number; rejected: number; approvedAmountThisMonth: number }>(
    `SELECT count(*) FILTER (WHERE c.status IN ('draft', 'returned'))::int AS draft,
            count(*) FILTER (WHERE c.status = 'submitted')::int AS "pendingReview",
            count(*) FILTER (WHERE c.status = 'reviewed')::int AS "pendingApproval",
            count(*) FILTER (WHERE c.status = 'approved')::int AS approved,
            count(*) FILTER (WHERE c.status = 'rejected')::int AS rejected,
            COALESCE(sum(c.approved_amount) FILTER (WHERE c.status = 'approved' AND to_char(c.approved_at AT TIME ZONE $3, 'YYYY-MM') = $2), 0) AS "approvedAmountThisMonth"
       FROM petty_cash_claim c WHERE c.contractor_id = $1 AND ${vis}`,
    params,
  );
  const x = r.rows[0]!;
  return {
    draft: x.draft,
    pendingReview: x.pendingReview,
    pendingApproval: x.pendingApproval,
    approved: x.approved,
    rejected: x.rejected,
    approvedAmountThisMonth: round2(Number(x.approvedAmountThisMonth)),
  };
}

// ───────────────────────────── input ─────────────────────────────

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'That date is not valid.');
const text = (n: number) => z.string().trim().max(n).nullish();
const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the month format YYYY-MM.');
const money = (label: string) => z.number(`Enter ${label}.`).min(0, `${label[0]!.toUpperCase()}${label.slice(1)} cannot be negative.`).max(999999999);

const lineShape = {
  wrCode: text(40),
  grnCode: text(100),
  glCode: text(100),
  wbs: text(100),
  workDescription: text(500),
  location: text(200),
  rfeApprovedAmount: money('the RFE approved amount').optional(),
  claimable: z.boolean().optional(),
  supplier: text(200),
  materialUsed: text(300),
  billDate: isoDate.nullish(),
  billNo: text(100),
  qty: z.number('Enter a quantity.').gt(0, 'The quantity must be more than 0.').max(999999999),
  unit: text(30),
  unitCost: money('the unit cost'),
  discount: money('the discount'),
};
const lineCreate = z.object({ ...lineShape, unitCost: lineShape.unitCost.optional(), discount: lineShape.discount.optional() }).strict();
const linePatch = z.object(lineShape).partial().strict();
type LineInput = z.infer<typeof lineCreate>;

const headerShape = { projectName: text(200), month: month.optional(), purchaseType: z.enum(['materials', 'services']).optional() };
const createBody = z.object({ ...headerShape, lines: z.array(lineCreate).max(MAX_LINES).optional() }).strict();
const patchBody = z.object(headerShape).strict();

interface LineValues {
  work_request_id: string | null;
  wr_code: string | null;
  wr_status: string | null;
  grn_code: string | null;
  gl_code: string | null;
  wbs: string | null;
  work_description: string | null;
  location: string | null;
  rfe_approved_amount: number;
  claimable: boolean;
  supplier: string | null;
  material_used: string | null;
  bill_date: string | null;
  bill_no: string | null;
  qty: number;
  unit: string | null;
  unit_cost: number;
  discount: number;
  total_amount: number;
}

/** total = qty * unit cost - discount, 2 decimals. */
export function lineTotal(qty: number, unitCost: number, discount: number): number {
  const t = round2(qty * unitCost - discount);
  if (t < 0) throw badRequest('The discount cannot be more than quantity times unit cost.');
  return t;
}

async function resolveWr(db: Queryable, contractorId: string, code: string) {
  const r = await db.query<{ id: string; wr_code: string; wr_status: string | null; description: string | null; building_name: string | null; rfe_amount: number | null; approved_on: string | null }>(
    `SELECT w.id, w.wr_code, w.wr_status, w.description, w.building_name, f.rfe_amount, f.approved_on
       FROM work_request w LEFT JOIN rfe_status f ON f.contractor_id = w.contractor_id AND f.wr_code = w.wr_code
      WHERE w.contractor_id = $1 AND w.wr_code = $2`,
    [contractorId, code],
  );
  const w = r.rows[0];
  if (!w) throw badRequest(`Work request ${code} was not found.`);
  return w;
}

/** Merge the request onto the current line (or defaults) and compute the total; fills the WR fields when a WR code is given. */
async function buildLine(db: Queryable, contractorId: string, input: Partial<LineInput>, base?: LineRow): Promise<LineValues> {
  const v: LineValues = base
    ? {
        work_request_id: base.work_request_id, wr_code: base.wr_code, wr_status: base.wr_status, grn_code: base.grn_code, gl_code: base.gl_code, wbs: base.wbs,
        work_description: base.work_description, location: base.location, rfe_approved_amount: base.rfe_approved_amount, claimable: base.claimable, supplier: base.supplier,
        material_used: base.material_used, bill_date: base.bill_date, bill_no: base.bill_no, qty: base.qty, unit: base.unit, unit_cost: base.unit_cost, discount: base.discount,
        total_amount: base.total_amount,
      }
    : {
        work_request_id: null, wr_code: null, wr_status: null, grn_code: null, gl_code: null, wbs: null, work_description: null, location: null, rfe_approved_amount: 0,
        claimable: true, supplier: null, material_used: null, bill_date: null, bill_no: null, qty: 1, unit: null, unit_cost: 0, discount: 0, total_amount: 0,
      };
  const set = <K extends keyof LineValues>(k: K, val: LineValues[K] | undefined) => {
    if (val !== undefined) v[k] = val;
  };
  const str = (x: string | null | undefined) => (x === undefined ? undefined : blank(x));
  set('grn_code', str(input.grnCode));
  set('gl_code', str(input.glCode));
  set('wbs', str(input.wbs));
  set('work_description', str(input.workDescription));
  set('location', str(input.location));
  set('supplier', str(input.supplier));
  set('material_used', str(input.materialUsed));
  set('bill_no', str(input.billNo));
  set('unit', str(input.unit));
  set('bill_date', input.billDate === undefined ? undefined : (input.billDate ?? null));
  set('claimable', input.claimable);
  set('qty', input.qty);
  set('unit_cost', input.unitCost);
  set('discount', input.discount);
  set('rfe_approved_amount', input.rfeApprovedAmount);
  if (input.wrCode !== undefined) {
    const code = blank(input.wrCode);
    if (!code) {
      v.work_request_id = null;
      v.wr_code = null;
      v.wr_status = null;
    } else {
      const w = await resolveWr(db, contractorId, code);
      const changed = w.wr_code !== v.wr_code;
      v.work_request_id = w.id;
      v.wr_code = w.wr_code;
      v.wr_status = w.wr_status;
      if (!v.work_description) v.work_description = blank(w.description);
      if (!v.location) v.location = blank(w.building_name);
      if (input.rfeApprovedAmount === undefined && changed) v.rfe_approved_amount = w.approved_on && w.rfe_amount ? w.rfe_amount : 0;
    }
  }
  v.total_amount = lineTotal(v.qty, v.unit_cost, v.discount);
  return v;
}

const LINE_COLS = `work_request_id, wr_code, wr_status, grn_code, gl_code, wbs, work_description, location, rfe_approved_amount, claimable, supplier, material_used,
                   bill_date, bill_no, qty, unit, unit_cost, discount, total_amount`;

function lineParams(v: LineValues): unknown[] {
  return [
    v.work_request_id, v.wr_code, v.wr_status, v.grn_code, v.gl_code, v.wbs, v.work_description, v.location, v.rfe_approved_amount, v.claimable, v.supplier, v.material_used,
    v.bill_date, v.bill_no, v.qty, v.unit, v.unit_cost, v.discount, v.total_amount,
  ];
}

async function insertLine(c: Queryable, contractorId: string, claimId: string, lineNo: number, v: LineValues, localPurchaseId: string | null = null): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO petty_cash_line (contractor_id, claim_id, line_no, local_purchase_id, ${LINE_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [contractorId, claimId, lineNo, localPurchaseId, ...lineParams(v)],
  );
  return r.rows[0]!.id;
}

async function recompute(c: Queryable, claimId: string) {
  await c.query(
    `UPDATE petty_cash_claim SET total_amount = COALESCE((SELECT sum(total_amount) FROM petty_cash_line WHERE claim_id = $1), 0), updated_at = now() WHERE id = $1`,
    [claimId],
  );
}

async function nextLineNo(c: Queryable, claimId: string): Promise<number> {
  return (await c.query<{ n: number }>('SELECT COALESCE(max(line_no), 0)::int + 1 AS n FROM petty_cash_line WHERE claim_id = $1', [claimId])).rows[0]!.n;
}

// ───────────────────────────── views ─────────────────────────────

function pendingOf(c: ClaimRow): { role: string | null; label: string | null } {
  switch (c.status) {
    case 'draft':
    case 'returned':
      return { role: 'preparer', label: `${c.prepared_by_name ?? 'Preparer'} (to prepare and submit)` };
    case 'submitted':
      return { role: 'contractor_admin', label: 'Admin (to review)' };
    case 'reviewed':
      return { role: 'manager', label: 'Project Manager (to approve)' };
    default:
      return { role: null, label: null };
  }
}

function headerView(c: ClaimRow) {
  return {
    id: c.id,
    refNo: c.ref_no,
    code: pcCode(c.ref_no),
    status: c.status,
    statusLabel: PC_STATUS_LABELS[c.status],
    projectName: c.project_name,
    month: c.month,
    purchaseType: c.purchase_type,
    preparedBy: c.prepared_by,
    preparedByName: c.prepared_by_name,
    reviewedByName: c.reviewed_by_name,
    reviewedAt: c.reviewed_at,
    approvedByName: c.approved_by_name,
    approvedAt: c.approved_at,
    totalAmount: c.total_amount,
    approvedAmount: c.approved_amount,
    pending: pendingOf(c),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function monthStart(m: string): string {
  return `${m}-01`;
}
function nextMonthStart(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

interface UnclaimedRow {
  id: string;
  item: string;
  amount: number;
  purchased_on: string;
  petty_cash_ref: string | null;
  wr_id: string;
  wr_code: string;
  wr_status: string | null;
  description: string | null;
  building_name: string | null;
}

/** Local purchases in the preparer's scope, bought in the month or earlier, that are on no active claim. */
async function unclaimedPurchases(db: Queryable, scope: Scope, claimMonth: string, ids?: string[]): Promise<UnclaimedRow[]> {
  const params: unknown[] = [scope.contractorId, nextMonthStart(claimMonth)];
  const cond = scopeSql(scope, params);
  let idCond = '';
  if (ids?.length) {
    params.push(ids);
    idCond = `AND p.id = ANY($${params.length}::uuid[])`;
  }
  const r = await db.query<UnclaimedRow>(
    `SELECT p.id, p.item, p.amount, p.purchased_on, p.petty_cash_ref, w.id AS wr_id, w.wr_code, w.wr_status, w.description, w.building_name
       FROM local_purchase p JOIN work_request w ON w.id = p.work_request_id
      WHERE p.contractor_id = $1 AND p.purchased_on < $2::date ${idCond}
        AND NOT EXISTS (SELECT 1 FROM petty_cash_line l WHERE l.local_purchase_id = p.id AND l.holds_purchase)
        AND ${cond}
      ORDER BY p.purchased_on, p.created_at`,
    params,
  );
  return r.rows;
}

interface FileView {
  id: string;
  fileName: string;
  mime: string;
  source: 'line' | 'local_purchase';
}

async function detailView(db: Queryable, scope: Scope, claim: ClaimRow, access: Access) {
  const lines = await db.query<LineRow & { bill_photos: FileView[]; purchase_receipts: FileView[] }>(
    `SELECT l.*,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'fileName', t.file_name, 'mime', t.mime, 'source', 'line') ORDER BY t.created_at)
                        FROM attachment t WHERE t.contractor_id = l.contractor_id AND t.owner_type = 'petty_cash_line' AND t.owner_id = l.id), '[]') AS bill_photos,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'fileName', t.file_name, 'mime', t.mime, 'source', 'local_purchase') ORDER BY t.created_at)
                        FROM attachment t WHERE t.contractor_id = l.contractor_id AND t.owner_type = 'local_purchase' AND t.owner_id = l.local_purchase_id), '[]') AS purchase_receipts
       FROM petty_cash_line l WHERE l.claim_id = $1 ORDER BY l.line_no`,
    [claim.id],
  );
  const history = await db.query<{ id: string; from_status: string | null; to_status: string; note: string | null; at: Date; user_name: string | null }>(
    `SELECT h.id, h.from_status, h.to_status, h.note, h.at, u.full_name AS user_name
       FROM petty_cash_history h LEFT JOIN app_user u ON u.id = h.user_id WHERE h.claim_id = $1 ORDER BY h.at, h.id`,
    [claim.id],
  );
  const submittedAt = [...history.rows].reverse().find((h) => h.to_status === 'submitted')?.at ?? null;
  const unclaimed = access.canEdit ? (await unclaimedPurchases(db, scope, claim.month)).length : 0;
  const role = scope.user.role;
  return {
    ...headerView(claim),
    preparedAt: submittedAt,
    lines: lines.rows.map((l) => ({
      id: l.id, lineNo: l.line_no, workRequestId: l.work_request_id, wrCode: l.wr_code, wrStatus: l.wr_status, localPurchaseId: l.local_purchase_id, grnCode: l.grn_code,
      glCode: l.gl_code, wbs: l.wbs, workDescription: l.work_description, location: l.location, rfeApprovedAmount: l.rfe_approved_amount, claimable: l.claimable,
      supplier: l.supplier, materialUsed: l.material_used, billDate: l.bill_date, billNo: l.bill_no, qty: l.qty, unit: l.unit, unitCost: l.unit_cost, discount: l.discount,
      totalAmount: l.total_amount, approvedTotal: l.approved_total, receipts: [...l.purchase_receipts, ...l.bill_photos],
    })),
    history: history.rows.map((h) => ({ id: h.id, fromStatus: h.from_status, toStatus: h.to_status, note: h.note, at: h.at, userName: h.user_name })),
    unclaimedCount: unclaimed,
    can: {
      edit: access.canEdit,
      submit: access.canEdit,
      review: access.canReview,
      return: access.canReview,
      approve: access.canApprove,
      reject: access.canApprove,
      importPurchases: access.canEdit,
      export: true,
      role,
    },
  };
}

// ───────────────────────────── uploads ─────────────────────────────

interface Upload {
  rel: string;
  mime: string;
  size: number;
  sha256: string;
  name: string;
}

async function removeUploads(app: FastifyInstance, files: { rel: string }[]) {
  for (const p of files) await fsp.rm(path.join(app.config.uploadDir, p.rel), { force: true }).catch(() => undefined);
}

async function readPhotos(app: FastifyInstance, request: FastifyRequest, contractorId: string): Promise<Upload[]> {
  if (!request.isMultipart()) throw badRequest('Send the photos as a form (multipart).');
  const out: Upload[] = [];
  const dir = path.join(app.config.uploadDir, contractorId);
  const cap = Math.min(MAX_PHOTO_BYTES, app.config.maxUploadBytes);
  try {
    for await (const part of request.parts({ limits: { files: MAX_FILES_PER_UPLOAD + 1, fileSize: cap, fields: 5 } })) {
      if (part.type !== 'file') continue;
      if (out.length >= MAX_FILES_PER_UPLOAD) throw badRequest(`At most ${MAX_FILES_PER_UPLOAD} photos per upload.`);
      const buf = await part.toBuffer();
      if (part.file.truncated) throw new AppError(413, 'too_large', `A photo is larger than ${Math.round(cap / 1048576)} MB.`);
      if (!buf.length) continue;
      const t = imageType(buf);
      if (!t) throw new AppError(415, 'unsupported_file', 'Only JPEG, PNG or WebP photos can be uploaded.');
      await fsp.mkdir(dir, { recursive: true });
      const id = crypto.randomUUID();
      const rel = `${contractorId}/${id}.${t.ext}`;
      await fsp.writeFile(path.join(app.config.uploadDir, rel), buf, { flag: 'wx' });
      out.push({ rel, mime: t.mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), name: `bill-${id.slice(0, 8)}.${t.ext}` });
    }
  } catch (err) {
    await removeUploads(app, out);
    throw err;
  }
  return out;
}

// ───────────────────────────── export ─────────────────────────────

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;
const dateText = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

type DetailView = Awaited<ReturnType<typeof detailView>>;

/** The paper form as a worksheet: header block, the 19 line columns, the total, and the signature boxes. */
export async function claimWorkbook(d: DetailView): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(d.code, { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const heads = ['Sl. No', 'GRN Code', 'Work Order No', 'WR Status', 'GL Code', 'WBS', 'Work Description', 'Location', 'RFE Approved (QAR)', 'Claimable / Non-Claimable', 'Supplier', 'Material Used',
    'Bill Date', 'Bill #', 'Qty', 'Unit', 'Unit Cost', 'Discount', 'Total Amount'];
  const widths = [7, 12, 14, 18, 12, 12, 34, 22, 14, 16, 20, 22, 12, 14, 8, 8, 12, 11, 15];
  ws.columns = widths.map((w) => ({ width: w }));
  const thin = { style: 'thin' as const };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const last = heads.length;

  ws.mergeCells(1, 1, 1, last);
  const title = ws.getCell(1, 1);
  title.value = 'EXPENSE PETTY CASH REIMBURSEMENT CLAIM';
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: 'center' };

  const info: [string, string][] = [['Project Name', d.projectName ?? ''], ['Month', monthLabel(d.month)], ['Ref. No.', d.code], ['Type', d.purchaseType === 'services' ? 'SERVICES' : 'MATERIALS']];
  info.forEach(([k, val], i) => {
    const row = 3 + i;
    ws.getCell(row, 1).value = k;
    ws.getCell(row, 1).font = { bold: true };
    ws.mergeCells(row, 1, row, 2);
    ws.mergeCells(row, 3, row, 7);
    ws.getCell(row, 3).value = val;
  });

  const headRow = 8;
  heads.forEach((h, i) => {
    const cell = ws.getCell(headRow, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    cell.border = box;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  });
  ws.getRow(headRow).height = 32;

  d.lines.forEach((l, i) => {
    const row = headRow + 1 + i;
    const values: (string | number)[] = [
      l.lineNo, l.grnCode ?? '', l.wrCode ?? '', l.wrStatus ?? '', l.glCode ?? '', l.wbs ?? '', l.workDescription ?? '', l.location ?? '', l.rfeApprovedAmount,
      l.claimable ? 'Claimable' : 'Non-Claimable', l.supplier ?? '', l.materialUsed ?? '', l.billDate ?? '', l.billNo ?? '', l.qty, l.unit ?? '', l.unitCost, l.discount, l.totalAmount,
    ];
    values.forEach((val, c) => {
      const cell = ws.getCell(row, c + 1);
      cell.value = val;
      cell.border = box;
      cell.alignment = { vertical: 'top', wrapText: c === 6 || c === 7 };
      if ([8, 16, 17, 18].includes(c)) cell.numFmt = '#,##0.00';
    });
  });

  let row = headRow + d.lines.length + 1;
  ws.mergeCells(row, 1, row, last - 1);
  const t = ws.getCell(row, 1);
  t.value = 'Total Amount Claim in Qatari Riyal';
  t.font = { bold: true };
  t.alignment = { horizontal: 'right' };
  const tv = ws.getCell(row, last);
  tv.value = d.totalAmount;
  tv.numFmt = '#,##0.00';
  tv.font = { bold: true };
  for (let c = 1; c <= last; c++) ws.getCell(row, c).border = box;
  if (d.approvedAmount !== null) {
    row += 1;
    ws.mergeCells(row, 1, row, last - 1);
    const a = ws.getCell(row, 1);
    a.value = 'Approved Amount in Qatari Riyal';
    a.font = { bold: true };
    a.alignment = { horizontal: 'right' };
    const av = ws.getCell(row, last);
    av.value = d.approvedAmount;
    av.numFmt = '#,##0.00';
    av.font = { bold: true };
    for (let c = 1; c <= last; c++) ws.getCell(row, c).border = box;
  }

  row += 3;
  const sigs: [string, string, string][] = [
    ['Prepared By', d.preparedByName ?? '', dateText(d.preparedAt)],
    ['Review & Noted By', d.reviewedByName ?? '', dateText(d.reviewedAt)],
    ['Approved By', d.approvedByName ?? '', dateText(d.approvedAt)],
    ['Approved By', '', ''],
  ];
  const span = [3, 4, 4, 4];
  let col = 1;
  sigs.forEach(([cap, name, date], i) => {
    const to = col + span[i]! - 1;
    for (let r = 0; r < 4; r++) {
      ws.mergeCells(row + r, col, row + r, to);
    }
    ws.getCell(row, col).value = cap;
    ws.getCell(row, col).font = { bold: true };
    ws.getCell(row + 2, col).value = name;
    ws.getCell(row + 3, col).value = date;
    for (let r = 0; r < 4; r++) for (let c = col; c <= to; c++) ws.getCell(row + r, c).border = box;
    col = to + 2;
  });
  ws.getRow(row + 1).height = 28;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────────── routes ─────────────────────────────

const idParam = z.object({ id: z.string().uuid() });
const lineParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });
const actionBody = z
  .object({
    action: z.enum(['submit', 'review', 'return', 'approve', 'reject']),
    note: z.string().trim().max(1000).nullish(),
    approvedAmounts: z.record(z.string().uuid(), z.number().min(0).max(999999999)).optional(),
    approvedTotal: z.number().min(0).max(999999999).optional(),
  })
  .strict();

export default async function pettyCashRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireRole(...VIEW_ROLES) };
  const preparers = { preHandler: requireRole(...PREPARE_ROLES) };

  async function tzToday(contractorId: string) {
    const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [contractorId])).rows[0]?.time_zone;
    return { tz: tz ?? 'Asia/Qatar', today: todayFor(app, tz) };
  }

  async function reply(scope: Scope, id: string) {
    const f = await loadClaim(app.db, scope, id);
    return detailView(app.db, scope, f.claim, f.access);
  }

  async function editable(scope: Scope, id: string) {
    const f = await loadClaim(app.db, scope, id);
    if (!f.access.canEdit) {
      if (f.claim.status !== 'draft' && f.claim.status !== 'returned') throw conflict(`This claim is ${PC_STATUS_LABELS[f.claim.status].toLowerCase()}; it can no longer be edited.`);
      throw forbidden('Only the person who prepared it, or a coordinator or manager, can edit this claim.');
    }
    return f.claim;
  }

  // ───── create ─────
  app.post('/api/petty-cash', preparers, async (request, reply_) => {
    const scope = await scopeOf(app, request);
    const user = scope.user;
    const b = createBody.parse(request.body);
    const { today } = await tzToday(scope.contractorId);
    const created = await withTx(app.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pc:${scope.contractorId}`]);
      const prev = (await c.query<{ n: number; project_name: string | null }>(
        `SELECT ref_no AS n, project_name FROM petty_cash_claim WHERE contractor_id = $1 ORDER BY ref_no DESC LIMIT 1`, [scope.contractorId])).rows[0];
      const no = (prev?.n ?? 0) + 1;
      const project = blank(b.projectName) ?? prev?.project_name ?? null;
      const r = await c.query<{ id: string }>(
        `INSERT INTO petty_cash_claim (contractor_id, ref_no, project_name, month, purchase_type, prepared_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [scope.contractorId, no, project, b.month ?? today.slice(0, 7), b.purchaseType ?? 'materials', user.id],
      );
      const id = r.rows[0]!.id;
      let n = 1;
      for (const l of b.lines ?? []) await insertLine(c, scope.contractorId, id, n++, await buildLine(c, scope.contractorId, l));
      await recompute(c, id);
      await c.query(`INSERT INTO petty_cash_history (contractor_id, claim_id, from_status, to_status, user_id) VALUES ($1,$2,NULL,'draft',$3)`, [scope.contractorId, id, user.id]);
      await auditFromRequest(request, { action: 'petty_cash.create', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(no) }, c);
      return { id, no };
    });
    return reply_.status(201).send(await reply(scope, created.id));
  });

  // ───── list ─────
  app.get('/api/petty-cash', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const q = z.object({ status: z.string().max(200).optional(), month: month.optional(), mine: z.enum(['1', '0']).optional() }).parse(request.query);
    const params: unknown[] = [scope.contractorId];
    const where = ['c.contractor_id = $1'];
    where.push(visibleSql(scope, params));
    const statuses = (q.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      if (statuses.some((s) => !(PC_STATUSES as readonly string[]).includes(s))) throw badRequest('Unknown status.');
      params.push(statuses);
      where.push(`c.status = ANY($${params.length}::text[])`);
    }
    if (q.month) {
      params.push(q.month);
      where.push(`c.month = $${params.length}`);
    }
    if (q.mine === '1') {
      params.push(scope.user.id);
      where.push(`c.prepared_by = $${params.length}`);
    }
    const r = await app.db.query<ClaimRow & { line_count: number }>(
      `SELECT c.*, up.full_name AS prepared_by_name, ur.full_name AS reviewed_by_name, ua.full_name AS approved_by_name,
              (SELECT count(*)::int FROM petty_cash_line l WHERE l.claim_id = c.id) AS line_count
         FROM petty_cash_claim c
         LEFT JOIN app_user up ON up.id = c.prepared_by
         LEFT JOIN app_user ur ON ur.id = c.reviewed_by
         LEFT JOIN app_user ua ON ua.id = c.approved_by
        WHERE ${where.join(' AND ')} ORDER BY c.ref_no DESC LIMIT 500`,
      params,
    );
    return { items: r.rows.map((c) => ({ ...headerView(c), lines: c.line_count })) };
  });

  // ───── detail ─────
  app.get('/api/petty-cash/:id', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    return reply(scope, id);
  });

  // ───── header ─────
  app.patch('/api/petty-cash/:id', preparers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = patchBody.parse(request.body);
    const claim = await editable(scope, id);
    await withTx(app.db, async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const add = (col: string, val: unknown) => {
        if (val === undefined) return;
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      add('project_name', b.projectName === undefined ? undefined : blank(b.projectName));
      add('month', b.month);
      add('purchase_type', b.purchaseType);
      if (sets.length) await c.query(`UPDATE petty_cash_claim SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, params);
      await auditFromRequest(request, { action: 'petty_cash.update', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { fields: Object.keys(b) } }, c);
    });
    return reply(scope, id);
  });

  // ───── lines ─────
  app.post('/api/petty-cash/:id/lines', preparers, async (request, reply_) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = lineCreate.parse(request.body);
    const claim = await editable(scope, id);
    await withTx(app.db, async (c) => {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM petty_cash_line WHERE claim_id = $1', [id])).rows[0]!.n;
      if (n >= MAX_LINES) throw badRequest(`At most ${MAX_LINES} lines per claim.`);
      await insertLine(c, scope.contractorId, id, await nextLineNo(c, id), await buildLine(c, scope.contractorId, b));
      await recompute(c, id);
      await auditFromRequest(request, { action: 'petty_cash.line_add', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no) }, c);
    });
    return reply_.status(201).send(await reply(scope, id));
  });

  app.patch('/api/petty-cash/:id/lines/:lineId', preparers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id, lineId } = lineParam.parse(request.params);
    const b = linePatch.parse(request.body);
    const claim = await editable(scope, id);
    await withTx(app.db, async (c) => {
      const cur = (await c.query<LineRow>('SELECT * FROM petty_cash_line WHERE id = $1 AND claim_id = $2', [lineId, id])).rows[0];
      if (!cur) throw notFound('Line not found.');
      const v = await buildLine(c, scope.contractorId, b, cur);
      await c.query(
        `UPDATE petty_cash_line SET work_request_id = $2, wr_code = $3, wr_status = $4, grn_code = $5, gl_code = $6, wbs = $7, work_description = $8, location = $9,
                rfe_approved_amount = $10, claimable = $11, supplier = $12, material_used = $13, bill_date = $14, bill_no = $15, qty = $16, unit = $17, unit_cost = $18,
                discount = $19, total_amount = $20 WHERE id = $1`,
        [lineId, ...lineParams(v)],
      );
      await recompute(c, id);
      await auditFromRequest(request, { action: 'petty_cash.line_update', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { lineId } }, c);
    });
    return reply(scope, id);
  });

  app.delete('/api/petty-cash/:id/lines/:lineId', preparers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id, lineId } = lineParam.parse(request.params);
    const claim = await editable(scope, id);
    const files = await withTx(app.db, async (c) => {
      const del = await c.query('DELETE FROM petty_cash_line WHERE id = $1 AND claim_id = $2', [lineId, id]);
      if (!del.rowCount) throw notFound('Line not found.');
      const a = await c.query<{ file_path: string }>(
        `DELETE FROM attachment WHERE contractor_id = $1 AND owner_type = 'petty_cash_line' AND owner_id = $2 RETURNING file_path`,
        [scope.contractorId, lineId],
      );
      await c.query(
        `UPDATE petty_cash_line l SET line_no = s.rn FROM (SELECT id, row_number() OVER (ORDER BY line_no)::int AS rn FROM petty_cash_line WHERE claim_id = $1) s WHERE l.id = s.id`,
        [id],
      );
      await recompute(c, id);
      await auditFromRequest(request, { action: 'petty_cash.line_delete', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { lineId } }, c);
      return a.rows;
    });
    const root = path.resolve(app.config.uploadDir);
    for (const f of files) {
      const full = path.resolve(root, f.file_path);
      if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    }
    return reply(scope, id);
  });

  // ───── import unclaimed local purchases ─────
  app.post('/api/petty-cash/:id/import-local-purchases', preparers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = z.object({ purchaseIds: z.array(z.string().uuid()).max(MAX_LINES).optional() }).strict().parse(request.body ?? {});
    const claim = await editable(scope, id);
    const added = await withTx(app.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pc:${scope.contractorId}`]);
      const rows = await unclaimedPurchases(c, scope, claim.month, b.purchaseIds);
      const have = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM petty_cash_line WHERE claim_id = $1', [id])).rows[0]!.n;
      if (have + rows.length > MAX_LINES) throw badRequest(`At most ${MAX_LINES} lines per claim.`);
      let n = await nextLineNo(c, id);
      for (const p of rows) {
        const v: LineValues = {
          work_request_id: p.wr_id, wr_code: p.wr_code, wr_status: p.wr_status, grn_code: null, gl_code: null, wbs: null,
          work_description: blank(p.description) ?? p.item, location: blank(p.building_name), rfe_approved_amount: 0, claimable: true, supplier: null,
          material_used: p.item, bill_date: p.purchased_on, bill_no: blank(p.petty_cash_ref), qty: 1, unit: 'lot', unit_cost: p.amount, discount: 0, total_amount: round2(p.amount),
        };
        await insertLine(c, scope.contractorId, id, n++, v, p.id);
      }
      await recompute(c, id);
      await auditFromRequest(request, { action: 'petty_cash.import', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { added: rows.length } }, c);
      return rows.length;
    });
    return { added, claim: await reply(scope, id) };
  });

  // ───── bill photos of a line ─────
  app.post('/api/petty-cash/:id/lines/:lineId/attachments', preparers, async (request, reply_) => {
    const scope = await scopeOf(app, request);
    const { id, lineId } = lineParam.parse(request.params);
    const claim = await editable(scope, id);
    const ok = await app.db.query('SELECT 1 FROM petty_cash_line WHERE id = $1 AND claim_id = $2', [lineId, id]);
    if (!ok.rows.length) throw notFound('Line not found.');
    const saved = await readPhotos(app, request, scope.contractorId);
    try {
      if (!saved.length) throw badRequest('Choose at least one photo.');
      const have = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM attachment WHERE contractor_id = $1 AND owner_type = 'petty_cash_line' AND owner_id = $2`, [scope.contractorId, lineId])).rows[0]!.n;
      if (have + saved.length > MAX_LINE_PHOTOS) throw badRequest(`At most ${MAX_LINE_PHOTOS} bill photos per line.`);
      const out = await withTx(app.db, async (c) => {
        const list: FileView[] = [];
        for (const p of saved) {
          const r = await c.query<{ id: string }>(
            `INSERT INTO attachment (contractor_id, owner_type, owner_id, file_path, file_name, mime, size_bytes, sha256, uploaded_by)
             VALUES ($1,'petty_cash_line',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [scope.contractorId, lineId, p.rel, p.name, p.mime, p.size, p.sha256, scope.user.id],
          );
          list.push({ id: r.rows[0]!.id, fileName: p.name, mime: p.mime, source: 'line' });
        }
        await c.query('UPDATE petty_cash_claim SET updated_at = now() WHERE id = $1', [id]);
        await auditFromRequest(request, { action: 'petty_cash.attach', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { lineId, files: saved.length } }, c);
        return list;
      });
      return reply_.status(201).send({ attachments: out });
    } catch (err) {
      await removeUploads(app, saved);
      throw err;
    }
  });

  app.delete('/api/petty-cash/:id/lines/:lineId/attachments/:attId', preparers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id, lineId, attId } = z.object({ id: z.string().uuid(), lineId: z.string().uuid(), attId: z.string().uuid() }).parse(request.params);
    const claim = await editable(scope, id);
    const a = (await app.db.query<{ file_path: string }>(
      `SELECT t.file_path FROM attachment t JOIN petty_cash_line l ON l.id = t.owner_id AND l.claim_id = $3
        WHERE t.id = $1 AND t.contractor_id = $2 AND t.owner_type = 'petty_cash_line' AND t.owner_id = $4`,
      [attId, scope.contractorId, id, lineId],
    )).rows[0];
    if (!a) throw notFound('File not found.');
    await withTx(app.db, async (c) => {
      await c.query('DELETE FROM attachment WHERE id = $1', [attId]);
      await auditFromRequest(request, { action: 'petty_cash.detach', entityType: 'petty_cash_claim', entityId: id, summary: pcCode(claim.ref_no), details: { attachmentId: attId } }, c);
    });
    const root = path.resolve(app.config.uploadDir);
    const full = path.resolve(root, a.file_path);
    if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    return reply(scope, id);
  });

  // ───── workflow ─────
  app.post('/api/petty-cash/:id/action', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = actionBody.parse(request.body);
    const { claim, access } = await loadClaim(app.db, scope, id);
    const user = scope.user;
    const note = blank(b.note);
    const needRole: Record<string, Role[]> = { submit: [...PREPARE_ROLES], review: ['contractor_admin'], return: ['contractor_admin'], approve: ['manager'], reject: ['manager'] };
    if (!needRole[b.action]!.includes(user.role)) throw forbidden('You cannot make this change.');
    const from: Record<string, PcStatus[]> = { submit: ['draft', 'returned'], review: ['submitted'], return: ['submitted'], approve: ['reviewed'], reject: ['reviewed'] };
    if (!from[b.action]!.includes(claim.status)) throw conflict(`This claim is ${PC_STATUS_LABELS[claim.status].toLowerCase()}; it cannot be ${b.action === 'return' ? 'returned' : `${b.action}${b.action.endsWith('e') ? 'd' : 'ed'}`} now.`);
    if (b.action === 'submit' && !access.canEdit) throw forbidden('Only the person who prepared it, or a coordinator or manager, can submit this claim.');
    if ((b.action === 'return' || b.action === 'reject') && !note) throw badRequest(b.action === 'return' ? 'Say what the preparer must fix.' : 'Say why the claim is rejected.');
    const to: PcStatus = ({ submit: 'submitted', review: 'reviewed', return: 'returned', approve: 'approved', reject: 'rejected' } as const)[b.action];
    let approvedAmount: number | null = null;
    await withTx(app.db, async (c) => {
      const lines = (await c.query<{ id: string; total_amount: number }>('SELECT id, total_amount FROM petty_cash_line WHERE claim_id = $1 ORDER BY line_no', [id])).rows;
      if (b.action === 'submit') {
        if (!lines.length) throw badRequest('Add at least one line before submitting.');
        if (lines.some((l) => l.total_amount <= 0)) throw badRequest('Every line needs a total amount above 0.');
      }
      if (b.action === 'approve') {
        const given = b.approvedAmounts ?? {};
        for (const [lid, amt] of Object.entries(given)) {
          const l = lines.find((x) => x.id === lid);
          if (!l) throw badRequest('An approved amount does not belong to a line of this claim.');
          if (amt > l.total_amount) throw badRequest('An approved amount cannot be more than the claimed amount of the line.');
        }
        let sum = 0;
        for (const l of lines) {
          const a = round2(given[l.id] ?? l.total_amount);
          sum += a;
          await c.query('UPDATE petty_cash_line SET approved_total = $2 WHERE id = $1', [l.id, a]);
        }
        approvedAmount = round2(b.approvedTotal ?? sum);
        if (approvedAmount > claim.total_amount) throw badRequest('The approved amount cannot be more than the claimed amount.');
      }
      const r = await c.query(
        `UPDATE petty_cash_claim SET status = $2, updated_at = now(),
                reviewed_by = CASE WHEN $2 = 'reviewed' THEN $4::uuid ELSE reviewed_by END, reviewed_at = CASE WHEN $2 = 'reviewed' THEN $5::timestamptz ELSE reviewed_at END,
                approved_by = CASE WHEN $2 = 'approved' THEN $4::uuid ELSE approved_by END, approved_at = CASE WHEN $2 = 'approved' THEN $5::timestamptz ELSE approved_at END,
                approved_amount = CASE WHEN $2 = 'approved' THEN $6::numeric ELSE approved_amount END
          WHERE id = $1 AND status = $3`,
        [id, to, claim.status, user.id, app.opsClock.now(), approvedAmount],
      );
      if (!r.rowCount) throw conflict('The claim changed while you were looking at it. Reload and try again.');
      if (to === 'rejected') await c.query('UPDATE petty_cash_line SET holds_purchase = false WHERE claim_id = $1', [id]);
      await c.query(`INSERT INTO petty_cash_history (contractor_id, claim_id, from_status, to_status, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [scope.contractorId, id, claim.status, to, note, user.id]);
      await auditFromRequest(request, { action: `petty_cash.${b.action}`, entityType: 'petty_cash_claim', entityId: id, summary: `${pcCode(claim.ref_no)}: ${claim.status} -> ${to}`, details: { note, approvedAmount } }, c);
    });
    const code = pcCode(claim.ref_no);
    const url = `/petty-cash/${id}`;
    const base = { contractorId: scope.contractorId, url, entityType: 'petty_cash_claim', entityId: id, channels: ['in_app', 'push'] as ('in_app' | 'push')[] };
    if (b.action === 'submit') {
      await notify(app, { ...base, event: 'petty_cash.submitted', roles: ['contractor_admin'], title: `${code} submitted for review`, body: `${claim.prepared_by_name ?? 'A supervisor'}, ${monthLabel(claim.month)}, QR ${claim.total_amount}` });
    } else if (b.action === 'review') {
      await notify(app, { ...base, event: 'petty_cash.reviewed', roles: ['manager'], title: `${code} waiting for your approval`, body: `Reviewed by ${user.fullName}, QR ${claim.total_amount}` });
    } else if (claim.prepared_by && claim.prepared_by !== user.id) {
      const title = b.action === 'return' ? `${code} returned to you` : b.action === 'approve' ? `${code} approved` : `${code} rejected`;
      await notify(app, { ...base, event: `petty_cash.${to}`, recipients: [claim.prepared_by], title, body: note ?? (b.action === 'approve' ? `Approved amount: QR ${approvedAmount}` : null) });
    }
    return reply(scope, id);
  });

  // ───── export ─────
  app.get('/api/petty-cash/:id/export', viewers, async (request, reply_) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const d = await reply(scope, id);
    const buf = await claimWorkbook(d);
    await auditFromRequest(request, { action: 'export.petty_cash', entityType: 'petty_cash_claim', entityId: id, summary: d.code });
    return reply_
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="sonu-${d.code}-${d.month}.xlsx"`)
      .header('Cache-Control', 'no-store')
      .send(buf);
  });
}
