import { diffDays, type IsoDate } from './dates.js';
import { EXPORTS, type ListKey, type TypedRow } from './exports.js';

/** Event names of design 13 section 2. */
export type EventType =
  | 'wr.seen'
  | 'wr.changed'
  | 'wr.gone'
  | 'wr.stage_changed'
  | 'rfe.approved'
  | 'rfe.returned'
  | 'rfe.comment_received'
  | 'ptw.changed'
  | 'ptw.expiring'
  | 'money.changed';

export interface FieldChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

export interface MirrorEvent {
  type: EventType;
  listKey: ListKey;
  /** WR code (WR events, rfe.approved, rfe.returned, money.changed, rfe.comment_received), permit code (ptw.*). */
  key: string;
  /** The date of the import (`today`). */
  date: IsoDate;
  /** Changed fields (wr.changed, ptw.changed, money.changed) - field names are the typed-row property names. */
  changes?: FieldChange[];
  /** wr.stage_changed / rfe.returned: the old and new value of the stage field. */
  stageField?: string;
  from?: string | number | null;
  to?: string | number | null;
  /** Extra facts that help the notification text. */
  data?: Record<string, string | number | boolean | null>;
}

export interface DiffOptions {
  today: IsoDate;
  /** Date of the previous import (default: `today`). Used by ptw.expiring so a warning fires once, when the permit enters the window. */
  beforeToday?: IsoDate;
  /** ptw.expiring: first warning this many days before Date Upto (default 2, the same as Marafiq's orange). The second warning is on the day. */
  permitWarningDays?: number;
}

/**
 * Fields that mark the WR's stage, per list. A change in one of them raises `wr.stage_changed` (and not `wr.changed`).
 */
const STAGE_FIELDS: Partial<Record<ListKey, string[]>> = {
  pending_work_requests: ['wrStatus'],
  wr_dashboard: ['wrStatus', 'descriptiveStatus'],
  edit_update_wrs: ['workRequestStatus'],
  estimate_and_schedule: ['stepType'],
};

/** WR-keyed single-row lists that get wr.seen / wr.changed / wr.gone / wr.stage_changed. */
const WR_LISTS: ListKey[] = [
  'pending_work_requests',
  'wr_dashboard',
  'estimate_and_schedule',
  'edit_update_wrs',
  'issue_wr',
  'pending_rfe_status',
];

/** Money-trail columns of the End-to-End report; a change in any of them raises money.changed. */
const MONEY_FIELDS = [
  'demandNote', 'demandNoteStatus', 'poNumber', 'poDate', 'poStatus', 'prNumber', 'prDate', 'prStatus',
  'wccNumber', 'wccCompletionDate', 'wccStatus', 'invoiceNumber', 'invoiceStatus',
];

/** Fields ignored when comparing a row (identity + purely informational). */
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

function index(rows: TypedRow[], keyField: string): Map<string, TypedRow> {
  const m = new Map<string, TypedRow>();
  for (const r of rows) {
    const k = r[keyField];
    if (k !== null && k !== undefined) m.set(String(k), r); // a repeated key: the later row wins
  }
  return m;
}

function changesBetween(a: TypedRow, b: TypedRow, fields: string[]): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) if (!same(a[f], b[f])) out.push({ field: f, from: a[f] ?? null, to: b[f] ?? null });
  return out;
}

const byKeyThenType = (a: MirrorEvent, b: MirrorEvent) =>
  a.key.localeCompare(b.key, 'en', { numeric: true }) || a.type.localeCompare(b.type);

function fieldsOf(listKey: ListKey): { keyField: string; allFields: string[] } {
  const def = EXPORTS[listKey];
  const keyCol = def.columns.find((c) => c.caption.toLowerCase() === def.keyColumn.toLowerCase())!;
  return { keyField: keyCol.field, allFields: def.columns.map((c) => c.field) };
}

/**
 * Compare two imports of the SAME list and return the events.
 *  - `before` empty -> every row is "seen".
 *  - Identical files -> no events.
 *  - A WR missing from the new file of the same list -> `wr.gone`.
 *
 * Per list:
 *  - pending_work_requests, wr_dashboard, estimate_and_schedule, edit_update_wrs, issue_wr, pending_rfe_status:
 *    wr.seen (new WR) / wr.gone (WR not in the new file) / wr.stage_changed (a stage field changed: Work Request
 *    Status, WR Descriptive Status, Step Type) / wr.changed (any other mirrored field changed; `changes` lists them).
 *    A stage change is reported only as wr.stage_changed, so one change never notifies twice.
 *    wr_dashboard also raises `rfe.returned` when the descriptive status newly starts with "4." (QF sent the estimate back).
 *  - review_approved_estimations: `rfe.approved` when RFE Approved On appears or changes.
 *  - rfe_post_box: `rfe.comment_received` for each new Other Res. Log ID.
 *  - manage_permit_to_work: `ptw.changed` for a new permit or any changed field; `ptw.expiring` when the permit
 *    (not closed / cancelled / rejected / expired) moves into the 2-day window or reaches its last day.
 *  - end_to_end_wr_to_invoice: `money.changed` per WR when PR / PO / WCC / invoice numbers or statuses differ
 *    (rows of a WR are compared as sets).
 *  - boq_details: no events (a cost detail list).
 */
