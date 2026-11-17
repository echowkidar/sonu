import { describe, expect, it } from 'vitest';
import { EXPORTS, LIST_KEYS, detectExport, parseExport, readSheet, parseDateCell, type ListKey } from '../src/index.js';
import { fx, makeBook } from './helpers.js';

const FILES: Record<ListKey, string> = {
  pending_work_requests: 'pending-work-requests.xlsx',
  review_approved_estimations: 'review-approved-estimations.xlsx',
  wr_dashboard: 'wr-dashboard.xlsx',
  estimate_and_schedule: 'estimate-and-schedule.xlsx',
  edit_update_wrs: 'edit-update-wrs.xlsx',
  issue_wr: 'issue-wr.xlsx',
  rfe_post_box: 'rfe-post-box.xlsx',
  pending_rfe_status: 'pending-rfe-status.xlsx',
  manage_permit_to_work: 'manage-permit-to-work.xlsx',
  end_to_end_wr_to_invoice: 'end-to-end-wr-to-invoice.xlsx',
  boq_details: 'boq-details.xlsx',
};

describe('export definitions', () => {
  it('has the right caption counts', () => {
    const n = (k: ListKey) => EXPORTS[k].captions.length;
    expect([n('pending_work_requests'), n('review_approved_estimations'), n('wr_dashboard'), n('estimate_and_schedule'), n('edit_update_wrs'), n('issue_wr'), n('rfe_post_box'), n('pending_rfe_status'), n('manage_permit_to_work'), n('end_to_end_wr_to_invoice'), n('boq_details')]).toEqual([26, 7, 22, 21, 28, 24, 11, 12, 17, 39, 27]);
  });
  it('key column and required are part of the captions, fields unique', () => {
    for (const k of LIST_KEYS) {
      const d = EXPORTS[k];
      expect(d.captions).toContain(d.keyColumn);
      for (const r of d.required) expect(d.captions).toContain(r);
      expect(new Set(d.columns.map((c) => c.field)).size).toBe(d.columns.length);
    }
  });
});

describe('every parser on its fixture', () => {
  for (const k of LIST_KEYS) {
    it(k, () => {
      const r = parseExport(k, fx(FILES[k]), FILES[k]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.listKey).toBe(k);
      expect(r.rows.length).toBeGreaterThan(0);
      expect(r.rowsRead).toBe(r.rows.length);
      expect(r.warnings).toEqual([]);
      expect(detectExport(readSheet(fx(FILES[k])).captions)).toBe(k);
    });
  }

  it('pending work requests: typed values', () => {
    const r = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
    if (!r.ok) throw new Error('not ok');
    expect(r.rows).toHaveLength(60);
    const first = r.rows[0];
    expect(first.wrCode).toBe('9100001');
    expect(first.dateRequested).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof first.estimatedTotalCost).toBe('number');
    expect(first.requestor).toBe('Requestor 001');
    expect(r.rows[59].wrCode).toBe('0100060');
    expect(r.rows.filter((x) => x.targetDate === null).length).toBe(3);
  });

  it('reads the legacy .xls the same as the .xlsx', () => {
    const a = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
    const b = parseExport('pending_work_requests', fx('pending-work-requests.xls'), 'x.xls');
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.rows).toEqual(a.rows);
  });

  it('finds the header below title rows', () => {
    expect(readSheet(fx('pending-work-requests-title-rows.xlsx')).headerRow).toBe(4);
    const a = parseExport('pending_work_requests', fx('pending-work-requests.xlsx'));
    const b = parseExport('pending_work_requests', fx('pending-work-requests-title-rows.xlsx'));
    if (!(a.ok && b.ok)) throw new Error('not ok');
    expect(b.rows).toEqual(a.rows);
  });
});

