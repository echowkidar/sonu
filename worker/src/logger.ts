/**
 * JSON-lines logger with secret redaction. Secrets (the portal password for the running job, the
 * worker token) are registered while they are in memory; every log line is scrubbed of them, and
 * fields whose names look secret are never printed.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|credential/i;
const REDACTED = '[REDACTED]';

export class Logger {
  constructor(
    private readonly sink: LogSink = (l) => process.stdout.write(l + '\n'),
    private readonly base: Record<string, unknown> = {},
    /** Shared with child loggers so a secret registered anywhere is scrubbed everywhere. */
    private readonly secrets: Set<string> = new Set<string>(),
  ) {}

  addSecret(s: string | undefined | null): void {
    if (s && s.length > 0) this.secrets.add(s);
  }

  removeSecret(s: string | undefined | null): void {
    if (s) this.secrets.delete(s);
  }

  child(extra: Record<string, unknown>): Logger {
    return new Logger(this.sink, { ...this.base, ...extra }, this.secrets);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) {
      if (!s) continue;
      out = out.split(s).join(REDACTED);
      // Also the URL-encoded form (e.g. a form body echoed in an error).
      const enc = encodeURIComponent(s);
      if (enc !== s) out = out.split(enc).join(REDACTED);
    }
    return out;
  }

  private clean(v: unknown, depth = 0): unknown {
    if (depth > 5) return '[depth]';
    if (typeof v === 'string') return this.scrub(v);
    if (v instanceof Error) return { name: v.name, message: this.scrub(v.message) };
    if (Array.isArray(v)) return v.map((x) => this.clean(x, depth + 1));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? REDACTED : this.clean(val, depth + 1);
      return o;
    }
    return v;
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const rec = { t: new Date().toISOString(), level, msg: this.scrub(msg), ...(this.clean({ ...this.base, ...fields }) as object) };
    this.sink(this.scrub(JSON.stringify(rec)));
  }

  debug(msg: string, f?: Record<string, unknown>): void { this.log('debug', msg, f); }
  info(msg: string, f?: Record<string, unknown>): void { this.log('info', msg, f); }
  warn(msg: string, f?: Record<string, unknown>): void { this.log('warn', msg, f); }
  error(msg: string, f?: Record<string, unknown>): void { this.log('error', msg, f); }
}
