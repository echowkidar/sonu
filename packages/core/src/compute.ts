import { dayNumber, diffDays, isIsoDate, type IsoDate } from './dates.js';
import { currentLookups, disciplineFor, facilityZoneFor, type Lookups } from './lookups.js';

/**
 * The tracker workbook's computed columns (analysis 07, "Columns of the master list -> Computed").
 * Every function is whole-day arithmetic on calendar dates; `today` is supplied by the caller.
 */

export interface WrInput {
  wrCode?: string | null;
  wrStatus?: string | null;
  dateRequested?: IsoDate | null;
  dateTradeAssigned?: IsoDate | null;
  targetDate?: IsoDate | null;
  estimatedTotalCost?: number | null;
  siteCode?: string | null;
  problemType?: string | null;
  /** FC Remarks (tracker) - only used for the "monthly routine" override of the RFE status. */
  fcRemarks?: string | null;
}

export interface RfeDates {
  submittedOn: IsoDate | null;
  approvedOn: IsoDate | null;
}

export type RfeLookup = Map<string, RfeDates> | Record<string, RfeDates>;

export type AgeBucket = 'Within Month' | 'More Than One month' | 'More Than Two month' | 'More Than Three month' | 'No Date';
export type TdStatus = 'Breached' | 'TD Valid' | 'No TD';
export type KpiLabel = 'Present KPI' | 'Backlog KPI' | 'Future KPI' | 'No TD';
export type RfeStatus = 'RFE To Be Submitted' | 'RFE Submitted' | 'RFE Not Required' | 'RFE Approved';
export type RfeTimeFrameKind = 'valid' | 'breach' | 'submitted' | 'notRequired' | 'approved' | 'unknown';

export interface ComputedColumns {
  month: AgeBucket;
  daysToBreach: number | 'No TD' | 'Completed';
  tdStatus: TdStatus;
  kpi: KpiLabel;
  rfeSubmittedOn: IsoDate | null;
  rfeApprovedOn: IsoDate | null;
  discipline: string;
  facility: string;
  zone: string;
  rfeStatus: RfeStatus;
  daysSinceRequested: number | null;
  rfeTimeFrame: string;
  /** Machine-readable form of `rfeTimeFrame`. */
  rfeTimeFrameKind: RfeTimeFrameKind;
}

export interface ComputeOptions {
  today: IsoDate;
  rfeLimitDays?: number;
  rfeLookup?: RfeLookup;
  lookups?: Lookups;
}

/**
 * Work Request Status values by group. Marafiq's list (analysis 01): R Requested - Rev Reviewed but On Hold -
 * Rej Rejected - A Approved - AA Assigned to Work Order - I Issued and In Process - HP / HA / HL On Hold for
 * Parts / Access / Labor - NHW - S Stopped - Can Cancelled - Com Completed - Clo Closed - CC Contractor Completed.
 *
 * "Assigned"  = Assigned to Work Order.
 * "Issued"    = Issued and In Process and the three "On Hold for ..." statuses (the job was issued, then paused).
 * "Completed" = Completed, Contractor Completed, Closed.
 * In the real workbook only "Assigned to Work Order" and "Issued and In Process" occur (662 + 573 = 1,235).
 */
export const ASSIGNED_STATUSES = ['assigned to work order', 'aa'];
export const ISSUED_STATUSES = ['issued and in process', 'i', 'on hold for parts', 'hp', 'on hold for access', 'ha', 'on hold for labor', 'hl'];
export const COMPLETED_STATUSES = ['completed', 'com', 'contractor completed', 'cc', 'closed', 'clo'];

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const isAssigned = (s: unknown) => ASSIGNED_STATUSES.includes(norm(s));
export const isIssued = (s: unknown) => ISSUED_STATUSES.includes(norm(s));
export const isCompleted = (s: unknown) => COMPLETED_STATUSES.includes(norm(s));

