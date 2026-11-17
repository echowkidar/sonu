/**
 * Linked-session driver (QR scan). One LinkedSession per contractor, held by the WhatsAppManager.
 *
 * - The library is loaded lazily through the manager's loader (never in click-to-chat mode).
 * - The session auth state lives ENCRYPTED in table secret (purpose 'whatsapp.session'); nothing on disk.
 * - States: off | qr_pending | connecting | connected | disconnected | banned_or_logged_out
 *   (mirrored to messaging_settings.linked_session_state for the status endpoint).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../../db.js';
import { deleteSecret, putSecret, readSecret } from '../../secrets.js';
import type { LinkedState, WaAuthState, WaLibrary, WaLibraryLoader, WaSocketLike } from './types.js';
import { WaNotConnectedError } from './types.js';

export const QR_TTL_MS = 60_000;
const MAX_RECONNECTS = 5;

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'unknown error');
  return msg.split('\n')[0]!.slice(0, 200);
}

function statusCodeOf(err: any): number | undefined {
  const c = err?.output?.statusCode ?? err?.statusCode ?? err?.data?.statusCode;
  return typeof c === 'number' ? c : undefined;
}

export interface LinkedSessionOptions {
  db: Pool;
  contractorId: string;
  lib: WaLibrary;
  log: FastifyBaseLogger;
  /** Re-open the socket after a drop (off in tests unless they test it). */
  reconnect: boolean;
}

