/**
 * Shared helpers of the ops module: the injectable clock, the per-contractor compute context (lookups, RFE lookup,
 * deadline rules), loading work requests with their internal data, computing columns / deadlines, and access scope.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  computeColumns,
  evaluateDeadline,
  isAssigned,
  isCompleted,
  pickRule,
  suggestContractorStatus,
  todayInZone,
  UNMAPPED,
  type ComputedColumns,
  type DeadlineEvaluation,
  type DeadlineRule,
  type IsoDate,
  type Lookups,
  type RfeDates,
} from '@sonu/core';
import type { Queryable } from '../db.js';
import { currentUser, seesAllTeams, teamScope } from '../auth/guards.js';
import type { AuthUser } from '../types.js';
import { AppError } from '../errors.js';

// ───────────────────────────── clock ─────────────────────────────

export interface OpsClock {
  /** Wall clock (default: real time). */
  now: () => Date;
  /** Fixed calendar date for every contractor (tests: '2026-11-09'). null = computed from now() in the contractor's zone. */
  today: IsoDate | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable clock of the ops module (tests set `app.opsClock.today`). */
    opsClock: OpsClock;
  }
}

export function makeClock(): OpsClock {
  const env = process.env.SONU_TODAY;
  const fixed = env && process.env.NODE_ENV !== 'production' && /^\d{4}-\d{2}-\d{2}$/.test(env) ? env : null;
  return { now: () => new Date(), today: fixed };
}

export function todayFor(app: FastifyInstance, timeZone: string | null | undefined): IsoDate {
  const c = app.opsClock;
  if (c?.today) return c.today;
  return todayInZone(timeZone || 'Asia/Qatar', c?.now() ?? new Date());
}

// ───────────────────────────── SQL date helpers ─────────────────────────────

/** Dates from exports are stored as UTC midnight timestamptz. */
export const sqlDateIn = (n: number) => `($${n}::date::timestamp AT TIME ZONE 'UTC')`;
export const sqlDateOut = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

// ───────────────────────────── compute context ─────────────────────────────

export interface ComputeContext {
  contractorId: string;
  timeZone: string;
  today: IsoDate;
  lookups: Lookups;
  rfeLookup: Map<string, RfeDates>;
  rules: DeadlineRule[];
  ruleKeys: Map<string, string>;
  rfeLimitDays: number;
  portalBase: string;
}

const lkey = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Rule key (deadline_rule.key) -> core stage name. */
const STAGE_OF_KEY: Record<string, string> = {
  take_ownership: 'new',
  inspect_issue_c1: 'inspection',
  inspect_issue_c2_low: 'inspection',
  rfe_submit_14d: 'estimate',
  rfe_submit_c4: 'estimate',
  submittal_approval: 'submittal',
  access_granted: 'access',
  quotations_received: 'quotations',
  answer_rfe_comment: 'qf_comment',
  resubmit_returned: 'resubmit',
  lpo_after_approval: 'lpo',
  supplier_delivery: 'delivery',
  permit_expiry: 'permit',
  closeout_after_completion: 'closeout',
  permit_closure: 'permit_closure',
  fix_returned_closeout: 'closeout_returned',
};

interface RuleDbRow {
  id: string;
  key: string;
  name: string;
  criteria: number[] | null;
  stage: string | null;
  limit_value: number | null;
  limit_unit: string;
  warnings: unknown;
  escalation_roles: string[];
  params: Record<string, unknown> | null;
  active: boolean;
}

/** deadline_rule row (admin-editable) -> core DeadlineRule. */
export function toCoreRule(r: RuleDbRow): DeadlineRule {
  const warnings: number[] = [];
  let repeatEvery: number | undefined;
  for (const w of (Array.isArray(r.warnings) ? r.warnings : []) as Record<string, unknown>[]) {
    const unit = String(w.unit ?? 'days');
    if (unit !== 'days') continue; // hour-level warnings are not expressible in whole days
    if (typeof w.value === 'number') warnings.push(r.limit_unit === 'date_field' ? Math.abs(w.value) : w.value);
    if (typeof w.every === 'number') repeatEvery = w.every;
  }
  const kind = r.limit_unit === 'date_field' ? 'date' : 'days';
  const limit = r.limit_unit === 'hours' ? Math.max(0, Math.ceil((r.limit_value ?? 0) / 24)) : (r.limit_value ?? 0);
  const rule: DeadlineRule = {
    id: r.key,
    name: r.name,
    stage: STAGE_OF_KEY[r.key] ?? r.stage ?? r.key,
    kind,
    limit: r.limit_unit === 'same_day' ? 0 : limit,
    unit: r.limit_unit === 'working_days' ? 'working' : 'calendar',
    warnings,
    repeatEvery,
    onBreach: r.escalation_roles ?? [],
    enabled: r.active,
  };
  if (r.criteria && r.criteria.length) rule.criterion = r.criteria;
  const maxCost = r.params?.maxCost;
  if (typeof maxCost === 'number') rule.costBelow = maxCost;
  return rule;
}

