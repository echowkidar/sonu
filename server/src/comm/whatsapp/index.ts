/**
 * WhatsApp behind ONE interface, chosen per contractor by messaging_settings.whatsapp_mode.
 *
 *   const wa = await getWhatsAppChannel(app, contractorId);
 *   if (wa.sendText) await wa.sendText('+97455550199', 'WR 123456 assigned to you');   // linked + connected
 *   else link = wa.buildLink('+97455550199', 'WR 123456 assigned to you');           // click to chat
 *
 * Linked session not connected → automatic fallback to click to chat (fallbackToClickToChat: true).
 */
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db.js';
import { localTime } from '../time.js';
import { buildWaLink, maskNumber, normalizeNumber } from './link.js';
import type { LinkedState, WaMode, WaStatus, WhatsAppChannel } from './types.js';
import { WaConsentError, WaRateLimitedError } from './types.js';

export * from './types.js';
export { buildWaLink, normalizeNumber, qrSvg, maskNumber } from './link.js';
export { WhatsAppManager, LinkedSession } from './linked.js';
export { loadBaileys } from './baileys.js';

/** Hard caps for the linked-session rate limit (admins choose within these). */
export const WA_HARD_CAPS = { minIntervalSecondsMin: 10, minIntervalSecondsMax: 3600, dailyLimitMin: 1, dailyLimitMax: 500 } as const;
export const WA_DEFAULTS = { minIntervalSeconds: 20, dailyLimit: 200 } as const;

/** Shown by the admin panel exactly as written (design 14 §5, "WhatsApp mode"). */
export const LINKED_SESSION_WARNING =
  "Linked session (QR scan) is unofficial and against WhatsApp's terms: the number can be banned and the session can drop. " +
  'Use a separate number, only for contacts who agreed, at a slow rate.';

export interface WaSettingsRow {
  contractor_id: string;
  whatsapp_mode: WaMode;
  linked_session_state: string;
  wa_min_interval_seconds: number;
  wa_daily_limit: number;
  wa_linked_number: string | null;
  wa_last_error: string | null;
  wa_last_sent_at: Date | null;
  wa_sent_day: string | null;
  wa_sent_today: number;
  time_zone: string;
}

export async function waSettings(db: Queryable, contractorId: string): Promise<WaSettingsRow> {
  await db.query('INSERT INTO messaging_settings (contractor_id) VALUES ($1) ON CONFLICT DO NOTHING', [contractorId]);
  const r = await db.query<WaSettingsRow>(
    `SELECT m.contractor_id, m.whatsapp_mode, m.linked_session_state, m.wa_min_interval_seconds, m.wa_daily_limit, m.wa_linked_number,
            m.wa_last_error, m.wa_last_sent_at, to_char(m.wa_sent_day, 'YYYY-MM-DD') AS wa_sent_day, m.wa_sent_today, c.time_zone
       FROM messaging_settings m JOIN contractor c ON c.id = m.contractor_id WHERE m.contractor_id = $1`,
    [contractorId],
  );
  return r.rows[0]!;
}

const LINKED_STATES: LinkedState[] = ['off', 'qr_pending', 'connecting', 'connected', 'disconnected', 'banned_or_logged_out'];

/**
 * Status without loading the library (unless `checkAvailability` and the mode is linked_session).
 */
export async function whatsappStatus(app: FastifyInstance, contractorId: string, opts: { checkAvailability?: boolean; now?: Date } = {}): Promise<WaStatus> {
  const s = await waSettings(app.db, contractorId);
  const session = app.comm.whatsapp.get(contractorId);
  const today = localTime(opts.now ?? new Date(), s.time_zone).date;
  let state: LinkedState = 'off';
  if (s.whatsapp_mode === 'linked_session') {
    state = session ? session.state : LINKED_STATES.includes(s.linked_session_state as LinkedState) ? (s.linked_session_state as LinkedState) : 'off';
    // A stored "connected" without a live socket (e.g. after a restart) is not connected.
    if (!session && (state === 'connected' || state === 'connecting' || state === 'qr_pending')) state = 'disconnected';
  }
  let available: boolean | null = null;
  let reason: string | null = null;
  if (s.whatsapp_mode === 'linked_session' && opts.checkAvailability) {
    ({ available, reason } = await app.comm.whatsapp.availability());
  }
  return {
    mode: s.whatsapp_mode,
    state,
    available,
    reason,
    linkedNumber: maskNumber(session?.number ?? s.wa_linked_number),
    lastError: session?.lastError ?? s.wa_last_error,
    sentToday: s.wa_sent_day === today ? s.wa_sent_today : 0,
    dailyLimit: s.wa_daily_limit,
    minIntervalSeconds: s.wa_min_interval_seconds,
    fallbackToClickToChat: s.whatsapp_mode === 'linked_session' && state !== 'connected',
  };
}