export class LinkedSession {
  state: LinkedState = 'off';
  qr: string | null = null;
  qrExpiresAt: Date | null = null;
  lastError: string | null = null;
  number: string | null = null;
  sock: WaSocketLike | null = null;
  private stopped = false;
  private reconnects = 0;
  private creds: any = null;
  private keys: Record<string, Record<string, any>> = {};
  private secretId: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: LinkedSessionOptions) {}

  /** Serialises DB writes (state, session blob) in order. */
  private enqueue(fn: () => Promise<unknown>): Promise<unknown> {
    this.chain = this.chain.then(fn).catch((err) => this.o.log.warn({ err: errText(err) }, 'whatsapp session store failed'));
    return this.chain;
  }

  /** Waits until all queued DB writes are done (tests, logout). */
  flush(): Promise<unknown> {
    return this.chain;
  }

  private setState(s: LinkedState, error?: string | null) {
    this.state = s;
    if (error !== undefined) this.lastError = error;
    const lastError = this.lastError;
    const number = this.number;
    void this.enqueue(() =>
      this.o.db.query(
        `UPDATE messaging_settings SET linked_session_state = $2, wa_last_error = $3, wa_linked_number = COALESCE($4, wa_linked_number) WHERE contractor_id = $1`,
        [this.o.contractorId, s, lastError, number],
      ),
    );
    for (const l of this.listeners.splice(0)) l();
  }

  async start(): Promise<void> {
    this.stopped = false;
    const row = (await this.o.db.query<{ wa_session_secret_id: string | null }>(
      'SELECT wa_session_secret_id FROM messaging_settings WHERE contractor_id = $1',
      [this.o.contractorId],
    )).rows[0];
    this.secretId = row?.wa_session_secret_id ?? null;
    const blob = await readSecret(this.o.db, this.secretId, this.o.contractorId).catch(() => null);
    if (blob) {
      const parsed = this.o.lib.deserialize(blob);
      this.creds = parsed?.creds ?? this.o.lib.initAuthCreds();
      this.keys = parsed?.keys ?? {};
    } else {
      this.creds = this.o.lib.initAuthCreds();
      this.keys = {};
    }
    this.open();
  }

  private authState(): WaAuthState {
    return {
      creds: this.creds,
      keys: {
        get: async (type, ids) => {
          const out: Record<string, any> = {};
          for (const id of ids) {
            const v = this.keys[type]?.[id];
            out[id] = v === undefined ? undefined : this.o.lib.reviveKey(type, v);
          }
          return out;
        },
        set: async (data) => {
          for (const [type, entries] of Object.entries(data)) {
            this.keys[type] ??= {};
            for (const [id, v] of Object.entries(entries ?? {})) {
              if (v === null || v === undefined) delete this.keys[type]![id];
              else this.keys[type]![id] = v;
            }
          }
          this.persist();
        },
      },
    };
  }

  private open() {
    this.setState('connecting', null);
    let sock: WaSocketLike;
    try {
      sock = this.o.lib.createSocket(this.authState());
    } catch (err) {
      this.setState('disconnected', errText(err));
      return;
    }
    this.sock = sock;
    sock.ev.on('creds.update', (update: unknown) => {
      if (update && typeof update === 'object') Object.assign(this.creds, update);
      this.persist();
    });
    sock.ev.on('connection.update', (u: any) => this.onUpdate(sock, u ?? {}));
  }

  private onUpdate(sock: WaSocketLike, u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) {
    if (sock !== this.sock) return; // an old socket
    if (u.qr) {
      this.qr = u.qr;
      this.qrExpiresAt = new Date(Date.now() + QR_TTL_MS);
      this.setState('qr_pending');
    }
    if (u.connection === 'connecting' && this.state !== 'qr_pending') this.setState('connecting');
    if (u.connection === 'open') {
      this.qr = null;
      this.qrExpiresAt = null;
      this.reconnects = 0;
      const id = sock.user?.id ?? '';
      const digits = id.split(/[:@]/)[0]?.replace(/\D/g, '') || null;
      if (digits) this.number = digits;
      this.persist();
      this.setState('connected', null);
    }
    if (u.connection === 'close') {
      this.qr = null;
      this.qrExpiresAt = null;
      this.sock = null;
      if (this.stopped) return;
      const code = statusCodeOf(u.lastDisconnect?.error);
      if (code !== undefined && this.o.lib.loggedOutCodes.includes(code)) {
        // Logged out from the phone, or the number was banned: the stored session is useless — wipe it.
        void this.enqueue(() => this.wipeStored());
        this.setState('banned_or_logged_out', `WhatsApp ended the session (code ${code}): logged out or banned. Link the number again.`);
        return;
      }
      const message = u.lastDisconnect?.error ? errText(u.lastDisconnect.error) : 'connection closed';
      this.setState('disconnected', code !== undefined ? `${message} (code ${code})` : message);
      if (!this.o.reconnect || this.reconnects >= MAX_RECONNECTS) return;
      this.reconnects++;
      const delay = code !== undefined && this.o.lib.restartCodes.includes(code) ? 0 : Math.min(60_000, 2_000 * 2 ** this.reconnects);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.stopped) this.open();
      }, delay);
      this.timer.unref?.();
    }
  }

  private persist() {
    const value = this.o.lib.serialize({ creds: this.creds, keys: this.keys });
    void this.enqueue(async () => {
      if (this.stopped && this.state === 'off') return;
      const id = await putSecret(this.o.db, { contractorId: this.o.contractorId, purpose: 'whatsapp.session', value, id: this.secretId });
      if (id !== this.secretId) {
        this.secretId = id;
        await this.o.db.query('UPDATE messaging_settings SET wa_session_secret_id = $2 WHERE contractor_id = $1', [this.o.contractorId, id]);
      }
    });
  }

  private async wipeStored() {
    const id = this.secretId ??
      (await this.o.db.query<{ id: string | null }>('SELECT wa_session_secret_id AS id FROM messaging_settings WHERE contractor_id = $1', [this.o.contractorId])).rows[0]?.id ??
      null;
    await this.o.db.query(
      'UPDATE messaging_settings SET wa_session_secret_id = NULL, wa_linked_number = NULL WHERE contractor_id = $1',
      [this.o.contractorId],
    );
    await deleteSecret(this.o.db, id);
    this.secretId = null;
    this.number = null;
    this.creds = null;
    this.keys = {};
  }

  /** Resolves when a QR is ready, the session is connected or failed, or after timeoutMs. */
  waitForProgress(timeoutMs: number): Promise<void> {
    if (this.state !== 'connecting') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
      const check = () => {
        if (this.state !== 'connecting') {
          clearTimeout(t);
          resolve();
        } else this.listeners.push(check);
      };
      this.listeners.push(check);
    });
  }

  async sendText(jid: string, text: string): Promise<{ messageId: string | null }> {
    if (this.state !== 'connected' || !this.sock) throw new WaNotConnectedError(this.state);
    const res = (await this.sock.sendMessage(jid, { text })) as { key?: { id?: string | null } } | undefined;
    return { messageId: res?.key?.id ?? null };
  }

  /** Admin "Disconnect": log out on WhatsApp's side and wipe the stored session. */
  async logout(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        /* already gone */
      }
      try {
        sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
    this.qr = null;
    await this.enqueue(() => this.wipeStored());
    this.setState('off', null);
    await this.flush();
  }

  /** Stops the socket but KEEPS the stored session (mode switched off, server shutting down). */
  stop(persistState = true): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.qr = null;
    if (persistState) this.setState('off');
    else this.state = 'off';
  }
}