export async function loadComputeContext(app: FastifyInstance, db: Queryable, contractorId: string): Promise<ComputeContext> {
  const c = await db.query<{ time_zone: string; base_url: string | null }>(
    `SELECT c.time_zone, (SELECT base_url FROM marafiq_connection m WHERE m.contractor_id = c.id ORDER BY (m.name = 'Main') DESC LIMIT 1) AS base_url
       FROM contractor c WHERE c.id = $1`,
    [contractorId],
  );
  const timeZone = c.rows[0]?.time_zone ?? 'Asia/Qatar';
  const sites = await db.query<{ site_code: string; zone: string | null; facility: string | null; group_name: string | null }>(
    'SELECT site_code, zone, facility, group_name FROM site_lookup WHERE contractor_id = $1',
    [contractorId],
  );
  const pts = await db.query<{ problem_type: string; discipline: string }>(
    'SELECT problem_type, discipline FROM problem_type_lookup WHERE contractor_id = $1',
    [contractorId],
  );
  const lookups: Lookups = { discipline: new Map(), site: new Map() };
  for (const p of pts.rows) if (p.discipline?.trim()) lookups.discipline.set(lkey(p.problem_type), p.discipline.trim());
  for (const s of sites.rows) {
    const zone = (s.zone || s.group_name || '').trim();
    const facility = (s.facility || '').trim();
    lookups.site.set(lkey(s.site_code), { facility: facility || UNMAPPED, zone: zone || UNMAPPED });
  }
  const rfe = await db.query<{ wr_code: string; s: string | null; a: string | null }>(
    `SELECT wr_code, ${sqlDateOut('submitted_on')} AS s, ${sqlDateOut('approved_on')} AS a FROM rfe_status WHERE contractor_id = $1`,
    [contractorId],
  );
  const rfeLookup = new Map<string, RfeDates>(rfe.rows.map((r) => [r.wr_code, { submittedOn: r.s, approvedOn: r.a }]));
  const ruleRows = await db.query<RuleDbRow>(
    `SELECT id, key, name, criteria, stage, limit_value, limit_unit, warnings, escalation_roles, params, active
       FROM deadline_rule WHERE contractor_id = $1 ORDER BY sort_order, key`,
    [contractorId],
  );
  const rules = ruleRows.rows.map(toCoreRule);
  const rfeRule = ruleRows.rows.find((r) => r.key === 'rfe_submit_14d');
  const rfeLimitDays = rfeRule && rfeRule.active && typeof rfeRule.limit_value === 'number' ? rfeRule.limit_value : 14;
  const portalBase = (c.rows[0]?.base_url || 'https://marafiq.qf.org.qa').replace(/\/+$/, '');
  return {
    contractorId,
    timeZone,
    today: todayFor(app, timeZone),
    lookups,
    rfeLookup,
    rules,
    ruleKeys: new Map(ruleRows.rows.map((r) => [r.key, r.id])),
    rfeLimitDays,
    portalBase,
  };
}

// ───────────────────────────── work request rows ─────────────────────────────

