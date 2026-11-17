/** Local-time helpers in a contractor's time zone (default Asia/Qatar). No DST handling is needed for Qatar. */

export interface LocalTime {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** Local date YYYY-MM-DD. */
  date: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localTime(now: Date, timeZone = 'Asia/Qatar'): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localTime(now, 'Asia/Qatar');
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return {
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    minutes: hour * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** "HH:MM" or "HH:MM:SS" → minutes since midnight; null when empty/invalid. */
export function hhmmToMinutes(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True when `minutes` lies in [start, end) — the window may wrap past midnight (21:00–07:00). */
export function inWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * When now is inside the quiet window, the moment the window ends; otherwise null.
 */
export function quietUntil(now: Date, timeZone: string, start: string | null | undefined, end: string | null | undefined): Date | null {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s === null || e === null) return null;
  const lt = localTime(now, timeZone);
  if (!inWindow(lt.minutes, s, e)) return null;
  const wait = (e - lt.minutes + 1440) % 1440;
  const at = new Date(now.getTime() + wait * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}
