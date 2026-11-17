/** Human pace: one page at a time, small randomised pauses, longer pauses after errors. */

export interface PaceOptions {
  minMs: number;
  maxMs: number;
  /** Upper bound for the back-off pause after repeated errors. */
  maxBackoffMs: number;
}

export const DEFAULT_PACE: PaceOptions = { minMs: 1500, maxMs: 4000, maxBackoffMs: 60_000 };

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class Pace {
  private errors = 0;
  constructor(private readonly opts: PaceOptions = DEFAULT_PACE) {}

  /** A short random pause between two steps. */
  step(): Promise<void> {
    const { minMs, maxMs } = this.opts;
    return sleep(minMs + Math.random() * Math.max(0, maxMs - minMs));
  }

  /** Call after an error: pauses longer each time (exponential, capped). */
  async backoff(): Promise<void> {
    this.errors++;
    const base = Math.max(this.opts.minMs, 1) * 2 ** this.errors;
    await sleep(Math.min(base, this.opts.maxBackoffMs));
  }

  ok(): void {
    this.errors = 0;
  }
}
