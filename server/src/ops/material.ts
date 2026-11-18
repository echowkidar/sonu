/**
 * Material requests (MR): the contractor's "MATERIALS / SERVICE REQUEST" form. Field staff raise it for a work request,
 * procurement works it (accept, vendor enquiry, quotation, order, delivery) and the requester closes it.
 * SONU only records this; nothing here ever writes to Marafiq.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UNMAPPED } from '@sonu/core';
import { auditFromRequest } from '../audit.js';
import { requireRole } from '../auth/guards.js';
import type { Role } from '../auth/roles.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notifications/index.js';
import { computedFor, loadComputeContext, scopeOf, scopeSql, seesMoney, todayFor, type Scope } from './context.js';
import { imageType, MAX_PHOTO_BYTES } from './jobs.js';
import { pettyCashSummary } from './pettyCash.js';
import { findWr, sonuEvent } from './workRequests.js';

export const MR_STATUSES = ['submitted', 'accepted', 'enquiry', 'quoted', 'ordered', 'delivered', 'closed', 'rejected', 'cancelled'] as const;
export type MrStatus = (typeof MR_STATUSES)[number];
export const MR_STATUS_LABELS: Record<MrStatus, string> = {
  submitted: 'New',
  accepted: 'Pending (under procurement)',
  enquiry: 'Vendor enquiry sent',
  quoted: 'Quotation received',
  ordered: 'Material ordered',
  delivered: 'Material delivered',
  closed: 'Closed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const DOC_KINDS = ['quote', 'warranty', 'client_approval', 'calibration_certificate', 'other'] as const;

/** Statuses that count as "open" for the Overdue figure: not yet delivered, closed, rejected or cancelled. */
const OVERDUE_STATUSES = ['submitted', 'accepted', 'enquiry', 'quoted', 'ordered'];
const TERMINAL: readonly string[] = ['closed', 'rejected', 'cancelled'];
const MAX_LINES = 50;
const MAX_LINE_PHOTOS = 6;
const MAX_DOCS = 20;
const MAX_FILES_PER_UPLOAD = 6;

const RAISE_ROLES: readonly Role[] = ['supervisor', 'foreman', 'coordinator', 'manager', 'contractor_admin'];
const PROC_ROLES: readonly Role[] = ['purchasing', 'coordinator', 'manager', 'contractor_admin'];
const VIEW_ROLES: readonly Role[] = ['supervisor', 'foreman', 'purchasing', 'coordinator', 'manager', 'contractor_admin'];
// Local copies: importing ALL_SEEING from workRequests.ts would be read before it exists (import cycle).
const ALL_SEEING: readonly string[] = ['coordinator', 'manager', 'contractor_admin'];
const SEES_ALL: readonly string[] = ['purchasing', ...ALL_SEEING];

/** What each status may move to, whoever asks (role rules come on top). Closed only follows delivered. */
const LEGAL: Record<string, readonly MrStatus[]> = {
  submitted: ['accepted', 'enquiry', 'quoted', 'ordered', 'delivered', 'rejected', 'cancelled'],
  accepted: ['enquiry', 'quoted', 'ordered', 'delivered', 'rejected'],
  enquiry: ['quoted', 'ordered', 'delivered', 'rejected'],
  quoted: ['ordered', 'delivered', 'rejected'],
  ordered: ['delivered'],
  delivered: ['closed'],
};

// ───────────────────────────── rows ─────────────────────────────