describe('all-or-nothing', () => {
  it('a renamed caption fails the file, names it, returns no rows', () => {
    const r = parseExport('pending_work_requests', fx('pending-work-requests-renamed-column.xlsx'), 'renamed.xlsx');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('MISSING_CAPTION');
    expect(r.error.missingCaptions).toEqual(['Agreed Target Date']);
    expect(r.error.message).toContain('Agreed Target Date');
    expect('rows' in r).toBe(false);
    expect(detectExport(readSheet(fx('pending-work-requests-renamed-column.xlsx')).captions)).toBe('pending_work_requests');
  });
  it('a missing column is named', () => {
    const caps = EXPORTS.review_approved_estimations.captions.filter((c) => c !== 'RFE Approved On');
    const r = parseExport('review_approved_estimations', makeBook([caps, ['9100001', 'ECSQ', 'B1', '01/10/2026', 'WT', 'd']]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.missingCaptions).toEqual(['RFE Approved On']);
  });
  it('case and spacing are ignored, a rename is not', () => {
    const caps = EXPORTS.review_approved_estimations.captions.map((c, i) => (i === 3 ? '  rfe   SUBMITTED on ' : c));
    const r = parseExport('review_approved_estimations', makeBook([caps, ['9100001', 'S', 'B', '01/10/2026', '05/10/2026', 'W', 'd']]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].rfeSubmittedOn).toBe('2026-10-01');
    const renamed = EXPORTS.review_approved_estimations.captions.map((c, i) => (i === 3 ? 'RFE Submitted Date' : c));
    expect(parseExport('review_approved_estimations', makeBook([renamed, ['9100001']])).ok).toBe(false);
  });
  it('wrong, unreadable and empty files', () => {
    const wrong = parseExport('pending_work_requests', makeBook([['a', 'b'], [1, 2]]));
    expect(!wrong.ok && wrong.error.code).toBe('UNKNOWN_FILE');
    const garbage = parseExport('pending_work_requests', Buffer.from('not a workbook at all'));
    expect(garbage.ok).toBe(false);
    const empty = parseExport('review_approved_estimations', makeBook([EXPORTS.review_approved_estimations.captions]));
    expect(!empty.ok && empty.error.code).toBe('EMPTY');
  });
  it('rows without a key are skipped with a warning', () => {
    const caps = EXPORTS.review_approved_estimations.captions;
    const r = parseExport('review_approved_estimations', makeBook([caps, ['9100001', 'S', 'B', '2026-10-01', '2026-10-02', 'W', 'd'], [null, 'S', 'B', '2026-10-01', '2026-10-02', 'W', 'd']]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(1);
      expect(r.rowsRead).toBe(2);
      expect(r.warnings[0]).toContain('Work Request Code');
    }
  });
  it('detectExport: unknown captions give null', () => {
    expect(detectExport(['Foo', 'Bar', 'Baz'])).toBeNull();
  });
});

describe('dates and numbers', () => {
  const ok = (v: unknown) => parseDateCell(v).value;
  it('excel serials', () => {
    expect(ok(46335)).toBe('2026-11-09');
    expect(ok(45658)).toBe('2025-01-01');
  });
  it('JS dates', () => {
    expect(ok(new Date(Date.UTC(2026, 10, 9)))).toBe('2026-11-09');
    expect(ok(new Date(2026, 10, 9, 0, 0, 0))).toBe('2026-11-09');
  });
  it('text dates', () => {
    for (const s of ['09/11/2026', '09-11-2026', '09.11.2026', '2026-11-09', '2026-11-09T10:30:00', '09/11/2026 14:05', '09-Nov-2026']) expect(ok(s)).toBe('2026-11-09');
    expect(ok('9/1/2026')).toBe('2026-01-09');
  });
  it('blank is ok-null, nonsense is not ok', () => {
    expect(parseDateCell('')).toEqual({ ok: true, value: null });
    expect(parseDateCell('11/25/2026').ok).toBe(false);
    expect(parseDateCell('31/02/2026').ok).toBe(false);
    expect(parseDateCell('soon').ok).toBe(false);
  });
  it('mixed date forms in one parsed file', () => {
    const caps = EXPORTS.review_approved_estimations.captions;
    const r = parseExport('review_approved_estimations', makeBook([caps, ['1', 'S', 'B', '09/11/2026', 46335, 'W', 'd'], ['2', 'S', 'B', '2026-11-09', '2026-11-10', 'W', 'd'], ['3', 'S', 'B', 'bad', null, 'W', 'd']]));
    if (!r.ok) throw new Error('not ok');
    expect(r.rows.map((x) => [x.rfeSubmittedOn, x.rfeApprovedOn])).toEqual([['2026-11-09', '2026-11-09'], ['2026-11-09', '2026-11-10'], [null, null]]);
    expect(r.warnings.some((w) => w.includes('RFE Submitted On'))).toBe(true);
  });
  it('numbers', () => {
    const caps = EXPORTS.pending_rfe_status.captions;
    const row = caps.map((c) => (c === 'Work Request Code' ? '1' : c === 'RFE Amount' ? '1,234.50' : c === 'Total Amount' ? 99 : null));
    const r = parseExport('pending_rfe_status', makeBook([caps, row]));
    if (!r.ok) throw new Error('not ok');
    expect([r.rows[0].rfeAmount, r.rows[0].totalAmount]).toEqual([1234.5, 99]);
  });
});
