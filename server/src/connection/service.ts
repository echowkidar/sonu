/**
 * Marafiq connection (design 14 §4): settings, health, job queue, scheduler, and the worker hand-over.
 * The password is a secret (purpose 'marafiq.password'); it leaves the server ONLY in the
 * GET /internal/worker/jobs/next response.
 */
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import { hasSecret, readSecret } from '../secrets.js';
import { notify } from '../notifications/index.js';
import { MARAFIQ_LIST_KEYS, isMarafiqListKey } from './lists.js';
import { dueLists, effectiveSchedule } from './schedule.js';

export const WORKER_SEEN_MS = 2 * 60_000;
export const JOB_TIMEOUT_MINUTES = 30;

export interface ConnectionRow {
  id: string;
  contractor_id: string;
  name: string;
  base_url: string | null;
  project: string;
  username: string | null;
  secret_id: string | null;
  mode: 'off' | 'read_only';
  write_level: number;
  paused: boolean;
  state: 'idle' | 'running' | 'ok' | 'error' | 'needs_attention';
  schedule: unknown;
  enabled_lists: string[];
  last_success: Record<string, { at: string; rows: number | null }>;
  last_sign_in_at: Date | null;
  last_error: string | null;
  updated_at: Date;
  time_zone?: string;
}

/** Runs the normal import path (implemented by server/src/ops; decorated as app.importRunner). */
export type ImportRunner = (
  app: FastifyInstance,
  input: { contractorId: string; buffer: Buffer; fileName: string; listKey?: string; userId?: string; syncRunId?: string },
) => Promise<{ ok: boolean; batchId?: string; listKey?: string; rowsRead?: number; error?: { code: string; message: string; missingCaptions?: string[] } }>;

export function importRunnerOf(app: FastifyInstance): ImportRunner | undefined {
  const r = (app as unknown as { importRunner?: unknown }).importRunner;
  return typeof r === 'function' ? (r as ImportRunner) : undefined;
}

export function insecurePortalAllowed(): boolean {
  return process.env.ALLOW_INSECURE_PORTAL === '1';
}

/** null when acceptable, else the reason. https always; http only for localhost / 127.0.0.1 with ALLOW_INSECURE_PORTAL=1. */
export function checkBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a valid address.';
  }
  if (u.username || u.password) return 'The address must not contain a user name or password.';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && insecurePortalAllowed()) return null;
  return 'Use an https:// address.';
}

export async function ensureConnection(db: Queryable, contractorId: string): Promise<ConnectionRow> {
  await db.query(`INSERT INTO marafiq_connection (contractor_id, name) VALUES ($1, 'Main') ON CONFLICT DO NOTHING`, [contractorId]);
  const r = await db.query<ConnectionRow>(
    `SELECT m.*, c.time_zone FROM marafiq_connection m JOIN contractor c ON c.id = m.contractor_id WHERE m.contractor_id = $1 AND m.name = 'Main'`,
    [contractorId],
  );
  return r.rows[0]!;
}

export function enabledListsOf(c: Pick<ConnectionRow, 'enabled_lists'>): string[] {
  const set = (c.enabled_lists ?? []).filter(isMarafiqListKey);
  return set.length ? set : [...MARAFIQ_LIST_KEYS];
}

export async function connectionView(app: FastifyInstance, contractorId: string) {
  const c = await ensureConnection(app.db, contractorId);
  return {
    id: c.id,
    name: c.name,
    baseUrl: c.base_url,
    project: c.project,
    username: c.username,
    hasPassword: await hasSecret(app.db, c.secret_id),
    mode: c.mode,
    writeLevel: c.write_level,
    paused: c.paused,
    state: c.state,
    schedule: effectiveSchedule(c.schedule),
    enabledLists: enabledListsOf(c),
    availableLists: MARAFIQ_LIST_KEYS,
    lastSuccess: c.last_success,
    lastSignInAt: c.last_sign_in_at,
    lastError: c.last_error,
    updatedAt: c.updated_at,
  };
}

async function workerLastPoll(db: Queryable): Promise<Date | null> {
  const r = await db.query<{ at: string | null }>(`SELECT value->>'at' AS at FROM app_setting WHERE key = 'worker.last_poll' AND contractor_id IS NULL`);
  return r.rows[0]?.at ? new Date(r.rows[0].at) : null;
}