export function diffMirror(before: TypedRow[], after: TypedRow[], listKey: ListKey, opts: DiffOptions): MirrorEvent[] {
  const { today } = opts;
  const { keyField, allFields } = fieldsOf(listKey);
  const events: MirrorEvent[] = [];
  const ev = (e: Omit<MirrorEvent, 'listKey' | 'date'>) => events.push({ ...e, listKey, date: today });

  if (WR_LISTS.includes(listKey)) {
    const stageFields = STAGE_FIELDS[listKey] ?? [];
    const otherFields = allFields.filter((f) => f !== keyField && !stageFields.includes(f));
    const b = index(before, keyField);
    const a = index(after, keyField);
    for (const [k, row] of a) {
      const old = b.get(k);
      if (!old) {
        ev({ type: 'wr.seen', key: k, data: { status: stageFields.length ? ((row[stageFields[0]] as string | null) ?? null) : null } });
        continue;
      }
      for (const sf of stageFields) {
        if (!same(old[sf], row[sf])) {
          ev({ type: 'wr.stage_changed', key: k, stageField: sf, from: old[sf] ?? null, to: row[sf] ?? null });
        }
      }
      if (listKey === 'wr_dashboard') {
        const was = String(old.descriptiveStatus ?? '');
        const now = String(row.descriptiveStatus ?? '');
        if (/^\s*4\s*[.\-)]/.test(now) && !/^\s*4\s*[.\-)]/.test(was)) {
          ev({ type: 'rfe.returned', key: k, stageField: 'descriptiveStatus', from: old.descriptiveStatus ?? null, to: row.descriptiveStatus ?? null });
        }
      }
      const ch = changesBetween(old, row, otherFields);
      if (ch.length) ev({ type: 'wr.changed', key: k, changes: ch });
    }
    for (const k of b.keys()) if (!a.has(k)) ev({ type: 'wr.gone', key: k });
  } else if (listKey === 'review_approved_estimations') {
    const b = index(before, keyField);
    for (const row of index(after, keyField).values()) {
      const k = String(row.wrCode);
      if (!row.rfeApprovedOn) continue;
      const old = b.get(k);
      if (!old || !same(old.rfeApprovedOn, row.rfeApprovedOn)) {
        ev({
          type: 'rfe.approved',
          key: k,
          from: old?.rfeApprovedOn ?? null,
          to: row.rfeApprovedOn,
          data: { submittedOn: (row.rfeSubmittedOn as string | null) ?? null, siteCode: (row.siteCode as string | null) ?? null, buildingCode: (row.buildingCode as string | null) ?? null },
        });
      }
    }
  } else if (listKey === 'rfe_post_box') {
    const b = index(before, keyField);
    for (const row of index(after, keyField).values()) {
      if (b.has(String(row.logId))) continue;
      ev({
        type: 'rfe.comment_received',
        key: String(row.wrCode ?? row.logId),
        data: {
          logId: String(row.logId),
          comments: (row.comments as string | null) ?? null,
          createdBy: (row.createdBy as string | null) ?? null,
          sendTo: (row.sendTo as string | null) ?? null,
          dateCreated: (row.dateCreated as string | null) ?? null,
        },
      });
    }
  } else if (listKey === 'manage_permit_to_work') {
    const b = index(before, keyField);
    const warnDays = opts.permitWarningDays ?? 2;
    const beforeToday = opts.beforeToday ?? today;
    const level = (row: TypedRow | undefined, asOf: IsoDate): number => {
      if (!row || !row.dateUpto) return 0;
      if (/closed|cancel|reject|expired|complete/i.test(String(row.ptwStatus ?? ''))) return 0;
      const left = diffDays(asOf, String(row.dateUpto));
      return left <= 0 ? (left === 0 ? 2 : 0) : left <= warnDays ? 1 : 0;
    };
    for (const row of index(after, keyField).values()) {
      const k = String(row.ptwCode);
      const old = b.get(k);
      if (!old) {
        ev({ type: 'ptw.changed', key: k, data: { isNew: true, status: (row.ptwStatus as string | null) ?? null } });
      } else {
        const ch = changesBetween(old, row, allFields.filter((f) => f !== keyField));
        if (ch.length) ev({ type: 'ptw.changed', key: k, changes: ch });
      }
      // A date change resets the warnings: the old row is judged against its own Date Upto.
      const lvAfter = level(row, today);
      const lvBefore = old && same(old.dateUpto, row.dateUpto) ? level(old, beforeToday) : 0;
      if (lvAfter > lvBefore) {
        ev({ type: 'ptw.expiring', key: k, to: (row.dateUpto as string | null) ?? null, data: { daysLeft: diffDays(today, String(row.dateUpto)), onTheDay: lvAfter === 2 } });
      }
    }
  } else if (listKey === 'end_to_end_wr_to_invoice') {
    const group = (rows: TypedRow[]) => {
      const m = new Map<string, Map<string, Set<string>>>();
      for (const r of rows) {
        const k = String(r.wrCode ?? '');
        if (!k) continue;
        const fields = m.get(k) ?? new Map<string, Set<string>>();
        for (const f of MONEY_FIELDS) {
          const v = r[f];
          if (v !== null && v !== undefined && v !== '') (fields.get(f) ?? fields.set(f, new Set()).get(f)!).add(String(v));
        }
        m.set(k, fields);
      }
      return m;
    };
    const gb = group(before);
    const ga = group(after);
    const flat = (s?: Set<string>) => (s ? [...s].sort().join('; ') : null);
    for (const [k, fa] of ga) {
      const fb = gb.get(k);
      const ch: FieldChange[] = [];
      for (const f of MONEY_FIELDS) {
        const from = flat(fb?.get(f));
        const to = flat(fa.get(f));
        if (from !== to) ch.push({ field: f, from, to });
      }
      if (ch.length) ev({ type: 'money.changed', key: k, changes: ch, data: fb ? { isNew: false } : { isNew: true } });
    }
  }
  return events.sort(byKeyThenType);
}
