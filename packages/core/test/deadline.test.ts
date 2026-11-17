import { describe, expect, it } from 'vitest';
import { DEFAULT_DEADLINE_RULES, addWorkingDays, evaluateDeadline, pickRule, weekday, type DeadlineRule } from '../src/index.js';

const rule = (id: string) => DEFAULT_DEADLINE_RULES.find((r) => r.id === id) as DeadlineRule;

describe('calendar rule: RFE 14 days', () => {
  const r = rule('rfe_14');
  const ev = (today: string) => evaluateDeadline(r, { dateTradeAssigned: '2026-11-09' }, today);
  it('is the 14 day rule with warnings 8 and 11', () => {
    expect([r.limit, r.warnings]).toEqual([14, [8, 11]]);
  });
  it('day 7 green, 8 amber, 11 two warnings, 14 amber and not breached, 15 red', () => {
    expect(ev('2026-11-16')).toMatchObject({ dayNumber: 7, state: 'green', warningsDue: [], breached: false });
    expect(ev('2026-11-17')).toMatchObject({ dayNumber: 8, state: 'amber', warningsDue: [8] });
    expect(ev('2026-11-20')).toMatchObject({ dayNumber: 11, state: 'amber', warningsDue: [8, 11] });
    expect(ev('2026-11-23')).toMatchObject({ dayNumber: 14, state: 'amber', breached: false, dueDate: '2026-11-23' });
    expect(ev('2026-11-24')).toMatchObject({ dayNumber: 15, state: 'red', breached: true });
  });
  it('clock falls back to first seen', () => {
    expect(evaluateDeadline(r, { dateTradeAssigned: null, firstSeen: '2026-11-01' }, '2026-11-03')).toMatchObject({ dayNumber: 2, clockStart: '2026-11-01' });
    expect(evaluateDeadline(r, {}, '2026-11-03').clockStart).toBeNull();
  });
});

describe('working days (default Sunday to Thursday)', () => {
  const own = rule('take_ownership'); // 1 working day
  it('weekdays', () => {
    expect(weekday('2026-11-12')).toBe(4); // Thursday
    expect(weekday('2026-11-15')).toBe(0); // Sunday
  });
  it('Thursday start crosses the Friday/Saturday weekend', () => {
    const f = { dateTradeAssigned: '2026-11-12' };
    expect(evaluateDeadline(own, f, '2026-11-13').dayNumber).toBe(0);
    expect(evaluateDeadline(own, f, '2026-11-14').dayNumber).toBe(0);
    expect(evaluateDeadline(own, f, '2026-11-15')).toMatchObject({ dayNumber: 1, breached: false, dueDate: '2026-11-15', state: 'amber' });
    expect(evaluateDeadline(own, f, '2026-11-16')).toMatchObject({ dayNumber: 2, breached: true, state: 'red' });
  });
  it('5 working days from a Wednesday', () => {
    expect(evaluateDeadline(rule('submittal_approval'), { dateTradeAssigned: '2026-11-11' }, '2026-11-18')).toMatchObject({ dayNumber: 5, dueDate: '2026-11-18', breached: false });
  });
  it('configurable week and holidays', () => {
    const f = { dateTradeAssigned: '2026-11-13' }; // Friday
    expect(evaluateDeadline(own, f, '2026-11-16').dayNumber).toBe(2); // default week: Sun, Mon
    expect(evaluateDeadline(own, f, '2026-11-16', { workingDays: [1, 2, 3, 4, 5] }).dayNumber).toBe(1);
    expect(addWorkingDays('2026-11-12', 1, { holidays: ['2026-11-15'] })).toBe('2026-11-16');
  });
});

describe('date rules', () => {
  const p = rule('permit_expiry');
  const ev = (today: string) => evaluateDeadline(p, { dueDate: '2026-11-11' }, today);
  it('permit expiry warns 2 days before and on the day', () => {
    expect(ev('2026-11-08')).toMatchObject({ state: 'green', warningsDue: [] });
    expect(ev('2026-11-09')).toMatchObject({ state: 'amber', warningsDue: [2] });
    expect(ev('2026-11-11')).toMatchObject({ state: 'amber', warningsDue: [0, 2], breached: false });
    expect(ev('2026-11-12')).toMatchObject({ state: 'red', breached: true });
  });
});

describe('pickRule', () => {
  const id = (s: Parameters<typeof pickRule>[1]) => pickRule(DEFAULT_DEADLINE_RULES, s)?.id;
  it('by criterion and stage', () => {
    expect(id({ stage: 'estimate' })).toBe('rfe_14');
    expect(id({ criterion: 3 })).toBe('rfe_14');
    expect(id({ criterion: 4 })).toBe('rfe_20_new_requirement');
    expect(id({ criterion: 1 })).toBe('inspect_c1');
    expect(id({ criterion: 2, estimatedCost: 50 })).toBe('inspect_c2_low');
    expect(id({ criterion: 2, estimatedCost: 100 })).toBe('rfe_14');
    expect(id({ stage: 'permit' })).toBe('permit_expiry');
    expect(id({ stage: 'nonsense' })).toBeUndefined();
  });
});