/** True when the number belongs to someone of this contractor who agreed to WhatsApp messages. */
export async function hasWhatsAppConsent(db: Queryable, contractorId: string, digits: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM app_user
      WHERE contractor_id = $1 AND status = 'active' AND notify_whatsapp
        AND regexp_replace(coalesce(mobile, ''), '\\D', '', 'g') IN ($2, $3)
     UNION ALL
     SELECT 1 FROM sub_contact
      WHERE contractor_id = $1 AND consent
        AND (regexp_replace(coalesce(whatsapp, ''), '\\D', '', 'g') IN ($2, $3) OR regexp_replace(mobile, '\\D', '', 'g') IN ($2, $3))
     LIMIT 1`,
    [contractorId, digits, digits.startsWith('974') ? digits.slice(3) : digits],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Reserves one send slot (min interval + daily limit, per contractor). Throws WaRateLimitedError with the
 * earliest retry time when no slot is free.
 */
export async function reserveWhatsAppSlot(db: Queryable, contractorId: string, now: Date = new Date()): Promise<void> {
  const s = await waSettings(db, contractorId);
  const lt = localTime(now, s.time_zone);
  const r = await db.query(
    `UPDATE messaging_settings SET wa_last_sent_at = $2,
            wa_sent_today = CASE WHEN wa_sent_day = $3::date THEN wa_sent_today + 1 ELSE 1 END,
            wa_sent_day = $3::date
      WHERE contractor_id = $1
        AND (wa_last_sent_at IS NULL OR wa_last_sent_at <= $2::timestamptz - make_interval(secs => wa_min_interval_seconds))
        AND (wa_sent_day IS DISTINCT FROM $3::date OR wa_sent_today < wa_daily_limit)`,
    [contractorId, now, lt.date],
  );
  if (r.rowCount) return;
  if (s.wa_sent_day === lt.date && s.wa_sent_today >= s.wa_daily_limit) {
    const nextMidnight = new Date(now.getTime() + (1440 - lt.minutes) * 60_000);
    throw new WaRateLimitedError(nextMidnight, `daily limit of ${s.wa_daily_limit} reached`);
  }
  const last = s.wa_last_sent_at ? new Date(s.wa_last_sent_at).getTime() : now.getTime();
  throw new WaRateLimitedError(new Date(last + s.wa_min_interval_seconds * 1000), `one message per ${s.wa_min_interval_seconds} s`);
}

function clickToChat(app: FastifyInstance, contractorId: string): WhatsAppChannel {
  return {
    mode: 'click_to_chat',
    status: () => whatsappStatus(app, contractorId),
    buildLink: (to, text) => buildWaLink(to, text),
  };
}

/** The channel for a contractor. Never loads the WhatsApp library. */
export async function getWhatsAppChannel(app: FastifyInstance, contractorId: string): Promise<WhatsAppChannel> {
  const s = await waSettings(app.db, contractorId);
  if (s.whatsapp_mode !== 'linked_session') return clickToChat(app, contractorId);
  const session = app.comm.whatsapp.get(contractorId);
  if (!session || session.state !== 'connected') {
    // Automatic fallback: links instead of sending.
    return { ...clickToChat(app, contractorId), mode: 'linked_session', sendText: undefined };
  }
  return {
    mode: 'linked_session',
    status: () => whatsappStatus(app, contractorId),
    buildLink: (to, text) => buildWaLink(to, text),
    async sendText(to, text) {
      const digits = normalizeNumber(to);
      if (!digits) throw new Error('invalid phone number');
      if (!(await hasWhatsAppConsent(app.db, contractorId, digits))) throw new WaConsentError();
      await reserveWhatsAppSlot(app.db, contractorId, app.comm.now());
      return session.sendText(`${digits}@s.whatsapp.net`, text);
    },
  };
}