interface MrRow {
  id: string;
  contractor_id: string;
  mr_no: number;
  work_request_id: string | null;
  wr_code: string | null;
  date_requested: string;
  project_name: string | null;
  contract_no: string | null;
  item_discipline: string | null;
  facility: string | null;
  zone: string | null;
  building_name: string | null;
  purchase_type: 'materials' | 'services';
  purpose: 'stock' | 'new';
  additional_requirements: string | null;
  docs_required: string[];
  status: MrStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  vendor_name: string | null;
  vendor_contact: string | null;
  quotation_ref: string | null;
  quoted_amount: number | null;
  expected_delivery: string | null;
  procurement_remarks: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

const MR_SELECT = `
  SELECT m.*, w.wr_code, ur.full_name AS requested_by_name, ua.full_name AS assigned_to_name
    FROM material_request m
    LEFT JOIN work_request w ON w.id = m.work_request_id
    LEFT JOIN app_user ur ON ur.id = m.requested_by
    LEFT JOIN app_user ua ON ua.id = m.assigned_to`;

export const mrCode = (no: number) => `MR-${no}`;

interface Access {
  isRequester: boolean;
  canProcure: boolean;
  canEdit: boolean;
  canCancel: boolean;
  canClose: boolean;
  canUpload: boolean;
}

async function wrInScope(db: Queryable, scope: Scope, wrId: string): Promise<boolean> {
  const params: unknown[] = [wrId, scope.contractorId];
  const cond = scopeSql(scope, params);
  const r = await db.query(`SELECT 1 FROM work_request w WHERE w.id = $1 AND w.contractor_id = $2 AND ${cond}`, params);
  return r.rows.length > 0;
}

/** null = the user may not see this MR at all. */
async function accessOf(db: Queryable, scope: Scope, mr: MrRow): Promise<Access | null> {
  const u = scope.user;
  if (!VIEW_ROLES.includes(u.role)) return null;
  const isRequester = mr.requested_by === u.id;
  if (!SEES_ALL.includes(u.role)) {
    const seen = isRequester || (mr.work_request_id !== null && (await wrInScope(db, scope, mr.work_request_id)));
    if (!seen) return null;
  }
  const canProcure = PROC_ROLES.includes(u.role);
  const open = !TERMINAL.includes(mr.status);
  const editor = (isRequester && RAISE_ROLES.includes(u.role)) || ALL_SEEING.includes(u.role);
  return {
    isRequester,
    canProcure,
    canEdit: mr.status === 'submitted' && editor,
    canCancel: mr.status === 'submitted' && editor,
    canClose: mr.status === 'delivered' && (isRequester || canProcure),
    canUpload: open && (isRequester || canProcure),
  };
}

async function loadMr(db: Queryable, scope: Scope, id: string): Promise<{ mr: MrRow; access: Access }> {
  const r = await db.query<MrRow>(`${MR_SELECT} WHERE m.id = $1 AND m.contractor_id = $2`, [id, scope.contractorId]);
  const mr = r.rows[0];
  if (!mr) throw notFound('Material request not found.');
  const access = await accessOf(db, scope, mr);
  if (!access) throw notFound('Material request not found.');
  return { mr, access };
}

/** SQL for "MRs this user may see" (alias m). Adds params. */
function visibleSql(scope: Scope, params: unknown[]): string {
  const u = scope.user;
  if (SEES_ALL.includes(u.role)) return 'TRUE';
  if (u.role === 'supervisor' || u.role === 'foreman') {
    params.push(u.id);
    const me = params.length;
    const cond = scopeSql(scope, params);
    return `(m.requested_by = $${me} OR m.work_request_id IN (SELECT w.id FROM work_request w WHERE w.contractor_id = m.contractor_id AND ${cond}))`;
  }
  return 'FALSE';
}

/** Used by GET /api/attachments/:id for owner types mr_line / mr_doc (these never fall back to the WR rule). */
export async function canViewMrFile(db: Queryable, scope: Scope, ownerType: string, ownerId: string): Promise<boolean> {
  let mrId: string | undefined = ownerId;
  if (ownerType === 'mr_line') {
    mrId = (await db.query<{ material_request_id: string }>('SELECT material_request_id FROM material_request_line WHERE id = $1 AND contractor_id = $2', [ownerId, scope.contractorId])).rows[0]?.material_request_id;
  } else if (ownerType !== 'mr_doc') {
    return false;
  }
  if (!mrId) return false;
  try {
    await loadMr(db, scope, mrId);
    return true;
  } catch {
    return false;
  }
}

/** The MRs of one work request, for the WR detail page. */
export async function materialRequestsFor(db: Queryable, scope: Scope, wrId: string) {
  if (scope.assignedOnly || !VIEW_ROLES.includes(scope.user.role)) return [];
  const params: unknown[] = [scope.contractorId, wrId];
  const vis = visibleSql(scope, params);
  const r = await db.query<{ id: string; mr_no: number; status: string; date_requested: string; lines: number; requested_by_name: string | null }>(
    `SELECT m.id, m.mr_no, m.status, m.date_requested, (SELECT count(*)::int FROM material_request_line l WHERE l.material_request_id = m.id) AS lines,
            ur.full_name AS requested_by_name
       FROM material_request m LEFT JOIN app_user ur ON ur.id = m.requested_by
      WHERE m.contractor_id = $1 AND m.work_request_id = $2 AND ${vis} ORDER BY m.mr_no`,
    params,
  );
  return r.rows.map((x) => ({ id: x.id, mrNo: x.mr_no, mrCode: mrCode(x.mr_no), status: x.status, dateRequested: x.date_requested, lines: x.lines, requestedByName: x.requested_by_name }));
}

// ───────────────────────────── input ─────────────────────────────

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'That date is not valid.');
const text = (n: number) => z.string().trim().max(n).nullish();
const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

const lineSchema = z
  .object({
    id: z.string().uuid().optional(),
    wrCode: text(40),
    storeSlNo: text(100),
    clientMatRef: text(100),
    description: z.string().trim().min(1, 'Describe the item.').max(500),
    quantity: z.number('Enter a quantity.').gt(0, 'The quantity must be more than 0.').max(999999999),
    uom: text(30),
    brand: text(100),
    kind: z.enum(['material', 'service']).optional(),
    vendorOrigin: z.enum(['local', 'foreign']).nullish(),
    claimable: z.boolean().nullish(),
    targetDate: isoDate.nullish(),
    remarks: text(1000),
  })
  .strict();
type LineInput = z.infer<typeof lineSchema>;

const headerShape = {
  dateRequested: isoDate.optional(),
  projectName: text(200),
  contractNo: text(100),
  itemDiscipline: text(100),
  facility: text(200),
  zone: text(200),
  buildingName: text(200),
  purchaseType: z.enum(['materials', 'services']),
  purpose: z.enum(['stock', 'new']),
  additionalRequirements: text(2000),
  docsRequired: z.array(z.enum(DOC_KINDS)).max(DOC_KINDS.length).optional(),
};
const createBody = z.object({ wrCode: z.string().trim().min(1).max(40).nullish(), ...headerShape, lines: z.array(lineSchema).min(1, 'Add at least one line.').max(MAX_LINES) }).strict();
const patchBody = z.object(headerShape).partial().extend({ lines: z.array(lineSchema).min(1).max(MAX_LINES).optional() }).strict();

