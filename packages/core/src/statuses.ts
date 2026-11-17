/**
 * The contractor's own 15 statuses (analysis 07, "current version") and the automatic suggestion table
 * (design 11 section 2, "Contractor status").
 */

export type StatusSide = 'contractor' | 'qf' | 'either';

export interface ContractorStatusDef {
  name: string;
  side: StatusSide;
}

export const CONTRACTOR_STATUSES: readonly ContractorStatusDef[] = [
  { name: 'Awaiting Information - TDGI', side: 'contractor' },
  { name: 'Awaiting Quote - TDGI', side: 'contractor' },
  { name: 'RFE to be submit - TDGI', side: 'contractor' },
  { name: 'RFE to be Resubmitted - TDGI', side: 'contractor' },
  { name: 'Awaiting Material - TDGI', side: 'contractor' },
  { name: 'Material received under planning - TDGI', side: 'contractor' },
  { name: 'Work In Progress - TDGI', side: 'contractor' },
  { name: 'Awaiting Approval - QF', side: 'qf' },
  { name: 'Awaiting Information - QF', side: 'qf' },
  { name: 'Awaiting Material - QF', side: 'qf' },
  { name: 'Awaiting budget code - QF', side: 'qf' },
  { name: 'Awaiting Access - QF', side: 'qf' },
  { name: 'Completed', side: 'either' },
  { name: 'Duplicate', side: 'either' },
  { name: 'To be cancelled', side: 'either' },
] as const;

export type ContractorStatus = (typeof CONTRACTOR_STATUSES)[number]['name'];

/** Facts the suggestion looks at. Everything is optional; unknown facts never produce a suggestion by themselves. */
export interface WrFacts {
  /** Marafiq "Work Request Status" text or code (e.g. "Assigned to Work Order", "Issued and In Process", "CC"). */
  wrStatus?: string | null;
  /** Marafiq "WR Descriptive Status", e.g. "2. SP : Awaiting Site Survey & Estimation". */
  descriptiveStatus?: string | null;
  estimatedTotalCost?: number | null;
  inspectionDone?: boolean;
  materialRequestRaised?: boolean;
  /** Required number of quotations is in. */
  quotationsComplete?: boolean;
  budgetCodeRequested?: boolean;
  budgetCodeReceived?: boolean;
  /** Estimate submitted in Marafiq ("With RFE?" = Yes or stage 3). */
  estimateSubmitted?: boolean;
  /** QF sent the estimate back (stage 4). */
  returnedByQf?: boolean;
  /** RFE approved (approval date present or stage 5). */
  rfeApproved?: boolean;
  /** Approved and an LPO exists: true = delivered, false = not yet delivered, undefined = no material tracking. */
  lpoDelivered?: boolean;
  workStarted?: boolean;
  /** Waiting for items that QF itself supplies. */
  waitingForQfSupply?: boolean;
  /** Contractor has completed the work (or Marafiq says so). */
  contractorCompleted?: boolean;
}

const stageOf = (d?: string | null): number | null => {
  const m = /^\s*(\d+)\s*[.\-)]/.exec(d ?? '');
  return m ? Number(m[1]) : null;
};

const ISSUED_RE = /issued|^i$/i;
const COMPLETED_RE = /^(contractor completed|completed|closed|cc|com|clo)$/i;
const ASSIGNED_RE = /^(assigned to work order|aa)$/i;

/**
 * Suggest the contractor status from the data. The rules are checked from the most advanced stage backwards,
 * so a WR that is already in progress is never suggested as "Awaiting Information". The owner can always
 * overwrite. Statuses that need a human reason (Awaiting Information - QF, Awaiting Access - QF, Duplicate,
 * To be cancelled) are never suggested.
 */
