import { addDays, diffDays, isIsoDate, weekday, type IsoDate } from './dates.js';

/**
 * Deadline rules (design 11 section 3). Everything is configurable: the rules are plain data.
 *
 * Clock: starts at "Date Trade Assigned"; when that is empty, at the date the WR was first seen in an import.
 * Counting: `dayNumber` = whole days (or working days) elapsed since the clock start; the start day is day 0.
 * A rule with limit L is therefore:
 *   dayNumber <  first warning        -> green
 *   first warning <= dayNumber <= L   -> amber (day L itself is the last good day: "due today")
 *   dayNumber >  L                    -> red, breached
 * This is the same reading as the tracker's RFE time frame ("day 14 is still inside, day 15 is crossed").
 */

export type DeadlineUnit = 'calendar' | 'working';
export type DeadlineState = 'green' | 'amber' | 'red';

export interface DeadlineRule {
  id: string;
  name: string;
  /** What the clock is for: new, inspection, estimate, submittal, access, quotations, qf_comment, resubmit, lpo, delivery, permit, closeout, permit_closure, closeout_returned. */
  stage: string;
  /** Criterion 1-4; omit = any. */
  criterion?: number[];
  /** Estimated cost must be below this (QR). */
  costBelow?: number;
  /** Estimated cost must be at least this (QR). */
  costAtLeast?: number;
  /** 'days' (default): limit counted from the clock start. 'date': the due date is given in the facts (promised delivery, permit Date Upto). */
  kind?: 'days' | 'date';
  /** Limit in days (unit below). For kind 'date' it is 0. */
  limit: number;
  unit: DeadlineUnit;
  /** Kind 'days': day numbers that raise a warning. Kind 'date': days BEFORE the due date (2 = two days before, 0 = on the day). */
  warnings: number[];
  /** Reminder repeats every n days after the first warning (information for the scheduler). */
  repeatEvery?: number;
  /** Who is told on breach (role names). */
  onBreach: string[];
  enabled?: boolean;
}

export interface DeadlineFacts {
  dateTradeAssigned?: IsoDate | null;
  /** First date the WR appeared in an import. */
  firstSeen?: IsoDate | null;
  /** For kind 'date' rules: promised delivery date, permit Date Upto ... */
  dueDate?: IsoDate | null;
}

export interface DeadlineOptions {
  /** Working week, 0 = Sunday ... 6 = Saturday. Default Sunday to Thursday (Qatar). */
  workingDays?: number[];
  /** Public holidays (ISO dates) that do not count as working days. */
  holidays?: IsoDate[];
}

export interface DeadlineEvaluation {
  /** Elapsed days/working days since the clock start (kind 'date': today minus due date, negative before it). */
  dayNumber: number;
  limit: number;
  state: DeadlineState;
  dueDate: IsoDate | null;
  /** Warning thresholds already reached today (for 'days' rules: day numbers <= dayNumber; for 'date' rules: days-before values reached). */
  warningsDue: number[];
  breached: boolean;
  clockStart: IsoDate | null;
}

export const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4];