/**
 * Age bucket from "Date Work Requested" ("Month" column).
 * Age = today - requested, in whole days. Workbook wording: "under 31 days Within Month, under 62 More Than One
 * month, under 92 More Than Two month, else More Than Three month". So the boundaries are:
 *   age 30 -> Within Month,            age 31 -> More Than One month
 *   age 61 -> More Than One month,     age 62 -> More Than Two month
 *   age 91 -> More Than Two month,     age 92 -> More Than Three month
 * A requested date in the future (negative age) counts as Within Month. No date -> "No Date".
 */
export function ageBucket(requested: IsoDate | null | undefined, today: IsoDate): AgeBucket {
  if (!requested) return 'No Date';
  const age = diffDays(requested, today);
  if (age < 31) return 'Within Month';
  if (age < 62) return 'More Than One month';
  if (age < 92) return 'More Than Two month';
  return 'More Than Three month';
}

/**
 * "Days to Breach" = today - Agreed Target Date, exactly as the workbook formula reads (positive = days past the
 * target, negative = days left, 0 = target date is today). Empty target date -> "No TD".
 */
export function daysToBreach(
  target: IsoDate | null | undefined,
  today: IsoDate,
  wrStatus?: unknown,
): number | 'No TD' | 'Completed' {
  // Workbook column R: status "COMPLETED" -> "Completed"; no target date -> "No TD"; else TODAY - target.
  if (norm(wrStatus) === 'completed') return 'Completed';
  return target ? diffDays(target, today) : 'No TD';
}

/**
 * TD Status: "Breached" when today is AFTER the target date; a target date equal to today is still "TD Valid"
 * (the workbook says "after"); empty target date -> "No TD".
 */
export function tdStatus(target: IsoDate | null | undefined, today: IsoDate): TdStatus {
  if (!target) return 'No TD';
  return dayNumber(today) > dayNumber(target) ? 'Breached' : 'TD Valid';
}

/**
 * KPI by the month of the target date relative to the month of today: same year+month "Present KPI", earlier
 * "Backlog KPI", later "Future KPI". Empty target date -> "No TD" (every row of the real file has one).
 */
export function kpiOf(target: IsoDate | null | undefined, today: IsoDate): KpiLabel {
  if (!target) return 'No TD';
  const t = target.slice(0, 7);
  const n = today.slice(0, 7);
  if (t === n) return 'Present KPI';
  return t < n ? 'Backlog KPI' : 'Future KPI';
}

/** The exact remark the workbook formula (column AB) compares with; Excel's "=" ignores case. */
export const MONTHLY_ROUTINE_REMARK = 'Monthly Routine Activities WR to be closed at the end of the Month';
/** Statuses that give "RFE Not Required" at cost 0 in column AB (On Hold and Closed are NOT in the formula). */
const NOT_REQUIRED_STATUSES = ['issued and in process', 'completed', 'contractor completed'];

/**
 * RFE status, workbook column AB, in the formula's own order:
 *  1. FC Remarks = the monthly-routine remark            -> "RFE Not Required"
 *  2. Assigned to Work Order + cost 0                     -> "RFE To Be Submitted"
 *  3. Issued and In Process / Completed / Contractor Completed + cost 0 -> "RFE Not Required"
 *  4. Assigned to Work Order + cost > 0                   -> "RFE Submitted"
 *  5. anything else                                       -> "RFE Approved"
 */
export function rfeStatusOf(wr: Pick<WrInput, 'wrStatus' | 'estimatedTotalCost' | 'fcRemarks'>): RfeStatus {
  const cost = wr.estimatedTotalCost ?? 0;
  if (norm(wr.fcRemarks) === norm(MONTHLY_ROUTINE_REMARK)) return 'RFE Not Required';
  if (isAssigned(wr.wrStatus) && cost === 0) return 'RFE To Be Submitted';
  if (NOT_REQUIRED_STATUSES.includes(norm(wr.wrStatus)) && cost === 0) return 'RFE Not Required';
  if (isAssigned(wr.wrStatus) && cost > 0) return 'RFE Submitted';
  return 'RFE Approved';
}