export function suggestContractorStatus(f: WrFacts): { status: ContractorStatus; reason: string } | null {
  const stage = stageOf(f.descriptiveStatus);
  const wrStatus = (f.wrStatus ?? '').trim();
  const cost = f.estimatedTotalCost ?? 0;

  if (f.contractorCompleted || COMPLETED_RE.test(wrStatus) || stage === 8) {
    return { status: 'Completed', reason: 'Work request is contractor completed (stage 8 / completed status).' };
  }
  if (f.returnedByQf || stage === 4) {
    return { status: 'RFE to be Resubmitted - TDGI', reason: 'QF sent the estimate back (stage 4).' };
  }
  const approved = f.rfeApproved || stage === 5;
  if (approved && f.lpoDelivered === true && !f.workStarted && !ISSUED_RE.test(wrStatus)) {
    return { status: 'Material received under planning - TDGI', reason: 'Estimate approved and material delivered; work not started.' };
  }
  if (approved && f.waitingForQfSupply) {
    return { status: 'Awaiting Material - QF', reason: 'Estimate approved; waiting for items QF supplies.' };
  }
  if (approved && f.lpoDelivered === false) {
    return { status: 'Awaiting Material - TDGI', reason: 'Estimate approved; LPO not yet delivered.' };
  }
  if (f.workStarted || ISSUED_RE.test(wrStatus)) {
    return { status: 'Work In Progress - TDGI', reason: 'Work request is issued and being worked.' };
  }
  if (f.estimateSubmitted || stage === 3) {
    return { status: 'Awaiting Approval - QF', reason: 'Estimate submitted to QF (stage 3).' };
  }
  if (f.budgetCodeRequested && !f.budgetCodeReceived) {
    return { status: 'Awaiting budget code - QF', reason: 'Budget code requested from the QF engineer and not yet received.' };
  }
  if (f.materialRequestRaised && !f.quotationsComplete) {
    return { status: 'Awaiting Quote - TDGI', reason: 'Material request raised; quotations not complete.' };
  }
  const assignedOrUnknown = wrStatus === '' || ASSIGNED_RE.test(wrStatus);
  if (assignedOrUnknown && cost === 0 && f.inspectionDone) {
    return { status: 'RFE to be submit - TDGI', reason: 'Assigned, cost 0, inspection done.' };
  }
  if (f.inspectionDone === false || (f.inspectionDone === undefined && assignedOrUnknown && stage === 2)) {
    return { status: 'Awaiting Information - TDGI', reason: 'New work request, no inspection yet.' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Matching free-typed status text to the 15 current statuses

const dash = (s: string) => s.replace(/[‐-―−]/g, '-');
const squash = (s: string) => dash(s).toLowerCase().replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
const compact = (s: string) => squash(s).replace(/[^a-z0-9]/g, '');

const CURRENT = CONTRACTOR_STATUSES.map((s) => ({ ...s, sq: squash(s.name), cp: compact(s.name) }));

/** Old versions and common variants that map to exactly one current status. */
const ALIASES: Record<string, ContractorStatus> = {
  'quote received rfe yet to submit': 'RFE to be submit - TDGI',
  'quote received rfe yet to submit - tdgi': 'RFE to be submit - TDGI',
  'rfe to be submitted - tdgi': 'RFE to be submit - TDGI',
  'rfe to be submitted': 'RFE to be submit - TDGI',
  'rfe to be submit': 'RFE to be submit - TDGI',
  'rfe to be re-submitted - tdgi': 'RFE to be Resubmitted - TDGI',
  'rfe to be re submitted - tdgi': 'RFE to be Resubmitted - TDGI',
  'rfe to be resubmit - tdgi': 'RFE to be Resubmitted - TDGI',
  'rfe to be resubmitted': 'RFE to be Resubmitted - TDGI',
  'wip - tdgi': 'Work In Progress - TDGI',
  'work in progress': 'Work In Progress - TDGI',
  'in progress - tdgi': 'Work In Progress - TDGI',
  'complete': 'Completed',
  'complete - tdgi': 'Completed',
  'completed - tdgi': 'Completed',
  'completed - qf': 'Completed',
  'to be canceled': 'To be cancelled',
  'to be cancel': 'To be cancelled',
  'cancel': 'To be cancelled',
  'duplicated': 'Duplicate',
};

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export type StatusMatch =
  | { kind: 'exact' | 'mapped'; status: ContractorStatus }
  | { kind: 'empty' }
  | { kind: 'unknown'; candidates: ContractorStatus[] };

/**
 * Map a typed status to one of the 15. Steps (all case-insensitive, dash variants and spacing ignored):
 * exact; alias table of old spellings; same letters ignoring spaces/dashes; typo of at most 2 edits to exactly one
 * status; the text without its "- TDGI" / "- QF" side that fits exactly one status. Anything else is reported.
 */
export function matchContractorStatus(raw: unknown): StatusMatch {
  const text = String(raw ?? '').trim();
  if (text === '') return { kind: 'empty' };
  const sq = squash(text);
  const exact = CURRENT.find((s) => s.sq === sq);
  if (exact) return { kind: 'exact', status: exact.name };
  const alias = ALIASES[sq];
  if (alias) return { kind: 'mapped', status: alias };
  const cp = compact(text);
  const same = CURRENT.filter((s) => s.cp === cp);
  if (same.length === 1) return { kind: 'mapped', status: same[0].name };
  // Without the side suffix: "Awaiting Material" fits two statuses (ambiguous), "Awaiting Approval" only one.
  const base = sq.replace(/ - (tdgi|qf)$/, "");
  if (base === sq) {
    const hits = CURRENT.filter((s) => s.sq.replace(/ - (tdgi|qf)$/, "") === base);
    if (hits.length === 1) return { kind: "mapped", status: hits[0].name };
    if (hits.length > 1) return { kind: "unknown", candidates: hits.map((h) => h.name) };
  }
  // Typos: nearest status within 2 edits and clearly nearest (no other within the same distance).
  const dists = CURRENT.map((s) => ({ s, d: levenshtein(cp, s.cp) })).sort((a, b) => a.d - b.d);
  if (dists[0].d <= 2 && dists[1].d > dists[0].d && cp.length >= 8) return { kind: 'mapped', status: dists[0].s.name };
  return { kind: 'unknown', candidates: [] };
}
