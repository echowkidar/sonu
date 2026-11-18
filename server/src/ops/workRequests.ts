/** Routes: work-request list / detail / changes / bulk, meta, dashboard, my work, exports (Master workbook, RFE file). */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildMasterRows,
  CONTRACTOR_STATUSES,
  EXPORTS,
  isCompleted,
  LIST_KEYS,
  RfeValidationError,
  summarise,
  writeMasterWorkbook,
  writeRfeWorkbook,
  type ComputedColumns,
  type SummaryRow,
  type TypedRow,
} from '@sonu/core';
import { auditFromRequest } from '../audit.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { CONTRACTOR_ROLES, ROLE_LABELS } from '../auth/roles.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { notify } from '../notifications/index.js';
import type { AuthUser } from '../types.js';
import { purchasesFor, zeroRfeReport } from './zeroRfe.js';
import { materialRequestsFor } from './material.js';
import {
  computedFor,
  deadlineFor,
  effectiveStage,
  inTeams,
  loadComputeContext,
  scopeOf,
  scopeSql,
  seesMoney,
  seesRequestor,
  sqlDateOut,
  stageNo,
  suggestedFor,
  WR_SELECT,
  type ComputeContext,
  type DeadlineView,
  type Scope,
  type WrRow,
} from './context.js';

export const ALL_SEEING = ['coordinator', 'manager', 'contractor_admin'] as const;
const STATUS_NAMES = CONTRACTOR_STATUSES.map((s) => s.name) as string[];
const CRITERIA = [
  { value: 1, label: 'Criterion 1 - zero cost' },
  { value: 2, label: 'Criterion 2 - below QR 100' },
  { value: 3, label: 'Criterion 3 - estimate needed' },
  { value: 4, label: 'Criterion 4 - new requirement' },
];
const STAGE_LABELS: Record<number, string> = {
  2: '2. SP : Awaiting Site Survey & Estimation',
  3: '3. QF : Awaiting Estimation Approval',
  4: '4. SP : Awaiting Estimation Re-Submission',
  5: '5. SP : Estimation Approved & AMC & WIP',
  6: '6. In Progress',
  7: '7. SP: WR Closeout Returned',
  8: '8. QF : Contractor Completed',
};

export async function loadWrs(db: Queryable, scope: Scope, opts: { includeGone?: boolean; code?: string } = {}): Promise<WrRow[]> {
  const params: unknown[] = [scope.contractorId];
  const where = ['w.contractor_id = $1'];
  if (!opts.includeGone) where.push('w.gone_at IS NULL');
  if (opts.code) {
    params.push(opts.code);
    where.push(`w.wr_code = $${params.length}`);
  }
  where.push(scopeSql(scope, params));
  const r = await db.query<WrRow>(`${WR_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.wr_code`, params);
  return r.rows;
}

export interface WrView {
  id: string;
  wrCode: string;
  [k: string]: unknown;
  computed: ComputedColumns;
  deadline: DeadlineView | null;
}

export function wrView(w: WrRow, ctx: ComputeContext, user: AuthUser): WrView {
  const computed = computedFor(w, ctx);
  const money = seesMoney(user);
  return {
    id: w.id,
    wrCode: w.wr_code,
    wrStatus: w.wr_status,
    descriptiveStatus: w.descriptive_status,
    qfStage: effectiveStage(w),
    marafiqStage: stageNo(w.descriptive_status),
    srCode: w.sr_code,
    woCode: w.wo_code,
    ptwCode: w.ptw_code,
    ptwStatus: w.ptw_status,
    requestor: seesRequestor(user) ? w.requestor_name : undefined,
    siteCode: w.site_code,
    siteName: w.site_name,
    buildingCode: w.building_code,
    buildingName: w.building_name,
    floorCode: w.floor_code,
    roomCode: w.room_code,
    equipmentCode: w.equipment_code,
    problemType: w.problem_type,
    problemTypeDescription: w.problem_type_description,
    workTeamCode: w.work_team_code,
    priority: w.priority,
    description: w.description,
    dateRequested: w.date_requested,
    targetDate: w.agreed_target_date,
    dateTradeAssigned: w.date_trade_assigned,
    dateToPerform: w.date_to_perform,
    estimatedTotalCost: money ? w.est_total_cost : undefined,
    withRfe: w.with_rfe,
    progressPct: w.progress_pct,
    closureComments: w.closure_comments,
    firstSeenAt: w.first_seen_at,
    lastSeenAt: w.last_seen_at,
    goneAt: w.gone_at,
    internal: {
      ownerId: w.owner_id,
      ownerName: w.owner_name,
      criterion: w.criterion,
      contractorStatus: w.contractor_status,
      fcRemarks: w.fc_remarks,
      statusSource: w.status_source,
      dueAt: w.due_at,
      breachLevel: w.breach_level ?? 0,
      zeroRfe: w.zero_rfe_at
        ? { at: w.zero_rfe_at, byName: w.zero_rfe_by_name, amount: money ? w.zero_rfe_amount : null, note: w.zero_rfe_note }
        : null,
    },
    computed,
    deadline: deadlineFor(w, ctx),
    suggestedStatus: suggestedFor(w, ctx),
  };
}

const csv = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
const normStatus = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** In Progress: open WR whose Marafiq status is "Issued and In Process", or that was converted to 0 RFE. */
export function isInProgress(v: WrView): boolean {
  // Contractor's rule: a WR stays "Assigned to Work Order" until its estimate is settled. It is in progress only when
  // it was closed at 0 (0 RFE in SONU, or issued without cost in Marafiq) or QF approved the RFE / budget.
  if (isCompleted(v.wrStatus)) return false;
  if ((v.internal as { zeroRfe: unknown }).zeroRfe) return true;
  return v.computed.rfeStatus === 'RFE Approved' || v.computed.rfeStatus === 'RFE Not Required';
}

