/**
 * In-memory login limiter (single app container). Counts failed attempts per IP and per e-mail
 * inside a sliding window; a successful login clears the e-mail counter.
 */
export interface RateLimitOptions {
  windowMs: number;
  maxPerIp: number;
  maxPerEmail: number;
}

export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: RateLimitOptions = { windowMs: 15 * 60_000, maxPerIp: 30, maxPerEmail: 5 }) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds to wait, or 0 when the attempt may go ahead. */
  check(ip: string, email: string, now = Date.now()): number {
    const ipList = this.recent(`ip:${ip}`, now);
    const emailList = this.recent(`email:${email.toLowerCase()}`, now);
    const blocked: number[] = [];
    if (ipList.length >= this.opts.maxPerIp) blocked.push(ipList[0]!);
    if (emailList.length >= this.opts.maxPerEmail) blocked.push(emailList[0]!);
    if (!blocked.length) return 0;
    const oldest = Math.min(...blocked);
    return Math.max(1, Math.ceil((oldest + this.opts.windowMs - now) / 1000));
  }

  fail(ip: string, email: string, now = Date.now()): void {
    for (const key of [`ip:${ip}`, `email:${email.toLowerCase()}`]) {
      const list = this.recent(key, now);
      list.push(now);
      this.hits.set(key, list);
    }
    if (this.hits.size > 50_000) this.hits.clear(); // memory guard
  }

  succeed(email: string): void {
    this.hits.delete(`email:${email.toLowerCase()}`);
  }
}