export interface WrRow {
  id: string;
  wr_code: string;
  wr_status: string | null;
  sr_code: string | null;
  wo_code: string | null;
  ptw_code: string | null;
  ptw_status: string | null;
  requestor_name: string | null;
  contractor_code: string | null;
  site_code: string | null;
  site_name: string | null;
  building_code: string | null;
  building_name: string | null;
  floor_code: string | null;
  room_code: string | null;
  directorate_code: string | null;
  department_code: string | null;
  equipment_code: string | null;
  equipment_standard: string | null;
  problem_type: string | null;
  problem_type_description: string | null;
  work_team_code: string | null;
  priority: string | null;
  description: string | null;
  date_requested: string | null;
  agreed_target_date: string | null;
  date_trade_assigned: string | null;
  date_to_perform: string | null;
  est_total_cost: number | null;
  descriptive_status: string | null;
  with_rfe: boolean | null;
  progress_pct: number | null;
  closure_comments: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  gone_at: Date | null;
  first_seen_date: string;
  // internal
  owner_id: string | null;
  owner_name: string | null;
  criterion: number | null;
  contractor_status: string | null;
  fc_remarks: string | null;
  status_source: string | null;
  due_at: Date | null;
  breach_level: number | null;
  // 0 RFE (local purchase with petty cash, no estimate sent to QF)
  zero_rfe_at: Date | null;
  zero_rfe_amount: number | null;
  zero_rfe_note: string | null;
  zero_rfe_by_name: string | null;
  /** 'YYYY-MM' of zero_rfe_at in the contractor's time zone. */
  zero_rfe_month: string | null;
}

export const WR_SELECT = `
  SELECT w.id, w.wr_code, w.wr_status, w.sr_code, w.wo_code, w.ptw_code, w.ptw_status, w.requestor_name, w.contractor_code,
         w.site_code, w.site_name, w.building_code, w.building_name, w.floor_code, w.room_code, w.directorate_code,
         w.department_code, w.equipment_code, w.equipment_standard, w.problem_type, w.problem_type_description,
         w.work_team_code, w.priority, w.description,
         ${sqlDateOut('w.date_requested')} AS date_requested, ${sqlDateOut('w.agreed_target_date')} AS agreed_target_date,
         ${sqlDateOut('w.date_trade_assigned')} AS date_trade_assigned, ${sqlDateOut('w.date_to_perform')} AS date_to_perform,
         w.est_total_cost, w.descriptive_status, w.with_rfe, w.progress_pct, w.closure_comments,
         w.first_seen_at, w.last_seen_at, w.gone_at,
         to_char(w.first_seen_at AT TIME ZONE COALESCE(ct.time_zone, 'Asia/Qatar'), 'YYYY-MM-DD') AS first_seen_date,
         i.owner_id, u.full_name AS owner_name, i.criterion, i.contractor_status, i.fc_remarks, i.status_source, i.due_at, i.breach_level,
         i.zero_rfe_at, i.zero_rfe_amount, i.zero_rfe_note, zu.full_name AS zero_rfe_by_name,
         to_char(i.zero_rfe_at AT TIME ZONE COALESCE(ct.time_zone, 'Asia/Qatar'), 'YYYY-MM') AS zero_rfe_month
    FROM work_request w
    JOIN contractor ct ON ct.id = w.contractor_id
    LEFT JOIN wr_internal i ON i.work_request_id = w.id
    LEFT JOIN app_user u ON u.id = i.owner_id
    LEFT JOIN app_user zu ON zu.id = i.zero_rfe_by`;

export function computedFor(w: WrRow, ctx: ComputeContext): ComputedColumns {
  return computeColumns(
    {
      wrCode: w.wr_code,
      wrStatus: w.wr_status,
      dateRequested: w.date_requested,
      dateTradeAssigned: w.date_trade_assigned,
      targetDate: w.agreed_target_date,
      estimatedTotalCost: w.est_total_cost,
      siteCode: w.site_code,
      problemType: w.problem_type,
      fcRemarks: w.fc_remarks,
    },
    { today: ctx.today, rfeLimitDays: ctx.rfeLimitDays, rfeLookup: ctx.rfeLookup, lookups: ctx.lookups },
  );
}

export interface DeadlineView extends DeadlineEvaluation {
  ruleKey: string;
  ruleName: string;
  /** What the clock is for: take_ownership | inspection | estimate | ... */
  stage: string;
}

/**
 * The active deadline of a WR:
 *  - completed / gone -> none;
 *  - nobody owns it   -> "take ownership" rule (stage new);
 *  - owned and still waiting for the estimate (Assigned to Work Order, cost 0, not approved) -> rule picked by criterion
 *    and cost (an unclassified WR is treated like criterion 3: the configured RFE rule);
 *  - otherwise none.
 */
