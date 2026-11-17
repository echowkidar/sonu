/**
 * Read schedule (design 14 §4.2 starting values, editable by the contractor admin).
 * Service hours 07:30–15:30 on service days (Sun–Thu by default); intervals in minutes; null = not read then.
 */
import { z } from 'zod';
import { hhmmToMinutes, inWindow, localTime } from '../comm/time.js';
import { MARAFIQ_LIST_KEYS, type MarafiqListKey } from './lists.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');
const minutes = z.number().int().min(15).max(10_080);

export const scheduleSchema = z
  .object({
    serviceHours: z.object({ start: hhmm, end: hhmm }).strict(),
    /** 0 = Sunday … 6 = Saturday */
    serviceDays: z.array(z.number().int().min(0).max(6)).max(7),
    lists: z.record(z.string(), z.object({ inHoursMinutes: minutes.nullable(), outHoursMinutes: minutes.nullable() }).strict()),
  })
  .strict();
export type Schedule = z.infer<typeof scheduleSchema>;

const WR_GROUP = { inHoursMinutes: 30, outHoursMinutes: 60 };
const RFE_GROUP = { inHoursMinutes: 30, outHoursMinutes: 120 };
const DAILY = { inHoursMinutes: 1440, outHoursMinutes: null };

export const DEFAULT_LIST_INTERVALS: Record<MarafiqListKey, { inHoursMinutes: number | null; outHoursMinutes: number | null }> = {
  pending_work_requests: WR_GROUP,
  wr_dashboard: WR_GROUP,
  estimate_and_schedule: WR_GROUP,
  edit_update_wrs: WR_GROUP,
  issue_wr: WR_GROUP,
  rfe_post_box: RFE_GROUP,
  pending_rfe_status: RFE_GROUP,
  review_approved_estimations: RFE_GROUP,
  manage_permit_to_work: { inHoursMinutes: 30, outHoursMinutes: 60 },
  end_to_end_wr_to_invoice: DAILY,
  boq_details: DAILY,
};

export function defaultSchedule(): Schedule {
  return {
    serviceHours: { start: '07:30', end: '15:30' },
    serviceDays: [0, 1, 2, 3, 4],
    lists: Object.fromEntries(MARAFIQ_LIST_KEYS.map((k) => [k, { ...DEFAULT_LIST_INTERVALS[k] }])),
  };
}

/** Stored JSON (possibly partial / empty) merged over the defaults. */
export function effectiveSchedule(stored: unknown): Schedule {
  const d = defaultSchedule();
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Schedule>;
  return {
    serviceHours: s.serviceHours ?? d.serviceHours,
    serviceDays: s.serviceDays ?? d.serviceDays,
    lists: { ...d.lists, ...(s.lists ?? {}) },
  };
}

/** Lists due now, given the time each list was last requested (null = never). */
export function dueLists(
  schedule: Schedule,
  enabled: readonly string[],
  lastRequested: Map<string, Date>,
  now: Date,
  timeZone: string,
): string[] {
  const lt = localTime(now, timeZone);
  const start = hhmmToMinutes(schedule.serviceHours.start) ?? 450;
  const end = hhmmToMinutes(schedule.serviceHours.end) ?? 930;
  const inHours = schedule.serviceDays.includes(lt.weekday) && inWindow(lt.minutes, start, end);
  const due: string[] = [];
  for (const key of enabled) {
    const iv = schedule.lists[key];
    if (!iv) continue;
    const every = inHours ? iv.inHoursMinutes : iv.outHoursMinutes;
    if (every === null) continue;
    const last = lastRequested.get(key);
    if (!last || now.getTime() - last.getTime() >= every * 60_000 - 30_000) due.push(key);
  }
  return due;
}