export interface WhatsAppManagerOptions {
  loader: WaLibraryLoader;
  reconnect: boolean;
}

/** Holds linked sessions per contractor and the lazy library loader. */
export class WhatsAppManager {
  readonly sessions = new Map<string, LinkedSession>();
  /** Number of times the library loader ran (tests prove it stays 0 in click-to-chat mode). */
  loaderCalls = 0;
  private lib: WaLibrary | null = null;
  private loadError: string | null = null;

  constructor(
    private readonly db: Pool,
    private readonly log: FastifyBaseLogger,
    public opts: WhatsAppManagerOptions,
  ) {}

  /** Loads the library on first use. */
  async library(): Promise<WaLibrary> {
    if (this.lib) return this.lib;
    this.loaderCalls++;
    try {
      this.lib = await this.opts.loader();
      this.loadError = null;
      return this.lib;
    } catch (err) {
      this.loadError = errText(err);
      throw err;
    }
  }

  /** Whether linked sessions can work here. Loads the library — call only in linked_session mode. */
  async availability(): Promise<{ available: boolean; reason: string | null }> {
    try {
      await this.library();
      return { available: true, reason: null };
    } catch {
      return { available: false, reason: this.loadError };
    }
  }

  get(contractorId: string): LinkedSession | undefined {
    return this.sessions.get(contractorId);
  }

  async start(contractorId: string): Promise<LinkedSession> {
    const lib = await this.library();
    this.sessions.get(contractorId)?.stop(false);
    const s = new LinkedSession({ db: this.db, contractorId, lib, log: this.log, reconnect: this.opts.reconnect });
    this.sessions.set(contractorId, s);
    await s.start();
    return s;
  }

  stop(contractorId: string, persistState = true): void {
    const s = this.sessions.get(contractorId);
    if (s) {
      s.stop(persistState);
      this.sessions.delete(contractorId);
    }
  }

  async logout(contractorId: string): Promise<void> {
    const s = this.sessions.get(contractorId);
    this.sessions.delete(contractorId);
    if (s) {
      await s.logout();
      return;
    }
    // No live session: wipe whatever is stored.
    const row = (await this.db.query<{ id: string | null }>('SELECT wa_session_secret_id AS id FROM messaging_settings WHERE contractor_id = $1', [contractorId])).rows[0];
    await this.db.query(
      `UPDATE messaging_settings SET wa_session_secret_id = NULL, wa_linked_number = NULL, linked_session_state = 'off', wa_last_error = NULL WHERE contractor_id = $1`,
      [contractorId],
    );
    await deleteSecret(this.db, row?.id ?? null);
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stop(false);
    this.sessions.clear();
  }
}