/** Priority request: open WR whose target date is today up to today + `days` days (inclusive). Breached / no target date: no. */
export function isPriorityRequest(v: WrView, days = 10): boolean {
  if (isCompleted(v.wrStatus)) return false;
  const d = v.computed.daysToBreach;
  return typeof d === 'number' && d <= 0 && d >= -days;
}

export interface LocationFilter { facility?: string; building?: string; zone?: string; discipline?: string }
const eqCi = (a: unknown, b: string) => String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Dashboard location filter (case-insensitive exact match on the computed values; building on the building name). */
export function locationMatcher(ctx: ComputeContext, f: LocationFilter): (w: WrRow) => boolean {
  return (w) => {
    if (!f.facility && !f.building && !f.zone && !f.discipline) return true;
    const c = computedFor(w, ctx);
    return (!f.facility || eqCi(c.facility, f.facility)) && (!f.zone || eqCi(c.zone, f.zone)) && (!f.discipline || eqCi(c.discipline, f.discipline))
      && (!f.building || eqCi(w.building_name, f.building));
  };
}

const listQuery = z.object({
  q: z.string().max(200).optional(),
  building: z.string().max(1000).optional(),
  inProgress: z.enum(['1', 'true']).optional(),
  tdWithin: z.coerce.number().int().min(0).max(60).optional(),
  zone: z.string().max(500).optional(),
  discipline: z.string().max(500).optional(),
  facility: z.string().max(1000).optional(),
  wrStatus: z.string().max(500).optional(),
  contractorStatus: z.string().max(2000).optional(),
  owner: z.string().max(200).optional(),
  criterion: z.string().max(20).optional(),
  tdStatus: z.string().max(100).optional(),
  kpi: z.string().max(100).optional(),
  ageBucket: z.string().max(200).optional(),
  rfeTimeFrame: z.string().max(100).optional(),
  workTeam: z.string().max(500).optional(),
  qfStage: z.string().max(40).optional(),
  breach: z.enum(['0', '1', '2']).optional(),
  unowned: z.enum(['1', 'true']).optional(),
  mine: z.enum(['1', 'true']).optional(),
  includeGone: z.enum(['1', 'true']).optional(),
  sort: z.string().max(40).default('wrCode'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(2000).default(100),
});

const SORTS: Record<string, (v: WrView) => string | number | null> = {
  wrCode: (v) => v.wrCode,
  dateRequested: (v) => v.dateRequested as string | null,
  targetDate: (v) => v.targetDate as string | null,
  dateTradeAssigned: (v) => v.dateTradeAssigned as string | null,
  wrStatus: (v) => v.wrStatus as string | null,
  buildingName: (v) => v.buildingName as string | null,
  workTeamCode: (v) => v.workTeamCode as string | null,
  estimatedTotalCost: (v) => (v.estimatedTotalCost as number | null | undefined) ?? null,
  contractorStatus: (v) => (v.internal as { contractorStatus: string | null }).contractorStatus,
  owner: (v) => (v.internal as { ownerName: string | null }).ownerName,
  criterion: (v) => (v.internal as { criterion: number | null }).criterion,
  daysToBreach: (v) => (typeof v.computed.daysToBreach === 'number' ? v.computed.daysToBreach : null),
  daysSinceRequested: (v) => v.computed.daysSinceRequested,
  zone: (v) => v.computed.zone,
  discipline: (v) => v.computed.discipline,
  facility: (v) => v.computed.facility,
  deadline: (v) => v.deadline?.dueDate ?? null,
};

function cmp(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

export async function filteredViews(app: FastifyInstance, scope: Scope, ctx: ComputeContext, query: z.infer<typeof listQuery>): Promise<WrView[]> {
  const rows = await loadWrs(app.db, scope, { includeGone: Boolean(query.includeGone) });
  let views = rows.map((w) => wrView(w, ctx, scope.user));
  const inSet = (vals: string[] | null, v: unknown) => !vals || vals.map((x) => x.toLowerCase()).includes(String(v ?? '').toLowerCase());
  const q = query.q?.trim().toLowerCase();
  const own = (v: WrView) => v.internal as { ownerId: string | null; criterion: number | null; contractorStatus: string | null };
  const f = {
    building: csv(query.building), zone: csv(query.zone), discipline: csv(query.discipline), facility: csv(query.facility), wrStatus: csv(query.wrStatus),
    contractorStatus: csv(query.contractorStatus), tdStatus: csv(query.tdStatus), kpi: csv(query.kpi), ageBucket: csv(query.ageBucket),
    rfeTimeFrame: csv(query.rfeTimeFrame), workTeam: csv(query.workTeam), criterion: csv(query.criterion), qfStage: csv(query.qfStage),
  };
  views = views.filter((v) => {
    if (q && ![v.wrCode, v.buildingName, v.buildingCode, v.description, v.siteName, v.roomCode].some((x) => String(x ?? '').toLowerCase().includes(q))) return false;
    if (!inSet(f.zone, v.computed.zone) || !inSet(f.discipline, v.computed.discipline) || !inSet(f.facility, v.computed.facility)) return false;
    if (!inSet(f.building, v.buildingName)) return false;
    if (query.inProgress && !isInProgress(v)) return false;
    if (query.tdWithin !== undefined && !isPriorityRequest(v, query.tdWithin)) return false;
    if (!inSet(f.wrStatus, v.wrStatus) || !inSet(f.tdStatus, v.computed.tdStatus) || !inSet(f.kpi, v.computed.kpi)) return false;
    if (!inSet(f.ageBucket, v.computed.month) || !inSet(f.rfeTimeFrame, v.computed.rfeTimeFrameKind) || !inSet(f.workTeam, v.workTeamCode)) return false;
    if (f.contractorStatus && !inSet(f.contractorStatus, own(v).contractorStatus ?? '(none)')) return false;
    if (f.criterion && !inSet(f.criterion, own(v).criterion ?? 'none')) return false;
    if (f.qfStage && !inSet(f.qfStage, v.qfStage ?? 'none')) return false;
    if (query.owner && (query.owner === 'none' ? own(v).ownerId !== null : own(v).ownerId !== query.owner)) return false;
    if (query.unowned && own(v).ownerId !== null) return false;
    if (query.mine && own(v).ownerId !== scope.user.id) return false;
    if (query.breach !== undefined) {
      const lvl = v.deadline ? (v.deadline.breached ? 2 : v.deadline.state === 'amber' ? 1 : 0) : 0;
      if (String(lvl) !== query.breach) return false;
    }
    return true;
  });
  const key = SORTS[query.sort] ?? SORTS.wrCode!;
  views.sort((a, b) => cmp(key(a), key(b)) * (query.dir === 'desc' ? -1 : 1) || cmp(a.wrCode, b.wrCode));
  return views;
}

export async function findWr(app: FastifyInstance, scope: Scope, code: string): Promise<WrRow> {
  const rows = await loadWrs(app.db, scope, { includeGone: true, code });
  if (!rows[0]) throw notFound('Work request not found.');
  return rows[0];
}

export async function ensureInternal(db: Queryable, contractorId: string, wrId: string): Promise<void> {
  await db.query('INSERT INTO wr_internal (contractor_id, work_request_id) VALUES ($1,$2) ON CONFLICT (work_request_id) DO NOTHING', [contractorId, wrId]);
}

export async function sonuEvent(db: Queryable, contractorId: string, wrId: string, type: string, payload: unknown, userId: string) {
  await db.query(`INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, user_id) VALUES ($1,$2,$3,'sonu',$4,$5)`, [
    contractorId, wrId, type, JSON.stringify(payload), userId,
  ]);
}

const OWNER_ROLES = ['supervisor', 'foreman', 'coordinator', 'manager', 'contractor_admin'];

async function checkOwner(db: Queryable, contractorId: string, ownerId: string): Promise<{ id: string; full_name: string }> {
  const r = await db.query<{ id: string; full_name: string; role: string; status: string }>(
    'SELECT id, full_name, role, status FROM app_user WHERE id = $1 AND contractor_id = $2',
    [ownerId, contractorId],
  );
  const u = r.rows[0];
  if (!u || u.status !== 'active' || !OWNER_ROLES.includes(u.role)) throw badRequest('The owner must be an active supervisor, foreman, coordinator or manager of your company.');
  return u;
}

export default async function workRequestRoutes(app: FastifyInstance): Promise<void> {
  const contractorUsers = { preHandler: requireRole(...CONTRACTOR_ROLES) };
  const noTechnicians = { preHandler: requireRole('contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman') };

  // ───── list ─────
  app.get('/api/work-requests', contractorUsers, async (request) => {
    const scope = await scopeOf(app, request);
    const query = listQuery.parse(request.query);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    const views = await filteredViews(app, scope, ctx, query);
    const start = (query.page - 1) * query.pageSize;
    return { today: ctx.today, rfeLimitDays: ctx.rfeLimitDays, total: views.length, page: query.page, pageSize: query.pageSize, items: views.slice(start, start + query.pageSize) };
  });

  // ───── detail ─────
  app.get('/api/work-requests/:code', contractorUsers, async (request) => {
    const scope = await scopeOf(app, request);
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(request.params);
    const w = await findWr(app, scope, code);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    const view = wrView(w, ctx, scope.user);
    const db = app.db;
    const cid = scope.contractorId;
    const events = await db.query(
      `SELECT e.id, e.type, e.source, e.payload, e.at, e.import_batch_id AS "importBatchId", u.full_name AS "userName"
         FROM wr_event e LEFT JOIN app_user u ON u.id = e.user_id WHERE e.contractor_id = $1 AND e.work_request_id = $2`,
      [cid, w.id],
    );
    const stages = await db.query(
      `SELECT h.id, h.source, h.from_stage AS "fromStage", h.to_stage AS "toStage", h.at, u.full_name AS "userName"
         FROM wr_stage_history h LEFT JOIN app_user u ON u.id = h.user_id WHERE h.contractor_id = $1 AND h.work_request_id = $2`,
      [cid, w.id],
    );
    const assignments = await db.query(
      `SELECT a.id, a.status, a.planned_date AS "plannedDate", a.note, a.created_at AS "createdAt",
              a.started_at AS "startedAt", a.done_at AS "doneAt", a.assignee_id AS "assigneeId", ua.full_name AS "assigneeName", ub.full_name AS "assignedByName"
         FROM assignment a JOIN app_user ua ON ua.id = a.assignee_id LEFT JOIN app_user ub ON ub.id = a.assigned_by
        WHERE a.contractor_id = $1 AND a.work_request_id = $2 ORDER BY a.created_at`,
      [cid, w.id],
    );
    const updates = await db.query(
      `SELECT j.id, j.assignment_id AS "assignmentId", j.note, j.status_to AS "statusTo", j.at, u.full_name AS "userName"
         FROM job_update j JOIN assignment a ON a.id = j.assignment_id LEFT JOIN app_user u ON u.id = j.user_id
        WHERE j.contractor_id = $1 AND a.work_request_id = $2`,
      [cid, w.id],
    );
    const timeline = [
      ...events.rows.map((e: Record<string, unknown>) => ({ kind: 'event', at: e.at, type: e.type, source: e.source, payload: e.payload, userName: e.userName, id: e.id })),
      ...stages.rows.map((s: Record<string, unknown>) => ({ kind: 'stage', at: s.at, type: 'stage', source: s.source, payload: { from: s.fromStage, to: s.toStage }, userName: s.userName, id: s.id })),
      // Assignments are already on the timeline as their 'job.assigned' wr_event; listing them again duplicated them.
      ...updates.rows.map((u: Record<string, unknown>) => ({ kind: 'job_update', at: u.at, type: u.statusTo ? `job.${u.statusTo}` : 'job.update', source: 'sonu', payload: { assignmentId: u.assignmentId, note: u.note }, userName: u.userName, id: u.id })),
    ].sort((a, b) => new Date(a.at as string).getTime() - new Date(b.at as string).getTime());
    const attachments = await db.query(
      `SELECT id, owner_type AS "ownerType", owner_id AS "ownerId", file_name AS "fileName", mime, size_bytes AS "sizeBytes", created_at AS "createdAt"
         FROM attachment WHERE contractor_id = $1 AND work_request_id = $2 ORDER BY created_at`,
      [cid, w.id],
    );
    const money = seesMoney(scope.user);
    const rfe = await db.query(
      `SELECT ${sqlDateOut('submitted_on')} AS "submittedOn", ${sqlDateOut('approved_on')} AS "approvedOn", pending_with AS "pendingWith",
              ${money ? 'rfe_amount' : 'NULL'} AS "rfeAmount", bpa_release_ref AS "bpaReleaseRef"
         FROM rfe_status WHERE contractor_id = $1 AND wr_code = $2`,
      [cid, w.wr_code],
    );
    const comments = await db.query(
      `SELECT id, log_id AS "logId", text, created_by_name AS "createdBy", ${sqlDateOut('created_on')} AS "createdOn", send_to AS "sendTo",
              is_done AS "isDone", answered_in_sonu_at AS "answeredInSonuAt"
         FROM rfe_comment WHERE contractor_id = $1 AND wr_code = $2 ORDER BY created_on, log_id`,
      [cid, w.wr_code],
    );
    const permit = w.ptw_code
      ? (await db.query(
          `SELECT ptw_code AS "ptwCode", status, ${sqlDateOut('date_start')} AS "dateStart", ${sqlDateOut('date_upto')} AS "dateUpto",
                  ${sqlDateOut('date_issued')} AS "dateIssued", applicant, controller, authority
             FROM permit WHERE contractor_id = $1 AND ptw_code = $2`,
          [cid, w.ptw_code],
        )).rows[0] ?? null
      : null;
    const moneyTrail = money
      ? (await db.query(
          `SELECT demand_note AS "demandNote", pr_no AS "prNo", ${sqlDateOut('pr_date')} AS "prDate", pr_status AS "prStatus", po_no AS "poNo",
                  ${sqlDateOut('po_date')} AS "poDate", po_status AS "poStatus", wcc_no AS "wccNo", ${sqlDateOut('wcc_date')} AS "wccDate",
                  wcc_status AS "wccStatus", invoice_no AS "invoiceNo", invoice_status AS "invoiceStatus", raw
             FROM money_trail WHERE contractor_id = $1 AND wr_code = $2`,
          [cid, w.wr_code],
        )).rows[0] ?? null
      : undefined;
    const localPurchases = await purchasesFor(db, cid, [w.id], money);
    const materialRequests = await materialRequestsFor(db, scope, w.id);
    return {
      ...view,
      today: ctx.today,
      marafiqUrl: `${ctx.portalBase}/archibus/gc-qf-ab-wr-console-report-details.axvw?wr.wr_id=${encodeURIComponent(w.wr_code)}`,
      timeline,
      assignments: assignments.rows,
      attachments: attachments.rows,
      rfe: rfe.rows[0] ?? null,
      rfeComments: comments.rows,
      permit,
      moneyTrail,
      localPurchases: localPurchases.get(w.id) ?? [],
      materialRequests,
    };
  });

  // ───── change owner / criterion / contractor status / remarks ─────
  const patchBody = z
    .object({
      takeOwnership: z.literal(true).optional(),
      ownerId: z.string().uuid().nullable().optional(),
      criterion: z.number().int().min(1).max(4).nullable().optional(),
      contractorStatus: z.string().nullable().optional().refine((v) => v === undefined || v === null || STATUS_NAMES.includes(v), 'Not one of the contractor statuses.'),
      fcRemarks: z.string().trim().max(2000).nullable().optional(),
    })
    .strict();

  app.patch('/api/work-requests/:code', { preHandler: requireRole('supervisor', 'foreman', ...ALL_SEEING) }, async (request) => {
    const scope = await scopeOf(app, request);
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(request.params);
    const body = patchBody.parse(request.body);
    const w = await findWr(app, scope, code);
    const user = scope.user;
    const allSeeing = (ALL_SEEING as readonly string[]).includes(user.role);
    const isOwner = w.owner_id === user.id;
    if (!allSeeing && !isOwner && !inTeams(scope, w.work_team_code)) throw forbidden();
    if (body.ownerId !== undefined && !allSeeing) throw forbidden('Only a coordinator or manager can set the owner. Use "take ownership".');
    if (body.takeOwnership && user.role === 'foreman') throw forbidden('A foreman cannot own a work request.');
    if (!allSeeing && !isOwner && (body.criterion !== undefined || body.contractorStatus !== undefined || body.fcRemarks !== undefined) && !body.takeOwnership) {
      throw forbidden('Take ownership first.');
    }
    let notifyOwner: string | null = null;
    await withTx(app.db, async (c) => {
      await ensureInternal(c, scope.contractorId, w.id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      let newOwner: string | null | undefined;
      if (body.takeOwnership) newOwner = user.id;
      if (body.ownerId !== undefined) newOwner = body.ownerId;
      if (newOwner !== undefined && newOwner !== w.owner_id) {
        if (newOwner) await checkOwner(c, scope.contractorId, newOwner);
        await c.query('UPDATE wr_internal SET owner_id = $2, updated_by = $3, updated_at = now() WHERE work_request_id = $1', [w.id, newOwner, user.id]);
        await sonuEvent(c, scope.contractorId, w.id, 'wr.owner_changed', { from: w.owner_id, to: newOwner, by: body.takeOwnership ? 'take_ownership' : 'set' }, user.id);
        await c.query(
          `INSERT INTO wr_stage_history (contractor_id, work_request_id, source, from_stage, to_stage, user_id) VALUES ($1,$2,'sonu',$3,$4,$5)`,
          [scope.contractorId, w.id, w.owner_id ? 'owned' : 'new', newOwner ? 'owned' : 'new', user.id],
        );
        changes.owner = { from: w.owner_id, to: newOwner };
        if (newOwner && newOwner !== user.id) notifyOwner = newOwner;
      }
      if (body.criterion !== undefined && body.criterion !== w.criterion) {
        await c.query('UPDATE wr_internal SET criterion = $2, updated_by = $3, updated_at = now() WHERE work_request_id = $1', [w.id, body.criterion, user.id]);
        await sonuEvent(c, scope.contractorId, w.id, 'wr.criterion_set', { from: w.criterion, to: body.criterion }, user.id);
        changes.criterion = { from: w.criterion, to: body.criterion };
      }
      if (body.contractorStatus !== undefined && body.contractorStatus !== w.contractor_status) {
        await c.query(`UPDATE wr_internal SET contractor_status = $2, status_source = 'manual', updated_by = $3, updated_at = now() WHERE work_request_id = $1`, [w.id, body.contractorStatus, user.id]);
        await sonuEvent(c, scope.contractorId, w.id, 'wr.status_set', { from: w.contractor_status, to: body.contractorStatus }, user.id);
        changes.contractorStatus = { from: w.contractor_status, to: body.contractorStatus };
      }
      if (body.fcRemarks !== undefined && (body.fcRemarks || null) !== w.fc_remarks) {
        await c.query('UPDATE wr_internal SET fc_remarks = $2, updated_by = $3, updated_at = now() WHERE work_request_id = $1', [w.id, body.fcRemarks || null, user.id]);
        await sonuEvent(c, scope.contractorId, w.id, 'wr.remarks_set', { from: w.fc_remarks, to: body.fcRemarks || null }, user.id);
        changes.fcRemarks = { from: w.fc_remarks, to: body.fcRemarks || null };
      }
      if (Object.keys(changes).length) {
        await auditFromRequest(request, { action: 'work_request.update', entityType: 'work_request', entityId: w.wr_code, details: { changes } }, c);
      }
    });
    if (notifyOwner) {
      await notify(app, {
        contractorId: scope.contractorId, event: 'wr.owner_assigned', recipients: [notifyOwner], title: `You now own WR ${w.wr_code}`,
        body: w.building_name ?? null, link: `/work-requests/${w.wr_code}`, entityType: 'work_request', entityId: w.wr_code, workRequestId: w.id, channels: ['in_app', 'push'],
      });
    }
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    return wrView(await findWr(app, scope, code), ctx, user);
  });

  app.post('/api/work-requests/bulk', { preHandler: requireRole(...ALL_SEEING) }, async (request) => {
    const scope = await scopeOf(app, request);
    const body = z
      .object({
        codes: z.array(z.string().min(1).max(40)).min(1).max(2000),
        ownerId: z.string().uuid().nullable().optional(),
        criterion: z.number().int().min(1).max(4).nullable().optional(),
      })
      .strict()
      .refine((b) => b.ownerId !== undefined || b.criterion !== undefined, 'Give ownerId and/or criterion.')
      .parse(request.body);
    const user = scope.user;
    const found = await app.db.query<{ id: string; wr_code: string; owner_id: string | null; criterion: number | null }>(
      `SELECT w.id, w.wr_code, i.owner_id, i.criterion FROM work_request w LEFT JOIN wr_internal i ON i.work_request_id = w.id
        WHERE w.contractor_id = $1 AND w.wr_code = ANY($2::text[])`,
      [scope.contractorId, body.codes],
    );
    const foundCodes = new Set(found.rows.map((r) => r.wr_code));
    let updated = 0;
    await withTx(app.db, async (c) => {
      if (body.ownerId) await checkOwner(c, scope.contractorId, body.ownerId);
      for (const w of found.rows) {
        await ensureInternal(c, scope.contractorId, w.id);
        let changed = false;
        if (body.ownerId !== undefined && body.ownerId !== w.owner_id) {
          await c.query('UPDATE wr_internal SET owner_id = $2, updated_by = $3, updated_at = now() WHERE work_request_id = $1', [w.id, body.ownerId, user.id]);
          await sonuEvent(c, scope.contractorId, w.id, 'wr.owner_changed', { from: w.owner_id, to: body.ownerId, by: 'bulk' }, user.id);
          await c.query(
            `INSERT INTO wr_stage_history (contractor_id, work_request_id, source, from_stage, to_stage, user_id) VALUES ($1,$2,'sonu',$3,$4,$5)`,
            [scope.contractorId, w.id, w.owner_id ? 'owned' : 'new', body.ownerId ? 'owned' : 'new', user.id],
          );
          changed = true;
        }
        if (body.criterion !== undefined && body.criterion !== w.criterion) {
          await c.query('UPDATE wr_internal SET criterion = $2, updated_by = $3, updated_at = now() WHERE work_request_id = $1', [w.id, body.criterion, user.id]);
          await sonuEvent(c, scope.contractorId, w.id, 'wr.criterion_set', { from: w.criterion, to: body.criterion }, user.id);
          changed = true;
        }
        if (changed) updated++;
      }
      await auditFromRequest(request, { action: 'work_request.bulk_update', entityType: 'work_request', summary: `${updated} work requests`, details: { codes: body.codes.length, ownerId: body.ownerId, criterion: body.criterion } }, c);
    });
    if (body.ownerId && body.ownerId !== user.id && updated) {
      await notify(app, {
        contractorId: scope.contractorId, event: 'wr.owner_assigned', recipients: [body.ownerId], title: `You now own ${updated} more work request${updated > 1 ? 's' : ''}`,
        link: '/work-requests', channels: ['in_app', 'push'],
      });
    }
    return { updated, notFound: body.codes.filter((c) => !foundCodes.has(c)) };
  });

  // ───── pick lists ─────
  app.get('/api/meta', contractorUsers, async (request) => {
    const scope = await scopeOf(app, request);
    const cid = scope.contractorId;
    const sites = await app.db.query<{ zone: string | null; facility: string | null; group_name: string | null }>('SELECT zone, facility, group_name FROM site_lookup WHERE contractor_id = $1', [cid]);
    const disciplines = await app.db.query<{ discipline: string }>('SELECT DISTINCT discipline FROM problem_type_lookup WHERE contractor_id = $1 ORDER BY 1', [cid]);
    const teams = await app.db.query('SELECT id, code, name, zone FROM work_team WHERE contractor_id = $1 AND active ORDER BY code', [cid]);
    const people =
      scope.user.role === 'technician'
        ? []
        : (await app.db.query(
            `SELECT u.id, u.full_name AS "fullName", u.role,
                    COALESCE((SELECT array_agg(t.code ORDER BY t.code) FROM user_work_team ut JOIN work_team t ON t.id = ut.work_team_id WHERE ut.user_id = u.id), '{}') AS "workTeams"
               FROM app_user u WHERE u.contractor_id = $1 AND u.status = 'active' ORDER BY u.full_name`,
            [cid],
          )).rows;
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x && x.trim())))].sort();
    return {
      contractorStatuses: CONTRACTOR_STATUSES,
      roles: CONTRACTOR_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
      criteria: CRITERIA,
      ageBuckets: ['Within Month', 'More Than One month', 'More Than Two month', 'More Than Three month', 'No Date'],
      kpis: ['Present KPI', 'Backlog KPI', 'Future KPI', 'No TD'],
      tdStatuses: ['Breached', 'TD Valid', 'No TD'],
      rfeTimeFrameKinds: ['valid', 'breach', 'submitted', 'notRequired', 'approved', 'unknown'],
      qfStages: Object.entries(STAGE_LABELS).map(([k, v]) => ({ stage: Number(k), label: v })),
      lookups: {
        zones: uniq(sites.rows.map((s) => s.zone || s.group_name)),
        facilities: uniq(sites.rows.map((s) => s.facility)),
        disciplines: disciplines.rows.map((d) => d.discipline),
      },
      workTeams: teams.rows,
      people,
      lists: LIST_KEYS.map((k) => ({ key: k, title: EXPORTS[k].title, menuPath: EXPORTS[k].menuPath, captions: EXPORTS[k].captions, required: EXPORTS[k].required })),
    };
  });

  // ───── dashboard ─────
  app.get('/api/dashboard', noTechnicians, async (request) => {
    const scope = await scopeOf(app, request);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    const loc = z.object({
      facility: z.string().max(200).optional(), building: z.string().max(200).optional(),
      zone: z.string().max(200).optional(), discipline: z.string().max(200).optional(),
    }).parse(request.query);
    const allRows = await loadWrs(app.db, scope);
    const allViews = allRows.map((w) => wrView(w, ctx, scope.user));
    const uniq = (xs: unknown[]) => [...new Set(xs.map((x) => String(x ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const pairs = new Map<string, { facility: string; building: string }>();
    for (const v of allViews) {
      const building = String(v.buildingName ?? '').trim();
      if (!building) continue;
      const facility = String(v.computed.facility ?? '').trim();
      pairs.set(`${facility}\u0000${building}`, { facility, building });
    }
    const filterOptions = {
      facilities: uniq(allViews.map((v) => v.computed.facility)),
      zones: uniq(allViews.map((v) => v.computed.zone)),
      disciplines: uniq(allViews.map((v) => v.computed.discipline)),
      buildings: [...pairs.values()].sort((a, b) => a.facility.localeCompare(b.facility, 'en') || a.building.localeCompare(b.building, 'en', { numeric: true })),
    };
    const match = locationMatcher(ctx, loc);
    const rows = allRows.filter(match);
    const views = allViews.filter((_, i) => match(allRows[i]!));
    const summaryRows: SummaryRow[] = views.map((v) => ({
      dateRequested: v.dateRequested as string | null,
      month: v.computed.month,
      tdStatus: v.computed.tdStatus,
      kpi: v.computed.kpi,
      discipline: v.computed.discipline,
      facility: v.computed.facility,
      zone: v.computed.zone,
      daysSinceRequested: v.computed.daysSinceRequested,
      rfeTimeFrameKind: v.computed.rfeTimeFrameKind,
      status: (v.internal as { contractorStatus: string | null }).contractorStatus,
    }));
    const summary = summarise(summaryRows, { today: ctx.today });

    const hasDashboard = (await app.db.query(`SELECT 1 FROM import_batch WHERE contractor_id = $1 AND list_key = 'wr_dashboard' AND status = 'ok' LIMIT 1`, [scope.contractorId])).rowCount;
    let descriptiveStages: { stage: number; label: string; count: number }[] | null = null;
    if (hasDashboard) {
      const counts = new Map<number, { label: string; count: number }>();
      for (let s = 2; s <= 8; s++) counts.set(s, { label: STAGE_LABELS[s]!, count: 0 });
      for (const w of rows) {
        const s = effectiveStage(w);
        if (s === null || !counts.has(s)) continue;
        const e = counts.get(s)!;
        e.count++;
        if (w.descriptive_status && s !== 6) e.label = w.descriptive_status;
      }
      descriptiveStages = [...counts.entries()].map(([stage, e]) => ({ stage, label: e.label, count: e.count }));
    }

    const card = (v: WrView) => ({
      wrCode: v.wrCode, buildingName: v.buildingName, description: v.description, workTeamCode: v.workTeamCode,
      ownerName: (v.internal as { ownerName: string | null }).ownerName, deadline: v.deadline,
    });
    const dueToday = views.filter((v) => v.deadline && !v.deadline.breached && v.deadline.dueDate === ctx.today);
    const unowned = views.filter((v) => !(v.internal as { ownerId: string | null }).ownerId);
    const returns = views.filter((v) => [4, 7].includes((v.qfStage as number | null) ?? -1));
    // Past the agreed target date, most overdue first: the top-priority list.
    const overdue = (v: WrView) => (typeof v.computed.daysToBreach === 'number' ? v.computed.daysToBreach : 0);
    const breachedTd = views.filter((v) => v.computed.tdStatus === 'Breached').sort((a, b) => overdue(b) - overdue(a));
    const unanswered = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rfe_comment c JOIN work_request w ON w.id = c.work_request_id
        WHERE c.contractor_id = $1 AND w.gone_at IS NULL AND c.answered_in_sonu_at IS NULL AND COALESCE(c.is_done, false) = false
          AND w.id = ANY($2::uuid[])`,
      [scope.contractorId, rows.map((r) => r.id)],
    );
    const asOf = await app.db.query<{ at: Date | null; by: string | null; list_key: string | null }>(
      `SELECT b.created_at AS at, u.full_name AS by, b.list_key FROM import_batch b LEFT JOIN app_user u ON u.id = b.user_id
        WHERE b.contractor_id = $1 AND b.status = 'ok' ORDER BY b.created_at DESC LIMIT 1`,
      [scope.contractorId],
    );
    const zr = await zeroRfeReport(app, scope, ctx, ctx.today.slice(0, 7), match);
    return {
      today: ctx.today,
      ...summary,
      inProgress: views.filter(isInProgress).length,
      priorityRequests: views.filter((v) => isPriorityRequest(v, 10)).length,
      filterOptions,
      descriptiveStages,
      zeroRfe: { monthJobs: zr.totals.jobs, monthSpent: zr.totals.spent, withoutReceipt: zr.totals.withoutReceipt },
      needsActionToday: {
        deadlinesToday: dueToday.slice(0, 50).map(card),
        deadlinesTodayCount: dueToday.length,
        breachedDeadlines: views.filter((v) => v.deadline?.breached).length,
        unownedCount: unowned.length,
        unowned: unowned.slice(0, 50).map(card),
        returnsCount: returns.length,
        returns: returns.slice(0, 50).map(card),
        breachedTdCount: breachedTd.length,
        breachedTd: breachedTd.slice(0, 50).map((v) => ({ ...card(v), overdueDays: overdue(v) })),
        unansweredComments: unanswered.rows[0]?.n ?? 0,
      },
      dataAsOf: asOf.rows[0] ? { at: asOf.rows[0].at, by: asOf.rows[0].by, listKey: asOf.rows[0].list_key } : null,
    };
  });

  // ───── my work ─────
  app.get('/api/my-work', noTechnicians, async (request) => {
    const scope = await scopeOf(app, request);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    const rows = await loadWrs(app.db, scope);
    const mine = rows.filter((w) => w.owner_id === scope.user.id);
    const ids = mine.map((w) => w.id);
    const openJobs = new Set(
      (await app.db.query<{ work_request_id: string }>(`SELECT DISTINCT work_request_id FROM assignment WHERE contractor_id = $1 AND status <> 'done' AND work_request_id = ANY($2::uuid[])`, [scope.contractorId, ids])).rows.map((r) => r.work_request_id),
    );
    const comments = new Set(
      (await app.db.query<{ work_request_id: string }>(
        `SELECT DISTINCT work_request_id FROM rfe_comment WHERE contractor_id = $1 AND answered_in_sonu_at IS NULL AND COALESCE(is_done,false) = false AND work_request_id = ANY($2::uuid[])`,
        [scope.contractorId, ids],
      )).rows.map((r) => r.work_request_id),
    );
    const groups: Record<string, unknown[]> = { take_ownership: [], returned: [], answer_qf: [], classify: [], estimate_due: [], assign_technician: [], other: [] };
    const card = (w: WrRow) => {
      const v = wrView(w, ctx, scope.user);
      return {
        wrCode: w.wr_code, buildingName: w.building_name, roomCode: w.room_code, description: (w.description ?? '').slice(0, 160),
        wrStatus: w.wr_status, qfStage: effectiveStage(w), criterion: w.criterion, contractorStatus: w.contractor_status,
        dayCounter: v.deadline ? { day: v.deadline.dayNumber, limit: v.deadline.limit, state: v.deadline.state, dueDate: v.deadline.dueDate, rule: v.deadline.ruleName } : null,
        rfeTimeFrame: v.computed.rfeTimeFrame,
      };
    };
    for (const w of mine) {
      const st = effectiveStage(w);
      const tf = computedFor(w, ctx).rfeTimeFrameKind;
      if (st === 4 || st === 7) groups.returned!.push(card(w));
      else if (comments.has(w.id)) groups.answer_qf!.push(card(w));
      else if (w.criterion === null) groups.classify!.push(card(w));
      else if (tf === 'valid' || tf === 'breach') groups.estimate_due!.push(card(w));
      else if (!openJobs.has(w.id) && !w.wr_status?.toLowerCase().includes('completed')) groups.assign_technician!.push(card(w));
      else groups.other!.push(card(w));
    }
    if (scope.user.role === 'supervisor') {
      for (const w of rows) if (!w.owner_id && inTeams(scope, w.work_team_code)) groups.take_ownership!.push(card(w));
    }
    return { today: ctx.today, owned: mine.length, groups };
  });

  // ───── exports ─────
  app.get('/api/exports/master.xlsx', { preHandler: requireRole('supervisor', 'purchasing', ...ALL_SEEING) }, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const ctx = await loadComputeContext(app, app.db, scope.contractorId);
    const rows = await loadWrs(app.db, scope);
    const pending: TypedRow[] = rows.map((w) => ({
      wrCode: w.wr_code, wrStatus: w.wr_status, requestor: w.requestor_name, siteCode: w.site_code, siteName: w.site_name,
      buildingCode: w.building_code, buildingName: w.building_name, problemType: w.problem_type, description: w.description,
      priority: w.priority, workTeamCode: w.work_team_code, estimatedTotalCost: w.est_total_cost, dateRequested: w.date_requested,
      dateTradeAssigned: w.date_trade_assigned, targetDate: w.agreed_target_date,
    }));
    const typed = new Map(rows.map((w) => [w.wr_code, { status: w.contractor_status, fcRemarks: w.fc_remarks }]));
    const master = buildMasterRows(pending, { today: ctx.today, rfeLimitDays: ctx.rfeLimitDays, rfeLookup: ctx.rfeLookup, lookups: ctx.lookups, typed });
    const buf = await writeMasterWorkbook(master, summarise(master, { today: ctx.today }), { asOf: ctx.today });
    await auditFromRequest(request, { action: 'export.master', entityType: 'export', summary: `Master workbook, ${master.length} rows`, details: { rows: master.length, asOf: ctx.today } });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="sonu-master-${ctx.today}.xlsx"`)
      .header('Cache-Control', 'no-store')
      .send(buf);
  });

  const rfeLine = z.object({
    lineType: z.enum(['Item', 'Discount', 'Margin', 'T', 'S', 'M']).optional(),
    vendorItemName: z.string().max(500),
    uom: z.string().max(40),
    lineNumber: z.union([z.string().max(40), z.number()]).optional(),
    poNumber: z.string().max(60).optional(),
    bpaItem: z.string().max(200).optional(),
    accountCode: z.string().max(120).optional(),
    estQty: z.number(),
    unitPrice: z.number(),
    markUp: z.number().default(0),
  });

  app.post('/api/work-requests/:code/rfe-file', { preHandler: requireRole('supervisor', 'purchasing', ...ALL_SEEING) }, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(request.params);
    const body = z.object({ lines: z.array(rfeLine).max(500), lineTypeStyle: z.enum(['label', 'code']).optional() }).parse(request.body);
    const w = await findWr(app, scope, code);
    const template = await fs.readFile(path.join(app.config.assetsDir, 'marafiq-rfe-template.xlsx'));
    let out: { fileName: string; buffer: Buffer };
    try {
      out = await writeRfeWorkbook(template, w.wr_code, body.lines, { lineTypeStyle: body.lineTypeStyle });
    } catch (err) {
      if (err instanceof RfeValidationError) throw new AppError(422, 'rfe_invalid', 'The RFE lines are not valid.', { problems: err.problems });
      throw err;
    }
    await sonuEvent(app.db, scope.contractorId, w.id, 'rfe.file_prepared', { lines: body.lines.length, fileName: out.fileName }, scope.user.id);
    await auditFromRequest(request, { action: 'export.rfe_file', entityType: 'work_request', entityId: w.wr_code, summary: `${out.fileName}, ${body.lines.length} lines` });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${out.fileName}"`)
      .header('Cache-Control', 'no-store')
      .send(out.buffer);
  });

  void requireAuth;
}