export function deadlineFor(w: WrRow, ctx: ComputeContext): DeadlineView | null {
  if (w.gone_at || isCompleted(w.wr_status)) return null;
  const facts = { dateTradeAssigned: w.date_trade_assigned, firstSeen: w.first_seen_date };
  let rule: DeadlineRule | null = null;
  if (!w.owner_id) {
    rule = pickRule(ctx.rules, { stage: 'new' });
  } else {
    const cost = w.est_total_cost ?? 0;
    const approved = Boolean(ctx.rfeLookup.get(w.wr_code)?.approvedOn);
    if (isAssigned(w.wr_status) && cost === 0 && !approved) {
      rule = pickRule(ctx.rules, { criterion: w.criterion ?? 3, estimatedCost: cost });
    }
  }
  if (!rule) return null;
  const ev = evaluateDeadline(rule, facts, ctx.today);
  return { ...ev, ruleKey: rule.id, ruleName: rule.name, stage: rule.stage };
}

export function suggestedFor(w: WrRow, ctx: ComputeContext) {
  const rfe = ctx.rfeLookup.get(w.wr_code);
  return suggestContractorStatus({
    wrStatus: w.wr_status,
    descriptiveStatus: w.descriptive_status,
    estimatedTotalCost: w.est_total_cost,
    estimateSubmitted: w.with_rfe === true || Boolean(rfe?.submittedOn) || undefined,
    rfeApproved: Boolean(rfe?.approvedOn) || undefined,
  });
}

/** Descriptive stage number from "4. SP : ..." or null. */
export function stageNo(desc: string | null | undefined): number | null {
  const m = /^\s*(\d+)\s*[.\-)]/.exec(desc ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Stage used for the dashboard tiles and the stage filter: a WR converted to 0 RFE counts under 6 (In Progress)
 * while Marafiq still shows it at stage 2-5 (or has no stage yet). Later Marafiq stages (6, 7, 8) are kept.
 */
export function effectiveStage(w: Pick<WrRow, 'descriptive_status' | 'zero_rfe_at'>): number | null {
  const s = stageNo(w.descriptive_status);
  if (w.zero_rfe_at && (s === null || (s >= 2 && s <= 5))) return 6;
  return s;
}

// ───────────────────────────── access scope ─────────────────────────────

export interface Scope {
  user: AuthUser;
  contractorId: string;
  /** null = every work team. */
  teams: string[] | null;
  /** Technicians: only WRs with an assignment to them. */
  assignedOnly: boolean;
}

export async function scopeOf(app: FastifyInstance, request: FastifyRequest): Promise<Scope> {
  const user = currentUser(request);
  if (!user.contractorId) throw new AppError(403, 'forbidden', 'This needs a contractor account.');
  if (user.role === 'technician') return { user, contractorId: user.contractorId, teams: [], assignedOnly: true };
  const teams = seesAllTeams(user) ? null : await teamScope(app.db, user);
  return { user, contractorId: user.contractorId, teams: teams ? teams.map((t) => t.toLowerCase()) : null, assignedOnly: false };
}

/**
 * SQL condition for the scope (alias w = work_request). Adds params to `params`.
 * Supervisors / foremen: their work teams, plus WRs they own or that have one of their (team's) jobs.
 */
export function scopeSql(scope: Scope, params: unknown[]): string {
  if (scope.assignedOnly) {
    params.push(scope.user.id);
    return `EXISTS (SELECT 1 FROM assignment a WHERE a.work_request_id = w.id AND a.assignee_id = $${params.length})`;
  }
  if (scope.teams === null) return 'TRUE';
  params.push(scope.teams);
  const t = params.length;
  params.push(scope.user.id);
  const u = params.length;
  return `(lower(w.work_team_code) = ANY($${t}::text[])
           OR EXISTS (SELECT 1 FROM wr_internal ii WHERE ii.work_request_id = w.id AND ii.owner_id = $${u})
           OR EXISTS (SELECT 1 FROM assignment a WHERE a.work_request_id = w.id AND a.assignee_id = $${u}))`;
}

export function inTeams(scope: Scope, workTeamCode: string | null): boolean {
  if (scope.assignedOnly) return false;
  if (scope.teams === null) return true;
  return scope.teams.includes(String(workTeamCode ?? '').toLowerCase());
}

/** Roles that see money (estimated cost, money trail, RFE amounts) and the requestor name. */
export const seesMoney = (u: AuthUser) => u.role !== 'technician';
export const seesRequestor = (u: AuthUser) => u.role !== 'technician';
