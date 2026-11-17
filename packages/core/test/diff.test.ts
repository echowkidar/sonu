import { describe, expect, it } from 'vitest';
import { diffMirror, parseExport, type ListKey, type TypedRow } from '../src/index.js';
import { fx, fxJson } from './helpers.js';

const rows = (k: ListKey, f: string): TypedRow[] => {
  const r = parseExport(k, fx(f));
  if (!r.ok) throw new Error(`parse ${f}`);
  return r.rows;
};
const T = '2026-11-09';

describe('diffMirror: pending_work_requests', () => {
  const a = rows('pending_work_requests', 'pending-work-requests.xlsx');
  const b = rows('pending_work_requests', 'pending-work-requests-changed.xlsx');
  it('original -> changed gives exactly the documented events', () => {
    const exp = fxJson('expected-events.json').events as { type: string; key: string; fields?: string[] }[];
    const got = diffMirror(a, b, 'pending_work_requests', { today: T }).map((e) => ({
      type: e.type,
      key: e.key,
      ...(e.type === 'wr.changed' ? { fields: e.changes!.map((c) => c.field) } : {}),
    }));
    expect(got).toEqual(exp);
  });
  it('identical re-import raises nothing', () => {
    expect(diffMirror(a, a, 'pending_work_requests', { today: T })).toEqual([]);
    expect(diffMirror(b, b, 'pending_work_requests', { today: T })).toEqual([]);
  });
  it('a WR missing from the new file is wr.gone; first import sees everything', () => {
    expect(diffMirror(a, a.slice(1), 'pending_work_requests', { today: T }).map((e) => [e.type, e.key])).toEqual([['wr.gone', '9100001']]);
    expect(diffMirror([], a, 'pending_work_requests', { today: T }).filter((e) => e.type === 'wr.seen')).toHaveLength(60);
  });
});

describe('diffMirror: other lists', () => {
  it('rfe.approved when the approval date appears', () => {
    const a = rows('review_approved_estimations', 'review-approved-estimations.xlsx');
    const noDate = a.filter((r) => r.rfeApprovedOn === null);
    expect(noDate.length).toBeGreaterThan(0);
    expect(diffMirror(a, a, 'review_approved_estimations', { today: T })).toEqual([]);
    const after = a.map((r) => (r === noDate[0] ? { ...r, rfeApprovedOn: '2026-11-09' } : r));
    const ev = diffMirror(a, after, 'review_approved_estimations', { today: T });
    expect(ev.map((e) => [e.type, e.key])).toEqual([['rfe.approved', String(noDate[0].wrCode)]]);
    expect(diffMirror([], a, 'review_approved_estimations', { today: T }).length).toBe(a.length - noDate.length);
  });
  it('rfe.returned when the descriptive status becomes stage 4, with a stage change', () => {
    const a = rows('wr_dashboard', 'wr-dashboard.xlsx');
    const i = a.findIndex((r) => !String(r.descriptiveStatus).startsWith('4'));
    const after = a.map((r, k) => (k === i ? { ...r, descriptiveStatus: '4. SP : Awaiting Estimation Re-Submission' } : r));
    const t = diffMirror(a, after, 'wr_dashboard', { today: T }).map((e) => e.type).sort();
    expect(t).toEqual(['rfe.returned', 'wr.stage_changed']);
  });
  it('rfe.comment_received for a new log id', () => {
    const a = rows('rfe_post_box', 'rfe-post-box.xlsx');
    const extra = { ...a[0], logId: '699999', comments: 'New test comment' };
    const ev = diffMirror(a, [...a, extra], 'rfe_post_box', { today: T });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'rfe.comment_received', data: { logId: '699999', comments: 'New test comment' } });
    expect(diffMirror(a, a, 'rfe_post_box', { today: T })).toEqual([]);
  });
  it('ptw.changed and ptw.expiring', () => {
    const a = rows('manage_permit_to_work', 'manage-permit-to-work.xlsx');
    const first = diffMirror([], a, 'manage_permit_to_work', { today: T }).filter((e) => e.type === 'ptw.expiring');
    // Date Upto at +0, +1, +2 enter the window; +3, +10 do not; the expired one never does.
    expect(first.map((e) => e.key).sort()).toEqual(['PTW-TEST-002', 'PTW-TEST-003', 'PTW-TEST-004']);
    expect(diffMirror(a, a, 'manage_permit_to_work', { today: T })).toEqual([]);
    // Next morning, same data: the permit with 3 days left enters the window, the one on its last day fires again at level 2.
    const next = diffMirror(a, a, 'manage_permit_to_work', { today: '2026-11-10', beforeToday: T });
    expect(next.map((e) => e.key).sort()).toEqual(['PTW-TEST-003', 'PTW-TEST-005']);
    const changed = a.map((r, k) => (k === 5 ? { ...r, ptwStatus: 'Closed' } : r));
    const ev = diffMirror(a, changed, 'manage_permit_to_work', { today: T });
    expect(ev.map((e) => [e.type, e.changes?.[0].field])).toEqual([['ptw.changed', 'ptwStatus']]);
  });
  it('money.changed when PO or invoice data changes', () => {
    const a = rows('end_to_end_wr_to_invoice', 'end-to-end-wr-to-invoice.xlsx');
    expect(diffMirror(a, a, 'end_to_end_wr_to_invoice', { today: T })).toEqual([]);
    const after = a.map((r, k) => (k === 0 ? { ...r, invoiceNumber: 'INV-TEST-1', invoiceStatus: 'Paid' } : r));
    const ev = diffMirror(a, after, 'end_to_end_wr_to_invoice', { today: T });
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('money.changed');
    expect(ev[0].changes!.map((c) => c.field).sort()).toEqual(['invoiceNumber', 'invoiceStatus']);
  });
});