export const DEFAULT_DEADLINE_RULES: DeadlineRule[] = [
  { id: 'take_ownership', name: 'Take ownership', stage: 'new', limit: 1, unit: 'working', warnings: [], onBreach: ['coordinator'] },
  { id: 'inspect_c1', name: 'Site inspection and issue (criterion 1, zero cost)', stage: 'inspection', criterion: [1], limit: 3, unit: 'calendar', warnings: [2], onBreach: ['supervisor', 'project_manager'] },
  { id: 'inspect_c2_low', name: 'Site inspection and issue (criterion 2, below QR 100)', stage: 'inspection', criterion: [2], costBelow: 100, limit: 7, unit: 'calendar', warnings: [5], onBreach: ['supervisor', 'project_manager'] },
  // The RFE rule: 14 days from Date Trade Assigned, as in the tracker workbook (confirmed 2026-11-16).
  { id: 'rfe_14', name: 'Estimate submitted in Marafiq (criterion 2 from QR 100, criterion 3)', stage: 'estimate', limit: 14, unit: 'calendar', warnings: [8, 11], onBreach: ['project_manager'] },
  { id: 'rfe_20_new_requirement', name: 'Estimate submitted in Marafiq (criterion 4, new requirement)', stage: 'estimate', criterion: [4], limit: 20, unit: 'calendar', warnings: [14, 17], onBreach: ['project_manager'] },
  { id: 'submittal_approval', name: "Supplier's drawing / artwork / sample approved by QF", stage: 'submittal', limit: 5, unit: 'working', warnings: [3], repeatEvery: 3, onBreach: ['project_manager'] },
  { id: 'access_granted', name: 'Access granted by QF', stage: 'access', limit: 3, unit: 'working', warnings: [2], repeatEvery: 2, onBreach: ['project_manager'] },
  { id: 'quotations', name: 'Quotations received (3 by day 7)', stage: 'quotations', limit: 7, unit: 'calendar', warnings: [3, 6], repeatEvery: 3, onBreach: ['project_manager'] },
  { id: 'qf_comment', name: 'Answer a QF RFE comment', stage: 'qf_comment', limit: 2, unit: 'working', warnings: [1], repeatEvery: 1, onBreach: ['supervisor_manager'] },
  { id: 'resubmit', name: 'Re-submit a returned estimate (stage 4)', stage: 'resubmit', limit: 5, unit: 'calendar', warnings: [3], onBreach: ['project_manager'] },
  { id: 'lpo_after_approval', name: 'LPO after approval', stage: 'lpo', limit: 2, unit: 'working', warnings: [1], repeatEvery: 1, onBreach: ['project_manager'] },
  { id: 'supplier_delivery', name: 'Supplier delivery (promised date)', stage: 'delivery', kind: 'date', limit: 0, unit: 'calendar', warnings: [0], repeatEvery: 3, onBreach: ['purchasing', 'project_manager'] },
  { id: 'permit_expiry', name: 'Permit expiry (Date Upto)', stage: 'permit', kind: 'date', limit: 0, unit: 'calendar', warnings: [2, 0], onBreach: ['applicant', 'supervisor'] },
  { id: 'closeout_after_field', name: 'Close-out after field completion', stage: 'closeout', limit: 2, unit: 'working', warnings: [1], repeatEvery: 1, onBreach: ['supervisor'] },
  { id: 'permit_closure', name: 'Close the permit (same day as completion)', stage: 'permit_closure', limit: 0, unit: 'calendar', warnings: [], onBreach: ['supervisor'] },
  { id: 'closeout_returned', name: 'Fix a returned close-out (stage 7)', stage: 'closeout_returned', limit: 3, unit: 'calendar', warnings: [1, 2], repeatEvery: 1, onBreach: ['project_manager'] },
];

function isWorking(d: IsoDate, week: number[], holidays: Set<string>): boolean {
  return week.includes(weekday(d)) && !holidays.has(d);
}

/** Working days elapsed after `start` up to and including `today` (the start day itself is never counted). */
export function workingDaysBetween(start: IsoDate, today: IsoDate, opts: DeadlineOptions = {}): number {
  const week = opts.workingDays ?? DEFAULT_WORKING_DAYS;
  const hol = new Set(opts.holidays ?? []);
  const span = diffDays(start, today);
  if (span <= 0) return 0;
  let n = 0;
  for (let i = 1; i <= span; i++) if (isWorking(addDays(start, i), week, hol)) n++;
  return n;
}

/** The date that is `n` working days after `start` (n = 0 -> start itself). Needs at least one working weekday. */
export function addWorkingDays(start: IsoDate, n: number, opts: DeadlineOptions = {}): IsoDate {
  const week = opts.workingDays ?? DEFAULT_WORKING_DAYS;
  if (week.length === 0) throw new Error('The working week has no working day.');
  const hol = new Set(opts.holidays ?? []);
  let d = start;
  let left = n;
  let guard = 0;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorking(d, week, hol)) left--;
    if (++guard > 5000) throw new Error('addWorkingDays: no working day found.');
  }
  return d;
}