export async function recordWorkerPoll(db: Queryable, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO app_setting (key, contractor_id, value) VALUES ('worker.last_poll', NULL, $1)
     ON CONFLICT (key, contractor_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ at: now.toISOString() })],
  );
}

export async function connectionHealth(app: FastifyInstance, contractorId: string) {
  const c = await ensureConnection(app.db, contractorId);
  const now = app.comm.now();
  const lastPoll = await workerLastPoll(app.db);
  const workerSeen = !!lastPoll && now.getTime() - lastPoll.getTime() <= WORKER_SEEN_MS;
  const lastOk = await app.db.query<{ list_key: string; rows_read: number | null; finished_at: Date }>(
    `SELECT DISTINCT ON (list_key) list_key, rows_read, finished_at FROM sync_run
      WHERE connection_id = $1 AND result = 'ok' ORDER BY list_key, finished_at DESC NULLS LAST`,
    [c.id],
  );
  const lastErr = await app.db.query<{ list_key: string; error: string | null; result: string; finished_at: Date | null }>(
    `SELECT DISTINCT ON (list_key) list_key, error, result, finished_at FROM sync_run
      WHERE connection_id = $1 AND result IN ('error', 'signin_failed') ORDER BY list_key, finished_at DESC NULLS LAST`,
    [c.id],
  );
  const recent = await app.db.query(
    `SELECT id, worker_job_id AS "jobId", list_key AS "listKey", started_at AS "startedAt", finished_at AS "finishedAt",
            rows_read AS "rowsRead", result, error
       FROM sync_run WHERE connection_id = $1 ORDER BY started_at DESC LIMIT 20`,
    [c.id],
  );
  const jobs = await app.db.query(
    `SELECT id, kind, lists, status, message, sign_in_attempts AS "signInAttempts", created_at AS "createdAt", claimed_at AS "claimedAt", finished_at AS "finishedAt"
       FROM worker_job WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [c.id],
  );
  return {
    state: c.state,
    mode: c.mode,
    paused: c.paused,
    hasPassword: await hasSecret(app.db, c.secret_id),
    lastSignInAt: c.last_sign_in_at,
    lastError: c.last_error,
    lists: enabledListsOf(c).map((key) => {
      const ok = lastOk.rows.find((r) => r.list_key === key);
      const err = lastErr.rows.find((r) => r.list_key === key);
      return {
        key,
        lastSuccessAt: ok?.finished_at ?? null,
        lastRows: ok?.rows_read ?? null,
        lastErrorAt: err?.finished_at ?? null,
        lastError: err?.error ?? null,
      };
    }),
    recentRuns: recent.rows,
    recentJobs: jobs.rows,
    worker: {
      lastPollAt: lastPoll,
      running: workerSeen,
      hint: workerSeen ? null : 'Worker not running: no worker has asked for jobs in the last 2 minutes. Start the "worker" container.',
    },
  };
}

/** Why the connection may not get jobs now (null = it may). */
export function blockedReason(c: ConnectionRow, hasPw: boolean): string | null {
  if (c.mode !== 'read_only') return 'The connection is off. Switch it to read-only first.';
  if (c.paused) return 'The connection is paused. Press Resume first.';
  if (c.state === 'needs_attention') return 'The connection needs attention: save the password again or press Resume.';
  if (!hasPw) return 'Save the Marafiq password first.';
  if (!c.base_url || !c.username) return 'Enter the portal address and the user name first.';
  return null;
}

/** Inserts a job; returns null when another job of the connection is still open (one open job max). */
export async function createJob(db: Queryable, c: ConnectionRow, kind: 'test' | 'sync', lists: string[], userId: string | null, now: Date = new Date()): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO worker_job (contractor_id, connection_id, kind, lists, requested_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id`,
    [c.contractor_id, c.id, kind, lists, userId, now],
  );
  return r.rows[0]?.id ?? null;
}