const procurementBody = z
  .object({
    assignedTo: z.string().uuid().nullable().optional(),
    vendorName: text(200),
    vendorContact: text(300),
    quotationRef: text(100),
    quotedAmount: z.number().min(0, 'The amount cannot be negative.').max(999999999).nullable().optional(),
    expectedDelivery: isoDate.nullish(),
    procurementRemarks: text(2000),
  })
  .strict();

async function insertLines(c: Queryable, contractorId: string, mrId: string, defaultWrCode: string | null, purchaseType: string, lines: LineInput[], startNo = 1) {
  let n = startNo;
  const ids: string[] = [];
  for (const l of lines) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO material_request_line (contractor_id, material_request_id, line_no, wr_code, store_sl_no, client_mat_ref, description, quantity, uom, brand, kind,
                                          vendor_origin, claimable, target_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        contractorId, mrId, n++, blank(l.wrCode) ?? defaultWrCode, blank(l.storeSlNo), blank(l.clientMatRef), l.description, l.quantity, blank(l.uom), blank(l.brand),
        l.kind ?? (purchaseType === 'services' ? 'service' : 'material'), l.vendorOrigin ?? null, l.claimable ?? null, l.targetDate ?? null, blank(l.remarks),
      ],
    );
    ids.push(r.rows[0]!.id);
  }
  return ids;
}

// ───────────────────────────── views ─────────────────────────────

interface FileView {
  id: string;
  fileName: string;
  mime: string;
  docKind?: string | null;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
  createdAt?: Date;
}

function headerView(m: MrRow, user: Scope['user']) {
  return {
    id: m.id,
    mrNo: m.mr_no,
    mrCode: mrCode(m.mr_no),
    status: m.status,
    statusLabel: MR_STATUS_LABELS[m.status],
    wrCode: m.wr_code,
    dateRequested: m.date_requested,
    projectName: m.project_name,
    contractNo: m.contract_no,
    itemDiscipline: m.item_discipline,
    facility: m.facility,
    zone: m.zone,
    buildingName: m.building_name,
    purchaseType: m.purchase_type,
    purpose: m.purpose,
    additionalRequirements: m.additional_requirements,
    docsRequired: m.docs_required,
    requestedBy: m.requested_by,
    requestedByName: m.requested_by_name,
    assignedTo: m.assigned_to,
    assignedToName: m.assigned_to_name,
    vendorName: m.vendor_name,
    vendorContact: m.vendor_contact,
    quotationRef: m.quotation_ref,
    quotedAmount: seesMoney(user) ? m.quoted_amount : null,
    expectedDelivery: m.expected_delivery,
    procurementRemarks: m.procurement_remarks,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    closedAt: m.closed_at,
  };
}

/** Statuses this user may move the MR to right now. */
function targetsFor(mr: MrRow, a: Access): MrStatus[] {
  const out: MrStatus[] = [];
  for (const to of LEGAL[mr.status] ?? []) {
    if (to === 'cancelled') {
      if (a.canCancel) out.push(to);
    } else if (to === 'closed') {
      if (a.canClose) out.push(to);
    } else if (a.canProcure) out.push(to);
  }
  return out;
}