export function evaluateDeadline(
  rule: DeadlineRule,
  facts: DeadlineFacts,
  today: IsoDate,
  opts: DeadlineOptions = {},
): DeadlineEvaluation {
  if (!isIsoDate(today)) throw new Error(`today must be an ISO date, got ${String(today)}`);
  const warnings = [...rule.warnings].sort((a, b) => a - b);

  if (rule.kind === 'date') {
    const due = facts.dueDate && isIsoDate(facts.dueDate) ? facts.dueDate : null;
    if (!due) return { dayNumber: 0, limit: 0, state: 'green', dueDate: null, warningsDue: [], breached: false, clockStart: null };
    const sinceDue = diffDays(due, today); // negative before the due date
    const daysUntil = -sinceDue;
    const reached = warnings.filter((w) => daysUntil <= w);
    const breached = sinceDue > 0;
    const state: DeadlineState = breached ? 'red' : reached.length > 0 ? 'amber' : 'green';
    return { dayNumber: sinceDue, limit: 0, state, dueDate: due, warningsDue: reached, breached, clockStart: null };
  }

  const startRaw = facts.dateTradeAssigned || facts.firstSeen || null;
  const start = startRaw && isIsoDate(startRaw) ? startRaw : null;
  if (!start) return { dayNumber: 0, limit: rule.limit, state: 'green', dueDate: null, warningsDue: [], breached: false, clockStart: null };

  const elapsed = rule.unit === 'working' ? workingDaysBetween(start, today, opts) : Math.max(0, diffDays(start, today));
  const dueDate = rule.unit === 'working' ? addWorkingDays(start, rule.limit, opts) : addDays(start, rule.limit);
  const breached = elapsed > rule.limit;
  const reached = warnings.filter((w) => elapsed >= w);
  const state: DeadlineState = breached
    ? 'red'
    : reached.length > 0 || (rule.limit > 0 && elapsed >= rule.limit)
      ? 'amber'
      : 'green';
  return { dayNumber: elapsed, limit: rule.limit, state, dueDate, warningsDue: reached, breached, clockStart: start };
}

export interface RuleSelector {
  /** Stage of the work; default derived from criterion and cost (see below). */
  stage?: string;
  /** 1-4 */
  criterion?: number | null;
  estimatedCost?: number | null;
}

/** QR 100 is the line between "below" (inspect and issue in 7 days) and "from" (estimate in 14 days): exactly 100 goes to the estimate. */
export function defaultStageFor(sel: RuleSelector): string {
  if (sel.criterion === 1) return 'inspection';
  if (sel.criterion === 2 && sel.estimatedCost !== null && sel.estimatedCost !== undefined && sel.estimatedCost < 100) return 'inspection';
  return 'estimate';
}

/**
 * Pick the rule for a work request: same stage, matching criterion and cost bands; the rule with the most
 * constraints wins (so criterion 4 gets the 20-day rule, everything else at the estimate stage the 14-day one).
 * Returns null when no rule fits.
 */
export function pickRule(rules: DeadlineRule[], sel: RuleSelector): DeadlineRule | null {
  const stage = sel.stage ?? defaultStageFor(sel);
  const cost = sel.estimatedCost;
  let best: { rule: DeadlineRule; specificity: number } | null = null;
  for (const rule of rules) {
    if (rule.enabled === false || rule.stage !== stage) continue;
    let specificity = 0;
    if (rule.criterion) {
      if (sel.criterion === null || sel.criterion === undefined || !rule.criterion.includes(sel.criterion)) continue;
      specificity++;
    }
    if (rule.costBelow !== undefined) {
      if (cost === null || cost === undefined || !(cost < rule.costBelow)) continue;
      specificity++;
    }
    if (rule.costAtLeast !== undefined) {
      if (cost === null || cost === undefined || !(cost >= rule.costAtLeast)) continue;
      specificity++;
    }
    if (!best || specificity > best.specificity) best = { rule, specificity };
  }
  return best?.rule ?? null;
}