/** One scheduler pass: time out stuck jobs, then queue due sync jobs. Returns the job ids created. */
export async function runSchedulerOnce(app: FastifyInstance): Promise<string[]> {
  const now = app.comm.now();
  const stuck = await app.db.query<{ id: string; connection_id: string; contractor_id: string }>(
    `UPDATE worker_job SET status = 'error', message = 'timed out: no result from the worker', finished_at = $1
      WHERE status = 'running' AND claimed_at < $1::timestamptz - make_interval(mins => $2::int) RETURNING id, connection_id, contractor_id`,
    [now, JOB_TIMEOUT_MINUTES],
  );
  for (const j of stuck.rows) {
    await app.db.query(`UPDATE marafiq_connection SET state = 'error', last_error = 'last job timed out' WHERE id = $1 AND state = 'running'`, [j.connection_id]);
    await app.db.query(`UPDATE sync_run SET result = 'error', error = 'timed out', finished_at = $2 WHERE worker_job_id = $1 AND result IS NULL`, [j.id, now]);
  }
  const conns = await app.db.query<ConnectionRow>(
    `SELECT m.*, c.time_zone FROM marafiq_connection m JOIN contractor c ON c.id = m.contractor_id
      WHERE m.mode = 'read_only' AND NOT m.paused AND m.state <> 'needs_attention' AND m.secret_id IS NOT NULL
        AND m.base_url IS NOT NULL AND m.username IS NOT NULL AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM worker_job j WHERE j.connection_id = m.id AND j.status IN ('queued', 'running'))`,
  );
  const created: string[] = [];
  for (const c of conns.rows) {
    if (!(await hasSecret(app.db, c.secret_id))) continue;
    const last = await app.db.query<{ key: string; at: Date }>(
      `SELECT k AS key, max(j.created_at) AS at FROM worker_job j, unnest(j.lists) AS k
        WHERE j.connection_id = $1 AND j.kind = 'sync' GROUP BY k`,
      [c.id],
    );
    const map = new Map(last.rows.map((r) => [r.key, new Date(r.at)]));
    const due = dueLists(effectiveSchedule(c.schedule), enabledListsOf(c), map, now, c.time_zone ?? 'Asia/Qatar');
    if (!due.length) continue;
    const id = await createJob(app.db, c, 'sync', due, null, now);
    if (id) created.push(id);
  }
  return created;
}

export interface ClaimedJob {
  jobId: string;
  kind: 'test' | 'sync';
  connection: { id: string; baseUrl: string; project: string; username: string; password: string };
  lists: string[];
}

/** GET /internal/worker/jobs/next. The only place the password is decrypted for sending. */
export async function claimNextJob(app: FastifyInstance): Promise<ClaimedJob | null> {
  const now = app.comm.now();
  await recordWorkerPoll(app.db, now);
  for (let guard = 0; guard < 5; guard++) {
    const r = await app.db.query<{ id: string; kind: 'test' | 'sync'; lists: string[]; connection_id: string; contractor_id: string }>(
      `UPDATE worker_job SET status = 'running', claimed_at = $1
        WHERE id = (SELECT j.id FROM worker_job j JOIN marafiq_connection c ON c.id = j.connection_id
                     WHERE j.status = 'queued' AND c.mode = 'read_only' AND NOT c.paused AND c.state <> 'needs_attention'
                     ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
        RETURNING id, kind, lists, connection_id, contractor_id`,
      [now],
    );
    const job = r.rows[0];
    if (!job) return null;
    const c = (await app.db.query<ConnectionRow>('SELECT * FROM marafiq_connection WHERE id = $1', [job.connection_id])).rows[0]!;
    const password = await readSecret(app.db, c.secret_id, c.contractor_id).catch(() => null);
    if (!password || !c.base_url || !c.username || checkBaseUrl(c.base_url)) {
      await app.db.query(`UPDATE worker_job SET status = 'error', message = 'connection incomplete (address, user name or password)', finished_at = $2 WHERE id = $1`, [job.id, now]);
      continue;
    }
    const lists = job.kind === 'sync' ? job.lists.filter(isMarafiqListKey) : [];
    for (const key of lists) {
      await app.db.query(
        `INSERT INTO sync_run (contractor_id, connection_id, worker_job_id, list_key, started_at) VALUES ($1, $2, $3, $4, $5)`,
        [c.contractor_id, c.id, job.id, key, now],
      );
    }
    await app.db.query(`UPDATE marafiq_connection SET state = 'running' WHERE id = $1`, [c.id]);
    await audit(app.db, {
      contractorId: c.contractor_id,
      action: 'marafiq_connection.used',
      entityType: 'marafiq_connection',
      entityId: c.id,
      summary: `${job.kind} job handed to the worker`,
      details: { jobId: job.id, kind: job.kind, lists, username: c.username },
    });
    return { jobId: job.id, kind: job.kind, connection: { id: c.id, baseUrl: c.base_url, project: c.project, username: c.username, password }, lists };
  }
  return null;
}