async function detailView(db: Queryable, scope: Scope, mr: MrRow, access: Access) {
  const lines = await db.query<{
    id: string; line_no: number; wr_code: string | null; store_sl_no: string | null; client_mat_ref: string | null; description: string; quantity: number; uom: string | null;
    brand: string | null; kind: string; vendor_origin: string | null; claimable: boolean | null; target_date: string | null; remarks: string | null; photos: FileView[];
  }>(
    `SELECT l.*, COALESCE((SELECT json_agg(json_build_object('id', t.id, 'fileName', t.file_name, 'mime', t.mime, 'uploadedBy', t.uploaded_by) ORDER BY t.created_at)
                             FROM attachment t WHERE t.contractor_id = l.contractor_id AND t.owner_type = 'mr_line' AND t.owner_id = l.id), '[]') AS photos
       FROM material_request_line l WHERE l.material_request_id = $1 ORDER BY l.line_no`,
    [mr.id],
  );
  const history = await db.query<{ id: string; from_status: string | null; to_status: string; note: string | null; at: Date; user_name: string | null }>(
    `SELECT h.id, h.from_status, h.to_status, h.note, h.at, u.full_name AS user_name
       FROM material_request_history h LEFT JOIN app_user u ON u.id = h.user_id WHERE h.material_request_id = $1 ORDER BY h.at, h.id`,
    [mr.id],
  );
  const docs = await db.query<{ id: string; file_name: string; mime: string; doc_kind: string | null; created_at: Date; uploaded_by: string | null; uploaded_by_name: string | null }>(
    `SELECT t.id, t.file_name, t.mime, t.doc_kind, t.created_at, t.uploaded_by, u.full_name AS uploaded_by_name
       FROM attachment t LEFT JOIN app_user u ON u.id = t.uploaded_by
      WHERE t.contractor_id = $1 AND t.owner_type = 'mr_doc' AND t.owner_id = $2 ORDER BY t.created_at`,
    [scope.contractorId, mr.id],
  );
  return {
    ...headerView(mr, scope.user),
    lines: lines.rows.map((l) => ({
      id: l.id, lineNo: l.line_no, wrCode: l.wr_code, storeSlNo: l.store_sl_no, clientMatRef: l.client_mat_ref, description: l.description, quantity: l.quantity,
      uom: l.uom, brand: l.brand, kind: l.kind, vendorOrigin: l.vendor_origin, claimable: l.claimable, targetDate: l.target_date, remarks: l.remarks, photos: l.photos,
    })),
    history: history.rows.map((h) => ({ id: h.id, fromStatus: h.from_status, toStatus: h.to_status, note: h.note, at: h.at, userName: h.user_name })),
    documents: docs.rows.map((d) => ({ id: d.id, fileName: d.file_name, mime: d.mime, docKind: d.doc_kind, createdAt: d.created_at, uploadedBy: d.uploaded_by, uploadedByName: d.uploaded_by_name })),
    can: {
      edit: access.canEdit,
      cancel: access.canCancel,
      procure: access.canProcure && !['cancelled', 'rejected'].includes(mr.status),
      upload: access.canUpload,
      nextStatuses: targetsFor(mr, access),
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

function fileKind(buf: Buffer, allowPdf: boolean): { ext: string; mime: string } | null {
  const img = imageType(buf);
  if (img) return img;
  if (allowPdf && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

async function removeUploads(app: FastifyInstance, files: { rel: string }[]) {
  for (const p of files) await fsp.rm(path.join(app.config.uploadDir, p.rel), { force: true }).catch(() => undefined);
}

function safeName(original: string | undefined, ext: string, fallback: string): string {
  let base = path.basename(String(original ?? '')).replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 100);
  if (!base || base.startsWith('.')) base = fallback;
  return base.toLowerCase().endsWith(`.${ext}`) || (ext === 'jpg' && /\.jpe?g$/i.test(base)) ? base : `${base}.${ext}`;
}

async function readUploadForm(app: FastifyInstance, request: FastifyRequest) {
  if (!request.isMultipart()) throw badRequest('Send the files as a form (multipart).');
  const fields: Record<string, string> = {};
  const raw: { buf: Buffer; name: string | undefined }[] = [];
  const cap = Math.min(MAX_PHOTO_BYTES, app.config.maxUploadBytes);
  for await (const part of request.parts({ limits: { files: MAX_FILES_PER_UPLOAD + 1, fileSize: cap, fields: 10 } })) {
    if (part.type === 'file') {
      if (raw.length >= MAX_FILES_PER_UPLOAD) throw badRequest(`At most ${MAX_FILES_PER_UPLOAD} files per upload.`);
      const buf = await part.toBuffer();
      if (part.file.truncated) throw new AppError(413, 'too_large', `A file is larger than ${Math.round(cap / 1048576)} MB.`);
      if (buf.length) raw.push({ buf, name: part.filename });
    } else {
      fields[part.fieldname] = String(part.value ?? '').trim();
    }
  }
  return { fields, raw };
}

// ───────────────────────────── routes ─────────────────────────────

const idParam = z.object({ id: z.string().uuid() });

export default async function materialRoutes(app: FastifyInstance): Promise<void> {
  const viewers = { preHandler: requireRole(...VIEW_ROLES) };
  const raisers = { preHandler: requireRole(...RAISE_ROLES) };
  const procurers = { preHandler: requireRole(...PROC_ROLES) };

  async function tzToday(contractorId: string) {
    const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [contractorId])).rows[0]?.time_zone;
    return { tz: tz ?? 'Asia/Qatar', today: todayFor(app, tz) };
  }

  // ───── create ─────
  app.post('/api/mr', raisers, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const user = scope.user;
    const b = createBody.parse(request.body);
    const isCoord = ALL_SEEING.includes(user.role);
    if (!b.wrCode && !isCoord) throw badRequest('Choose the work request this is for.');
    const w = b.wrCode ? await findWr(app, scope, b.wrCode) : null;
    const { today } = await tzToday(scope.contractorId);
    const ctx = w ? await loadComputeContext(app, app.db, scope.contractorId) : null;
    const c0 = w && ctx ? computedFor(w, ctx) : null;
    const fromWr = (v: string | undefined) => (v && v !== UNMAPPED ? v : null);
    const header = {
      dateRequested: b.dateRequested ?? today,
      projectName: blank(b.projectName),
      contractNo: blank(b.contractNo),
      itemDiscipline: blank(b.itemDiscipline) ?? fromWr(c0?.discipline),
      facility: blank(b.facility) ?? fromWr(c0?.facility),
      zone: blank(b.zone) ?? fromWr(c0?.zone),
      buildingName: blank(b.buildingName) ?? w?.building_name ?? null,
    };
    const docs = [...new Set(b.docsRequired ?? [])];
    const created = await withTx(app.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mr:${scope.contractorId}`]);
      const no = (await c.query<{ n: number }>('SELECT COALESCE(max(mr_no), 0)::int + 1 AS n FROM material_request WHERE contractor_id = $1', [scope.contractorId])).rows[0]!.n;
      const r = await c.query<{ id: string }>(
        `INSERT INTO material_request (contractor_id, mr_no, work_request_id, date_requested, project_name, contract_no, item_discipline, facility, zone, building_name,
                                       purchase_type, purpose, additional_requirements, docs_required, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [scope.contractorId, no, w?.id ?? null, header.dateRequested, header.projectName, header.contractNo, header.itemDiscipline, header.facility, header.zone, header.buildingName,
          b.purchaseType, b.purpose, blank(b.additionalRequirements), docs, user.id],
      );
      const id = r.rows[0]!.id;
      await insertLines(c, scope.contractorId, id, w?.wr_code ?? null, b.purchaseType, b.lines);
      await c.query(`INSERT INTO material_request_history (contractor_id, material_request_id, from_status, to_status, note, user_id) VALUES ($1,$2,NULL,'submitted',NULL,$3)`, [scope.contractorId, id, user.id]);
      if (w) await sonuEvent(c, scope.contractorId, w.id, 'mr.submitted', { mrId: id, mrNo: no, note: `${mrCode(no)} · ${b.lines.length} ${b.lines.length === 1 ? 'line' : 'lines'}` }, user.id);
      await auditFromRequest(request, { action: 'mr.submit', entityType: 'material_request', entityId: id, summary: `${mrCode(no)}${w ? ` for WR ${w.wr_code}` : ''}`, details: { lines: b.lines.length } }, c);
      return { id, no };
    });
    await notify(app, {
      contractorId: scope.contractorId, event: 'mr.submitted', roles: ['purchasing'], title: `New ${mrCode(created.no)}${w ? ` for WR ${w.wr_code}` : ''}`,
      body: b.lines.map((l) => l.description).join('; ').slice(0, 160) || null, url: `/procurement/mr/${created.id}`,
      entityType: 'material_request', entityId: created.id, workRequestId: w?.id ?? null, channels: ['in_app', 'push'],
    });
    const { mr, access } = await loadMr(app.db, scope, created.id);
    return reply.status(201).send(await detailView(app.db, scope, mr, access));
  });

  // ───── list ─────
  app.get('/api/mr', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const q = z
      .object({
        status: z.string().max(200).optional(),
        wr: z.string().trim().max(40).optional(),
        mine: z.enum(['1', '0']).optional(),
        overdue: z.enum(['1', '0']).optional(),
        q: z.string().trim().max(100).optional(),
      })
      .parse(request.query);
    const { today } = await tzToday(scope.contractorId);
    const params: unknown[] = [scope.contractorId, today];
    const where = ['m.contractor_id = $1'];
    where.push(visibleSql(scope, params));
    const statuses = (q.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      if (statuses.some((s) => !(MR_STATUSES as readonly string[]).includes(s))) throw badRequest('Unknown status.');
      params.push(statuses);
      where.push(`m.status = ANY($${params.length}::text[])`);
    }
    if (q.wr) {
      params.push(q.wr);
      where.push(`w.wr_code = $${params.length}`);
    }
    if (q.mine === '1') {
      params.push(scope.user.id);
      where.push(`m.requested_by = $${params.length}`);
    }
    if (q.overdue === '1') where.push(`(m.status = ANY(ARRAY['${OVERDUE_STATUSES.join("','")}']) AND EXISTS (SELECT 1 FROM material_request_line l WHERE l.material_request_id = m.id AND l.target_date < $2::date))`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      params.push(like);
      const p = params.length;
      const digits = q.q.replace(/^mr[-\s]*/i, '');
      params.push(/^\d{1,9}$/.test(digits) ? Number(digits) : -1);
      where.push(`(w.wr_code ILIKE $${p} OR ('MR-' || m.mr_no) ILIKE $${p} OR m.mr_no = $${params.length}
                   OR EXISTS (SELECT 1 FROM material_request_line l WHERE l.material_request_id = m.id AND l.description ILIKE $${p}))`);
    }
    const r = await app.db.query<MrRow & { line_count: number; first_description: string | null; overdue: boolean }>(
      `SELECT m.*, w.wr_code, ur.full_name AS requested_by_name, ua.full_name AS assigned_to_name,
              (SELECT count(*)::int FROM material_request_line l WHERE l.material_request_id = m.id) AS line_count,
              (SELECT l.description FROM material_request_line l WHERE l.material_request_id = m.id ORDER BY l.line_no LIMIT 1) AS first_description,
              (m.status = ANY(ARRAY['${OVERDUE_STATUSES.join("','")}']) AND EXISTS (SELECT 1 FROM material_request_line l WHERE l.material_request_id = m.id AND l.target_date < $2::date)) AS overdue
         FROM material_request m
         LEFT JOIN work_request w ON w.id = m.work_request_id
         LEFT JOIN app_user ur ON ur.id = m.requested_by
         LEFT JOIN app_user ua ON ua.id = m.assigned_to
        WHERE ${where.join(' AND ')} ORDER BY m.mr_no DESC LIMIT 500`,
      params,
    );
    return {
      today,
      items: r.rows.map((m) => ({
        id: m.id, mrNo: m.mr_no, mrCode: mrCode(m.mr_no), status: m.status, statusLabel: MR_STATUS_LABELS[m.status], wrCode: m.wr_code, dateRequested: m.date_requested,
        purchaseType: m.purchase_type, purpose: m.purpose, lines: m.line_count, firstDescription: m.first_description, facility: m.facility, buildingName: m.building_name,
        requestedByName: m.requested_by_name, assignedToName: m.assigned_to_name, vendorName: m.vendor_name, quotedAmount: seesMoney(scope.user) ? m.quoted_amount : null,
        expectedDelivery: m.expected_delivery, overdue: m.overdue, updatedAt: m.updated_at,
      })),
    };
  });

  // ───── procurement summary ─────
  app.get('/api/procurement/summary', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { tz, today } = await tzToday(scope.contractorId);
    const params: unknown[] = [scope.contractorId, today, today.slice(0, 7), tz];
    const vis = visibleSql(scope, params);
    const r = await app.db.query<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE m.status = 'submitted')::int AS "new",
              count(*) FILTER (WHERE m.status = 'accepted')::int AS pending,
              count(*) FILTER (WHERE m.status = 'enquiry')::int AS enquiry,
              count(*) FILTER (WHERE m.status = 'quoted')::int AS quoted,
              count(*) FILTER (WHERE m.status = 'ordered')::int AS ordered,
              count(*) FILTER (WHERE m.status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE m.status = 'closed' AND to_char(m.closed_at AT TIME ZONE $4, 'YYYY-MM') = $3)::int AS "closedThisMonth",
              count(*) FILTER (WHERE m.status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE m.status = ANY(ARRAY['${OVERDUE_STATUSES.join("','")}'])
                                AND EXISTS (SELECT 1 FROM material_request_line l WHERE l.material_request_id = m.id AND l.target_date < $2::date))::int AS overdue
         FROM material_request m WHERE m.contractor_id = $1 AND ${vis}`,
      params,
    );
    return { ...r.rows[0], pettyCash: await pettyCashSummary(app.db, scope, tz, today.slice(0, 7)) };
  });

  // ───── detail ─────
  app.get('/api/mr/:id', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const { mr, access } = await loadMr(app.db, scope, id);
    return detailView(app.db, scope, mr, access);
  });

  // ───── edit header / lines while submitted ─────
  app.patch('/api/mr/:id', raisers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = patchBody.parse(request.body);
    const { mr, access } = await loadMr(app.db, scope, id);
    if (!access.canEdit) {
      if (mr.status !== 'submitted') throw conflict(`This request is already ${MR_STATUS_LABELS[mr.status].toLowerCase()}; it can no longer be edited.`);
      throw forbidden('Only the person who raised it, or a coordinator, can edit this request.');
    }
    const cols: Record<string, unknown> = {
      date_requested: b.dateRequested, project_name: b.projectName === undefined ? undefined : blank(b.projectName), contract_no: b.contractNo === undefined ? undefined : blank(b.contractNo),
      item_discipline: b.itemDiscipline === undefined ? undefined : blank(b.itemDiscipline), facility: b.facility === undefined ? undefined : blank(b.facility),
      zone: b.zone === undefined ? undefined : blank(b.zone), building_name: b.buildingName === undefined ? undefined : blank(b.buildingName),
      purchase_type: b.purchaseType, purpose: b.purpose, additional_requirements: b.additionalRequirements === undefined ? undefined : blank(b.additionalRequirements),
      docs_required: b.docsRequired === undefined ? undefined : [...new Set(b.docsRequired)],
    };
    const removed: { file_path: string }[] = [];
    await withTx(app.db, async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(cols)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      const upd = await c.query(`UPDATE material_request SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 AND status = 'submitted'`, params);
      if (!upd.rowCount) throw conflict('This request is no longer new; it cannot be edited.');
      if (b.lines) {
        const have = (await c.query<{ id: string }>('SELECT id FROM material_request_line WHERE material_request_id = $1', [id])).rows.map((x) => x.id);
        const keep = new Set(b.lines.map((l) => l.id).filter((x): x is string => Boolean(x)));
        for (const k of keep) if (!have.includes(k)) throw badRequest('A line does not belong to this request.');
        const drop = have.filter((x) => !keep.has(x));
        if (drop.length) {
          const a = await c.query<{ file_path: string }>(`DELETE FROM attachment WHERE contractor_id = $1 AND owner_type = 'mr_line' AND owner_id = ANY($2::uuid[]) RETURNING file_path`, [scope.contractorId, drop]);
          removed.push(...a.rows);
          await c.query('DELETE FROM material_request_line WHERE id = ANY($1::uuid[])', [drop]);
        }
        const type = b.purchaseType ?? mr.purchase_type;
        // Park existing numbers out of the way, then renumber in the order given.
        await c.query('UPDATE material_request_line SET line_no = -line_no - 1000 WHERE material_request_id = $1', [id]);
        let n = 1;
        for (const l of b.lines) {
          if (l.id) {
            await c.query(
              `UPDATE material_request_line SET line_no = $2, wr_code = $3, store_sl_no = $4, client_mat_ref = $5, description = $6, quantity = $7, uom = $8, brand = $9, kind = $10,
                      vendor_origin = $11, claimable = $12, target_date = $13, remarks = $14 WHERE id = $1`,
              [l.id, n++, blank(l.wrCode) ?? mr.wr_code, blank(l.storeSlNo), blank(l.clientMatRef), l.description, l.quantity, blank(l.uom), blank(l.brand),
                l.kind ?? (type === 'services' ? 'service' : 'material'), l.vendorOrigin ?? null, l.claimable ?? null, l.targetDate ?? null, blank(l.remarks)],
            );
          } else {
            await insertLines(c, scope.contractorId, id, mr.wr_code, type, [l], n++);
          }
        }
      }
      await auditFromRequest(request, { action: 'mr.update', entityType: 'material_request', entityId: id, summary: mrCode(mr.mr_no), details: { lines: b.lines?.length ?? null } }, c);
    });
    const root = path.resolve(app.config.uploadDir);
    for (const f of removed) {
      const full = path.resolve(root, f.file_path);
      if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    }
    const fresh = await loadMr(app.db, scope, id);
    return detailView(app.db, scope, fresh.mr, fresh.access);
  });

  // ───── status ─────
  app.post('/api/mr/:id/status', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = z.object({ to: z.enum(MR_STATUSES), note: z.string().trim().max(1000).nullish() }).strict().parse(request.body);
    const { mr, access } = await loadMr(app.db, scope, id);
    if (!(LEGAL[mr.status] ?? []).includes(b.to)) {
      throw conflict(`This request is ${MR_STATUS_LABELS[mr.status].toLowerCase()}; it cannot move to ${MR_STATUS_LABELS[b.to].toLowerCase()}.`);
    }
    if (!targetsFor(mr, access).includes(b.to)) throw forbidden('You cannot make this change.');
    const note = blank(b.note);
    if (b.to === 'rejected' && !note) throw badRequest('Say why the request is rejected.');
    const user = scope.user;
    await withTx(app.db, async (c) => {
      const r = await c.query(
        `UPDATE material_request SET status = $2, updated_at = now(), closed_at = CASE WHEN $2 = 'closed' THEN $5::timestamptz ELSE closed_at END,
                assigned_to = CASE WHEN $2 = 'accepted' AND assigned_to IS NULL THEN $4::uuid ELSE assigned_to END
          WHERE id = $1 AND status = $3`,
        [id, b.to, mr.status, access.canProcure ? user.id : null, app.opsClock.now()],
      );
      if (!r.rowCount) throw conflict('The request changed while you were looking at it. Reload and try again.');
      await c.query(
        `INSERT INTO material_request_history (contractor_id, material_request_id, from_status, to_status, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [scope.contractorId, id, mr.status, b.to, note, user.id],
      );
      if (mr.work_request_id) {
        await sonuEvent(c, scope.contractorId, mr.work_request_id, 'mr.status', {
          mrId: id, mrNo: mr.mr_no, from: mr.status, to: b.to, note: `${mrCode(mr.mr_no)}: ${MR_STATUS_LABELS[mr.status]} → ${MR_STATUS_LABELS[b.to]}${note ? ` · ${note}` : ''}`,
        }, user.id);
      }
      await auditFromRequest(request, { action: `mr.${b.to}`, entityType: 'material_request', entityId: id, summary: `${mrCode(mr.mr_no)}: ${mr.status} -> ${b.to}`, details: { note } }, c);
    });
    if (mr.requested_by && mr.requested_by !== user.id) {
      await notify(app, {
        contractorId: scope.contractorId, event: 'mr.status', recipients: [mr.requested_by], title: `${mrCode(mr.mr_no)}: ${MR_STATUS_LABELS[b.to]}`,
        body: note, url: `/procurement/mr/${id}`, entityType: 'material_request', entityId: id, workRequestId: mr.work_request_id, channels: ['in_app', 'push'],
      });
    }
    const fresh = await loadMr(app.db, scope, id);
    return detailView(app.db, scope, fresh.mr, fresh.access);
  });

  // ───── procurement fields ─────
  app.patch('/api/mr/:id/procurement', procurers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const b = procurementBody.parse(request.body);
    const { mr, access } = await loadMr(app.db, scope, id);
    if (!access.canProcure) throw forbidden();
    if (mr.status === 'cancelled' || mr.status === 'rejected') throw conflict(`This request is ${mr.status}; procurement details can no longer change.`);
    if (b.assignedTo) {
      const u = (await app.db.query<{ role: Role; status: string }>('SELECT role, status FROM app_user WHERE id = $1 AND contractor_id = $2', [b.assignedTo, scope.contractorId])).rows[0];
      if (!u || u.status !== 'active' || !PROC_ROLES.includes(u.role)) throw badRequest('Assign it to an active purchasing, coordinator or manager user of your company.');
    }
    const cols: Record<string, unknown> = {
      assigned_to: b.assignedTo, vendor_name: b.vendorName === undefined ? undefined : blank(b.vendorName), vendor_contact: b.vendorContact === undefined ? undefined : blank(b.vendorContact),
      quotation_ref: b.quotationRef === undefined ? undefined : blank(b.quotationRef), quoted_amount: b.quotedAmount, expected_delivery: b.expectedDelivery,
      procurement_remarks: b.procurementRemarks === undefined ? undefined : blank(b.procurementRemarks),
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('Nothing to change.');
    await withTx(app.db, async (c) => {
      await c.query(`UPDATE material_request SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, params);
      await auditFromRequest(request, { action: 'mr.procurement', entityType: 'material_request', entityId: id, summary: mrCode(mr.mr_no), details: { fields: Object.keys(b) } }, c);
    });
    const fresh = await loadMr(app.db, scope, id);
    return detailView(app.db, scope, fresh.mr, fresh.access);
  });

  // ───── files: line photos and documents ─────
  app.post('/api/mr/:id/attachments', viewers, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { id } = idParam.parse(request.params);
    const { mr, access } = await loadMr(app.db, scope, id);
    if (!access.canUpload) throw TERMINAL.includes(mr.status) ? conflict(`This request is ${mr.status}; files can no longer be added.`) : forbidden('You cannot add files to this request.');
    const { fields, raw } = await readUploadForm(app, request);
    const kind = z.enum(['line', 'doc']).parse(fields.kind);
    let lineId: string | null = null;
    let docKind: string | null = null;
    if (kind === 'line') {
      lineId = z.string().uuid('Choose the line the photo belongs to.').parse(fields.lineId);
      const ok = await app.db.query('SELECT 1 FROM material_request_line WHERE id = $1 AND material_request_id = $2', [lineId, id]);
      if (!ok.rows.length) throw notFound('Line not found.');
    } else {
      docKind = z.enum(DOC_KINDS, 'Choose the document type.').parse(fields.docKind);
    }
    if (!raw.length) throw badRequest('Choose at least one file.');
    const ownerType = kind === 'line' ? 'mr_line' : 'mr_doc';
    const ownerId = kind === 'line' ? lineId! : id;
    const have = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM attachment WHERE contractor_id = $1 AND owner_type = $2 AND owner_id = $3`, [scope.contractorId, ownerType, ownerId])).rows[0]!.n;
    const max = kind === 'line' ? MAX_LINE_PHOTOS : MAX_DOCS;
    if (have + raw.length > max) throw badRequest(kind === 'line' ? `At most ${MAX_LINE_PHOTOS} photos per line.` : `At most ${MAX_DOCS} documents per request.`);
    const saved: Upload[] = [];
    try {
      const dir = path.join(app.config.uploadDir, scope.contractorId);
      for (const f of raw) {
        const t = fileKind(f.buf, kind === 'doc');
        if (!t) throw new AppError(415, 'unsupported_file', kind === 'doc' ? 'Only JPEG, PNG, WebP or PDF files can be uploaded.' : 'Only JPEG, PNG or WebP photos can be uploaded.');
        await fsp.mkdir(dir, { recursive: true });
        const fid = crypto.randomUUID();
        const rel = `${scope.contractorId}/${fid}.${t.ext}`;
        await fsp.writeFile(path.join(app.config.uploadDir, rel), f.buf, { flag: 'wx' });
        saved.push({ rel, mime: t.mime, size: f.buf.length, sha256: crypto.createHash('sha256').update(f.buf).digest('hex'), name: safeName(f.name, t.ext, `${kind === 'line' ? 'photo' : docKind}-${fid.slice(0, 8)}`) });
      }
      const out = await withTx(app.db, async (c) => {
        const ids: FileView[] = [];
        for (const p of saved) {
          const r = await c.query<{ id: string }>(
            `INSERT INTO attachment (contractor_id, owner_type, owner_id, work_request_id, file_path, file_name, mime, size_bytes, sha256, uploaded_by, doc_kind)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [scope.contractorId, ownerType, ownerId, mr.work_request_id, p.rel, p.name, p.mime, p.size, p.sha256, scope.user.id, docKind],
          );
          ids.push({ id: r.rows[0]!.id, fileName: p.name, mime: p.mime, docKind });
        }
        await c.query('UPDATE material_request SET updated_at = now() WHERE id = $1', [id]);
        await auditFromRequest(request, { action: 'mr.attach', entityType: 'material_request', entityId: id, summary: mrCode(mr.mr_no), details: { kind, docKind, files: saved.length } }, c);
        return ids;
      });
      return reply.status(201).send({ attachments: out });
    } catch (err) {
      await removeUploads(app, saved);
      throw err;
    }
  });

  app.delete('/api/mr/:id/attachments/:attId', viewers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id, attId } = z.object({ id: z.string().uuid(), attId: z.string().uuid() }).parse(request.params);
    const { mr, access } = await loadMr(app.db, scope, id);
    const a = (await app.db.query<{ id: string; owner_type: string; owner_id: string; uploaded_by: string | null; file_path: string }>(
      `SELECT t.id, t.owner_type, t.owner_id, t.uploaded_by, t.file_path FROM attachment t
        WHERE t.id = $1 AND t.contractor_id = $2
          AND ((t.owner_type = 'mr_doc' AND t.owner_id = $3)
               OR (t.owner_type = 'mr_line' AND t.owner_id IN (SELECT l.id FROM material_request_line l WHERE l.material_request_id = $3)))`,
      [attId, scope.contractorId, id],
    )).rows[0];
    if (!a) throw notFound('File not found.');
    if (TERMINAL.includes(mr.status)) throw conflict(`This request is ${mr.status}; files can no longer be removed.`);
    const isCoord = ALL_SEEING.includes(scope.user.role);
    if (!access.canUpload || (!isCoord && a.uploaded_by !== scope.user.id)) throw forbidden('Only the person who added it, or a coordinator, can remove a file.');
    await withTx(app.db, async (c) => {
      await c.query('DELETE FROM attachment WHERE id = $1', [attId]);
      await auditFromRequest(request, { action: 'mr.detach', entityType: 'material_request', entityId: id, summary: mrCode(mr.mr_no), details: { attachmentId: attId } }, c);
    });
    const root = path.resolve(app.config.uploadDir);
    const full = path.resolve(root, a.file_path);
    if (full.startsWith(root + path.sep)) await fsp.rm(full, { force: true }).catch(() => undefined);
    return { ok: true };
  });
}
