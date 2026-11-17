/** The ONE WhatsApp interface. Modes: click_to_chat (default) and linked_session (off by default). */

export type WaMode = 'click_to_chat' | 'linked_session';
export type LinkedState = 'off' | 'qr_pending' | 'connecting' | 'connected' | 'disconnected' | 'banned_or_logged_out';

export interface WaStatus {
  mode: WaMode;
  /** Linked-session state ('off' in click-to-chat mode). */
  state: LinkedState;
  /** Whether a linked session can be used on this server (library installed); null = not checked (click-to-chat). */
  available: boolean | null;
  reason: string | null;
  /** Masked, e.g. "+974••••0199". */
  linkedNumber: string | null;
  lastError: string | null;
  sentToday: number;
  dailyLimit: number;
  minIntervalSeconds: number;
  /** True when the mode is linked_session but the session is not connected, so links are used instead. */
  fallbackToClickToChat: boolean;
}

export interface WhatsAppChannel {
  readonly mode: WaMode;
  status(): Promise<WaStatus>;
  /** Always available: a wa.me link the user opens to send the message himself. */
  buildLink(to: string, text: string): string;
  /** Only on a connected linked session: sends through the linked number (consent + rate limit enforced). */
  sendText?(to: string, text: string): Promise<{ messageId: string | null }>;
}

export class WaRateLimitedError extends Error {
  constructor(public readonly retryAt: Date, reason: string) {
    super(`WhatsApp rate limit: ${reason}`);
    this.name = 'WaRateLimitedError';
  }
}
export class WaConsentError extends Error {
  constructor() {
    super('The recipient has not agreed to WhatsApp messages.');
    this.name = 'WaConsentError';
  }
}
export class WaNotConnectedError extends Error {
  constructor(state: string) {
    super(`The linked WhatsApp session is not connected (${state}).`);
    this.name = 'WaNotConnectedError';
  }
}

// ───── Library adapter (implemented for Baileys in baileys.ts; tests use a fake) ─────

/** The few socket members the driver uses. */
export interface WaSocketLike {
  ev: { on(event: string, listener: (arg: any) => void): void };
  user?: { id?: string | null } | null;
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface WaAuthState {
  creds: any;
  keys: {
    get(type: string, ids: string[]): Promise<Record<string, any>>;
    set(data: Record<string, Record<string, any>>): Promise<void>;
  };
}

export interface WaLibrary {
  name: string;
  initAuthCreds(): any;
  serialize(value: unknown): string;
  deserialize(text: string): any;
  /** Re-create typed key objects after JSON (Baileys: app-state-sync-key → proto). */
  reviveKey(type: string, value: any): any;
  createSocket(auth: WaAuthState): WaSocketLike;
  /** Disconnect status codes that mean "logged out / banned": the session is wiped. */
  loggedOutCodes: number[];
  /** Status code after which the socket must be re-created at once (Baileys restartRequired = 515). */
  restartCodes: number[];
}

export type WaLibraryLoader = () => Promise<WaLibrary>;