export async function runningJob(db: Queryable, jobId: string) {
  return (await db.query<{ id: string; kind: string; lists: string[]; status: string; connection_id: string; contractor_id: string }>(
    'SELECT id, kind, lists, status, connection_id, contractor_id FROM worker_job WHERE id = $1',
    [jobId],
  )).rows[0];
}

export interface JobResultBody {
  status: 'ok' | 'signin_failed' | 'error';
  signInAttempts: number;
  lists: { key: string; ok: boolean; rows?: number; error?: string }[];
  message?: string;
}

/** POST /internal/worker/jobs/:id/result. */
export async function applyJobResult(app: FastifyInstance, jobId: string, body: JobResultBody): Promise<void> {
  const now = app.comm.now();
  const job = (await runningJob(app.db, jobId))!;
  const message = body.message?.slice(0, 500) ?? null;
  await app.db.query(
    `UPDATE worker_job SET status = $2, sign_in_attempts = $3, result = $4, message = $5, finished_at = $6 WHERE id = $1`,
    [jobId, body.status, body.signInAttempts, JSON.stringify({ lists: body.lists }), message, now],
  );
  const successes: Record<string, { at: string; rows: number | null }> = {};
  for (const l of body.lists) {
    if (!isMarafiqListKey(l.key)) continue;
    const result = l.ok ? 'ok' : body.status === 'signin_failed' ? 'signin_failed' : 'error';
    await app.db.query(
      `UPDATE sync_run SET result = $3, rows_read = COALESCE($4, rows_read), error = $5, finished_at = COALESCE(finished_at, $6)
        WHERE worker_job_id = $1 AND list_key = $2`,
      [jobId, l.key, result, l.rows ?? null, l.ok ? null : (l.error ?? 'failed').slice(0, 300), now],
    );
    if (l.ok) successes[l.key] = { at: now.toISOString(), rows: l.rows ?? null };
  }
  await app.db.query(
    `UPDATE sync_run SET result = 'skipped', finished_at = $2 WHERE worker_job_id = $1 AND result IS NULL`,
    [jobId, now],
  );
  const signedIn = body.status !== 'signin_failed' && body.signInAttempts > 0;
  if (body.status === 'signin_failed') {
    await app.db.query(
      `UPDATE marafiq_connection SET state = 'needs_attention', last_error = $2, updated_at = now() WHERE id = $1`,
      [job.connection_id, `Sign-in failed${message ? `: ${message}` : ''}`.slice(0, 300)],
    );
    await app.db.query(`UPDATE worker_job SET status = 'cancelled', finished_at = $2, message = 'cancelled: sign-in failed' WHERE connection_id = $1 AND status = 'queued'`, [job.connection_id, now]);
    await audit(app.db, {
      contractorId: job.contractor_id, action: 'marafiq_connection.needs_attention', entityType: 'marafiq_connection', entityId: job.connection_id,
      summary: 'sign-in failed; no further jobs until the password is saved again or Resume is pressed', details: { jobId, signInAttempts: body.signInAttempts },
    });
    await notify(app, {
      contractorId: job.contractor_id,
      roles: ['contractor_admin'],
      event: 'marafiq.needs_attention',
      title: 'Marafiq connection needs attention',
      body: 'The background connection could not sign in to Marafiq and has stopped. Enter the new password or press Resume. Manual import still works.',
      url: '/admin/marafiq-connection',
      record: { type: 'marafiq_connection', id: job.connection_id },
    });
  } else {
    await app.db.query(
      `UPDATE marafiq_connection SET state = $2, last_error = $3, last_success = last_success || $4::jsonb,
              last_sign_in_at = CASE WHEN $5::boolean THEN $6 ELSE last_sign_in_at END, updated_at = now()
        WHERE id = $1 AND state <> 'needs_attention'`,
      [job.connection_id, body.status === 'ok' ? 'ok' : 'error', body.status === 'ok' ? null : (message ?? 'error').slice(0, 300), JSON.stringify(successes), signedIn, now],
    );
  }
  await audit(app.db, {
    contractorId: job.contractor_id, action: 'marafiq_connection.job_result', entityType: 'worker_job', entityId: jobId,
    summary: `${job.kind} job: ${body.status}`, details: { lists: body.lists.map((l) => ({ key: l.key, ok: l.ok, rows: l.rows ?? null })) },
  });
}
