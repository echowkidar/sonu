/**
 * Calendar-date helpers. A "date" in this library is always an ISO string `YYYY-MM-DD`.
 * All arithmetic is whole-day arithmetic on UTC day numbers, so there is no time-zone or
 * daylight-saving drift.
 */

export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  return validYmd(+m[1], +m[2], +m[3]);
}

export function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Day number (days since 1970-01-01) of an ISO date. */
export function dayNumber(iso: IsoDate): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

export function fromDayNumber(n: number): IsoDate {
  const d = new Date(n * 86400000);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  return fromDayNumber(dayNumber(iso) + n);
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return dayNumber(b) - dayNumber(a);
}

/** Day of week of an ISO date: 0 = Sunday ... 6 = Saturday. */
export function weekday(iso: IsoDate): number {
  return (((dayNumber(iso) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)
}

/** Today's calendar date in the given IANA time zone (default Qatar). */
export function todayInZone(tz = 'Asia/Qatar', now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Convert a cell value to an ISO date.
 *  - number: Excel serial day number (1900 date system, with the 1900 leap-year quirk: serial 61 = 1900-03-01)
 *  - Date: its calendar date. A Date at UTC midnight is read with UTC parts; any other Date is read with
 *    its local parts (a date typed in a local-time spreadsheet tool).
 *  - string: `yyyy-mm-dd` (optional time part), `dd/mm/yyyy` (also `-` or `.` separators, optional time part),
 *    `dd-Mon-yyyy` / `dd Mon yyyy`. Day-first only: `11/25/2026` is rejected, never guessed.
 * Returns null for blank or unrecognised values; `ok` tells the two apart.
 */
export function parseDateCell(v: unknown): { ok: boolean; value: IsoDate | null } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { ok: false, value: null };
    const utcMidnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
    const y = utcMidnight ? v.getUTCFullYear() : v.getFullYear();
    const m = utcMidnight ? v.getUTCMonth() + 1 : v.getMonth() + 1;
    const d = utcMidnight ? v.getUTCDate() : v.getDate();
    return { ok: true, value: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1 || v >= 100000) return { ok: false, value: null };
    const serial = Math.floor(v);
    // Excel 1900 system: serial 60 is the non-existent 1900-02-29; day 61 = 1900-03-01 -> epoch 1899-12-30.
    const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
    const iso = fromDayNumber(Math.round(ms / 86400000));
    return { ok: true, value: iso };
  }
  if (typeof v === 'string') {
    const s = v.trim().replace(/\s+/g, ' ');
    if (s === '') return { ok: true, value: null };
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
    if (m) return mk(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?: .*)?$/.exec(s);
    if (m) return mk(+m[3], +m[2], +m[1]);
    m = /^(\d{1,2})[ \-/]([A-Za-z]{3})[A-Za-z]*[ \-/,]+(\d{4})(?: .*)?$/.exec(s);
    if (m) {
      const mi = MONTHS.indexOf(m[2].toLowerCase());
      if (mi >= 0) return mk(+m[3], mi + 1, +m[1]);
    }
    if (/^\d+(\.\d+)?$/.test(s)) return parseDateCell(Number(s));
    return { ok: false, value: null };
  }
  return { ok: false, value: null };
}

function mk(y: number, m: number, d: number): { ok: boolean; value: IsoDate | null } {
  if (!validYmd(y, m, d)) return { ok: false, value: null };
  return { ok: true, value: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** `YYYY-MM` of an ISO date. */
export function monthKey(iso: IsoDate): string {
  return iso.slice(0, 7);
}
