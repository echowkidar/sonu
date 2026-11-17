/** Poll loop and job execution (worker side of the "Internal worker API" in docs/ARCHITECTURE.md). */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { z } from 'zod';
import { LIST_KEYS, getList, isListKey, type ListKey } from './allowlist.js';
import { USER_AGENT_SUFFIX, checkPortalAddress, type WorkerConfig } from './config.js';
import { PortalGuard } from './guard.js';
import { Logger } from './logger.js';
import { Pace, sleep } from './pace.js';
import { probeList, readList } from './portal.js';
import { PortalSession, SessionLostError, SignInBudget, SignInFailedError } from './session.js';

const id = z.union([z.string().min(1), z.number()]).transform(String);
export const JobSchema = z.object({
  jobId: id,
  kind: z.enum(['test', 'sync']),
  connection: z.object({
    id,
    baseUrl: z.string().min(1),
    project: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  lists: z.array(z.string()).default([]),
});
export type Job = z.infer<typeof JobSchema>;

export interface ListResult {
  key: string;
  ok: boolean;
  rows?: number;
  error?: string;
}
export interface JobResult {
  status: 'ok' | 'signin_failed' | 'error';
  signInAttempts: number;
  lists: ListResult[];
  message?: string;
}

export interface UploadResponse {
  ok: boolean;
  rowsRead?: number;
  error?: string;
}

/** Client for the three internal endpoints of the SONU server. */
export class AppClient {
  constructor(
    private readonly appUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async nextJob(): Promise<unknown | null> {
    const r = await this.fetchImpl(`${this.appUrl}/internal/worker/jobs/next`, { headers: this.headers() });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`jobs/next returned HTTP ${r.status}`);
    return r.json();
  }

  async uploadFile(jobId: string, listKey: string, filePath: string, fileName: string): Promise<UploadResponse> {
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append('listKey', listKey);
    form.append('file', new Blob([buf]), fileName);
    const r = await this.fetchImpl(`${this.appUrl}/internal/worker/jobs/${encodeURIComponent(jobId)}/file`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    const body = (await r.json().catch(() => ({}))) as UploadResponse;
    if (!r.ok) return { ok: false, error: body.error ?? `upload returned HTTP ${r.status}` };
    return { ok: !!body.ok, rowsRead: body.rowsRead, error: body.error };
  }

  async postResult(jobId: string, result: JobResult): Promise<void> {
    const r = await this.fetchImpl(`${this.appUrl}/internal/worker/jobs/${encodeURIComponent(jobId)}/result`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(result),
    });
    if (!r.ok) throw new Error(`result returned HTTP ${r.status}`);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? (e.message.split('\n')[0] ?? e.name).slice(0, 300) : 'unknown error';
}

function blockedSummary(guard: PortalGuard | null): string | undefined {
  if (!guard || guard.blocked.length === 0) return undefined;
  const top = guard.blocked.slice(0, 3).map((b) => `${b.method} ${b.where} (${b.reason})`);
  return `guard blocked ${guard.blocked.length} request(s): ${top.join('; ')}`;
}

export async function executeJob(job: Job, cfg: WorkerConfig, client: AppClient, logger: Logger, signal?: AbortSignal): Promise<JobResult> {
  const log = logger.child({ jobId: job.jobId, kind: job.kind });
  log.addSecret(job.connection.password);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let guard: PortalGuard | null = null;
  let tmpDir: string | null = null;
  const budget = new SignInBudget();
  const results = new Map<string, ListResult>();
  const order: string[] = [];
  const finish = (status: JobResult['status'], message?: string): JobResult => {
    const extra = blockedSummary(guard);
    const msg = [message, extra].filter(Boolean).join(' | ') || undefined;
    const lists = order.map((k) => results.get(k)).filter((x): x is ListResult => !!x);
    return { status, signInAttempts: budget.attempts, lists, ...(msg ? { message: msg } : {}) };
  };

  try {
    const addrErr = checkPortalAddress(job.connection.baseUrl, cfg.allowInsecurePortal);
    if (addrErr) {
      log.error('refusing job', { reason: addrErr });
      return finish('error', `refused: ${addrErr}`);
    }

    const known: ListKey[] = [];
    if (job.kind === 'sync') {
      for (const k of job.lists) {
        if (order.includes(k)) continue;
        order.push(k);
        if (isListKey(k)) known.push(k);
        else results.set(k, { key: k, ok: false, error: 'unknown list key (ignored)' });
      }
      if (known.length === 0) return finish('error', 'no known list keys in job');
    }

    const origin = new URL(job.connection.baseUrl).origin;
    tmpDir = await mkdtemp(join(tmpdir(), 'sonu-worker-'));
    browser = await chromium.launch({ headless: cfg.headless });
    const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36 ${USER_AGENT_SUFFIX}`;
    context = await browser.newContext({
      userAgent: ua,
      acceptDownloads: true,
      serviceWorkers: 'block',
      locale: 'en-US',
      timezoneId: 'Asia/Qatar',
    });
    context.setDefaultTimeout(cfg.stepTimeoutMs);
    guard = new PortalGuard(origin, log);
    await guard.install(context);
    const page = await guard.openPage(context);
    const pace = new Pace(cfg.pace);
    const session = new PortalSession(
      page,
      guard,
      { project: job.connection.project, username: job.connection.username, password: job.connection.password },
      budget,
      log,
      pace,
      { origin, navTimeoutMs: cfg.navTimeoutMs },
    );

    try {
      await session.signIn();
    } catch (e) {
      if (e instanceof SignInFailedError) {
        for (const k of known) results.set(k, { key: k, ok: false, error: 'not read: sign-in failed' });
        return finish('signin_failed', e.message);
      }
      throw e;
    }

    if (job.kind === 'test') {
      const key = LIST_KEYS[0] as ListKey;
      order.push(key);
      const ok = await probeList(session, getList(key), cfg.stepTimeoutMs);
      results.set(key, ok ? { key, ok: true } : { key, ok: false, error: 'Show button not found' });
      return finish(ok ? 'ok' : 'error', ok ? 'signed in; list opened; Show button present' : 'signed in, but the Show button was not found');
    }

    for (let i = 0; i < known.length; i++) {
      const key = known[i] as ListKey;
      if (signal?.aborted) {
        results.set(key, { key, ok: false, error: 'not read: worker stopping' });
        continue;
      }
      let filePath: string | null = null;
      try {
        const file = await readList(session, key, getList(key), pace, {
          tmpDir,
          maxBytes: cfg.maxDownloadBytes,
          timeoutMs: cfg.stepTimeoutMs,
        });
        filePath = file.path;
        const up = await client.uploadFile(job.jobId, key, file.path, file.fileName);
        results.set(key, { key, ok: up.ok, ...(up.rowsRead !== undefined ? { rows: up.rowsRead } : {}), ...(up.error ? { error: up.error } : {}) });
        log.info('list read', { list: key, ok: up.ok, rows: up.rowsRead, bytes: file.bytes });
        pace.ok();
      } catch (e) {
        if (e instanceof SignInFailedError || e instanceof SessionLostError) {
          results.set(key, { key, ok: false, error: errText(e) });
          for (const rest of known.slice(i + 1)) results.set(rest, { key: rest, ok: false, error: 'not read: session lost' });
          if (e instanceof SignInFailedError) return finish('signin_failed', e.message);
          return finish('error', errText(e));
        }
        results.set(key, { key, ok: false, error: errText(e) });
        log.warn('list failed', { list: key, error: errText(e) });
        await pace.backoff();
      } finally {
        guard.idle();
        if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
      }
    }
    const allOk = known.every((k) => results.get(k)?.ok);
    return finish(allOk ? 'ok' : 'error', allOk ? undefined : 'one or more lists failed');
  } catch (e) {
    log.error('job failed', { error: errText(e) });
    return finish('error', errText(e));
  } finally {
    guard?.idle();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    // Drop the password from memory as far as JS allows.
    (job.connection as { password: string }).password = '';
    log.info('job finished', { signInAttempts: budget.attempts });
  }
}

/** Fetch one job and run it. Returns true if a job was run. */
export async function pollOnce(cfg: WorkerConfig, client: AppClient, logger: Logger, signal?: AbortSignal): Promise<boolean> {
  const raw = await client.nextJob();
  if (raw === null) return false;
  const parsed = JobSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('invalid job from server', { issues: parsed.error.issues.map((i) => i.path.join('.')) });
    const jobId = (raw as { jobId?: unknown })?.jobId;
    if (typeof jobId === 'string' || typeof jobId === 'number') {
      await client.postResult(String(jobId), { status: 'error', signInAttempts: 0, lists: [], message: 'invalid job' });
    }
    return true;
  }
  const job = parsed.data;
  const result = await executeJob(job, cfg, client, logger, signal);
  await client.postResult(job.jobId, result);
  logger.info('result posted', { jobId: job.jobId, status: result.status, signInAttempts: result.signInAttempts });
  return true;
}

export async function runLoop(cfg: WorkerConfig, logger: Logger, signal: AbortSignal, client = new AppClient(cfg.appUrl, cfg.token)): Promise<void> {
  logger.addSecret(cfg.token);
  logger.info('worker started', { appUrl: cfg.appUrl, pollSeconds: cfg.pollSeconds });
  let errors = 0;
  while (!signal.aborted) {
    let ran = false;
    try {
      ran = await pollOnce(cfg, client, logger, signal);
      errors = 0;
    } catch (e) {
      errors++;
      logger.warn('poll failed', { error: errText(e) });
    }
    if (!ran) await sleep(cfg.pollSeconds * 1000 * Math.min(2 ** errors, 8), signal);
  }
  logger.info('worker stopped');
}