/**
 * RFE time frame, workbook column AE (its own formula, independent of column AB and of the remarks):
 *   Issued and In Process + cost 0 -> "RFE Not Required"
 *   cost > 0                       -> "RFE Submitted"
 *   Assigned to Work Order + cost 0:
 *     elapsed <= limit -> "RFE Valid Time Frame - {limit - elapsed} Days Remaining"   (day 14 -> 0 remaining)
 *     elapsed >  limit -> "RFE Time Breach - {elapsed - limit} Days Crossed"           (day 15 -> 1 crossed)
 *   anything else                  -> "" (blank)
 * Elapsed = today - Date Trade Assigned in whole calendar days. The limit is configurable (default 14).
 */
export function rfeTimeFrameOf(
  wr: Pick<WrInput, 'wrStatus' | 'estimatedTotalCost' | 'fcRemarks' | 'dateTradeAssigned'>,
  today: IsoDate,
  limit = 14,
): { label: string; kind: RfeTimeFrameKind } {
  const cost = wr.estimatedTotalCost ?? 0;
  const status = norm(wr.wrStatus);
  if (status === 'issued and in process' && cost === 0) return { label: 'RFE Not Required', kind: 'notRequired' };
  if (cost > 0) return { label: 'RFE Submitted', kind: 'submitted' };
  if (isAssigned(wr.wrStatus) && cost === 0) {
    if (!wr.dateTradeAssigned) return { label: 'RFE Time Frame - No Assigned Date', kind: 'unknown' };
    const elapsed = diffDays(wr.dateTradeAssigned, today);
    if (elapsed <= limit) return { label: `RFE Valid Time Frame - ${limit - elapsed} Days Remaining`, kind: 'valid' };
    return { label: `RFE Time Breach - ${elapsed - limit} Days Crossed`, kind: 'breach' };
  }
  return { label: '', kind: 'unknown' };
}

function lookupRfe(l: RfeLookup | undefined, code: string | null | undefined): RfeDates | null {
  if (!l || !code) return null;
  const hit = l instanceof Map ? l.get(code) : (l as Record<string, RfeDates>)[code];
  return hit ?? null;
}

/** All computed columns for one work request. */
export function computeColumns(wr: WrInput, opts: ComputeOptions): ComputedColumns {
  const { today } = opts;
  if (!isIsoDate(today)) throw new Error(`today must be an ISO date YYYY-MM-DD, got ${String(today)}`);
  const lookups = opts.lookups ?? currentLookups();
  const limit = opts.rfeLimitDays ?? 14;
  const rfe = lookupRfe(opts.rfeLookup, wr.wrCode);
  const fz = facilityZoneFor(wr.siteCode, lookups);
  const tf = rfeTimeFrameOf(wr, today, limit);
  return {
    month: ageBucket(wr.dateRequested, today),
    daysToBreach: daysToBreach(wr.targetDate, today, wr.wrStatus),
    tdStatus: tdStatus(wr.targetDate, today),
    kpi: kpiOf(wr.targetDate, today),
    rfeSubmittedOn: rfe?.submittedOn ?? null,
    rfeApprovedOn: rfe?.approvedOn ?? null,
    discipline: disciplineFor(wr.problemType, lookups),
    facility: fz.facility,
    zone: fz.zone,
    rfeStatus: rfeStatusOf(wr),
    // Named "No Of Days Since requested" in the workbook but defined as today - Date Trade Assigned (analysis 07).
    daysSinceRequested: wr.dateTradeAssigned ? diffDays(wr.dateTradeAssigned, today) : null,
    rfeTimeFrame: tf.label,
    rfeTimeFrameKind: tf.kind,
  };
}
