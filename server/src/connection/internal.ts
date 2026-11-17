/**
 * Internal worker API (docs/ARCHITECTURE.md "Internal worker API"), compose network only.
 * - Bearer token = workerToken(), compared in constant time.
 * - Requests carrying X-Forwarded-For, CF-Connecting-IP or CF-Ray came through the tunnel → 404.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../errors.js';
import { workerToken } from '../secrets.js';
import { isMarafiqListKey } from './lists.js';
import { applyJobResult, claimNextJob, importRunnerOf, runningJob } from './service.js';

const TUNNEL_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray'];

function sameToken(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const notFoundReply = (request: FastifyRequest, reply: FastifyReply) =>
  reply.status(404).send(errorBody('not_found', `No route ${request.method} ${request.url.split('?')[0]}.`));

const resultSchema = z.object({
  status: z.enum(['ok', 'signin_failed', 'error']),
  signInAttempts: z.number().int().min(0).max(10).default(0),
  lists: z.array(z.object({ key: z.string().max(80), ok: z.boolean(), rows: z.number().int().min(0).optional(), error: z.string().max(1000).optional() })).max(50).default([]),
  message: z.string().max(2000).optional(),
});

export default async function internalWorkerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (TUNNEL_HEADERS.some((h) => request.headers[h] !== undefined)) return notFoundReply(request, reply);
    const auth = request.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m || !sameToken(m[1]!, workerToken())) {
      return reply.status(401).send(errorBody('unauthorized', 'Worker token required.'));
    }
  });

  app.get('/internal/worker/jobs/next', async (_request, reply) => {
    const job = await claimNextJob(app);
    if (!job) return reply.status(204).send();
    return job;
  });

  app.post('/internal/worker/jobs/:jobId/file', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = z.string().uuid().safeParse(jobId).success ? await runningJob(app.db, jobId) : undefined;
    if (!job) return notFoundReply(request, reply);
    if (job.status !== 'running') return reply.status(409).send({ ok: false, error: `job is ${job.status}` });
    if (!request.isMultipart()) return reply.status(400).send({ ok: false, error: 'multipart form expected' });
    const file = await request.file();
    if (!file) return reply.status(400).send({ ok: false, error: 'file missing' });
    const field = file.fields.listKey as { value?: unknown } | undefined;
    const listKey = typeof field?.value === 'string' ? field.value : '';
    const buffer = await file.toBuffer();
    if (!isMarafiqListKey(listKey) || !job.lists.includes(listKey)) {
      return reply.status(400).send({ ok: false, error: 'list key not part of this job' });
    }
    const run = (await app.db.query<{ id: string }>(
      `SELECT id FROM sync_run WHERE worker_job_id = $1 AND list_key = $2 ORDER BY started_at DESC LIMIT 1`,
      [job.id, listKey],
    )).rows[0];
    const runner = importRunnerOf(app);
    if (!runner) {
      if (run) await app.db.query(`UPDATE sync_run SET result = 'error', error = 'imports not available', finished_at = now() WHERE id = $1`, [run.id]);
      return reply.status(503).send({ ok: false, error: 'imports not available' });
    }
    let res: Awaited<ReturnType<typeof runner>>;
    try {
      res = await runner(app, { contractorId: job.contractor_id, buffer, fileName: file.filename || `${listKey}.xls`, listKey, syncRunId: run?.id });
    } catch (err) {
      request.log.error({ err: (err as Error).message, jobId: job.id, listKey }, 'worker import failed');
      res = { ok: false, error: { code: 'import_failed', message: 'The import failed on the server.' } };
    }
    if (run) {
      await app.db.query(
        `UPDATE sync_run SET result = $2, rows_read = $3, error = $4, finished_at = now() WHERE id = $1`,
        [run.id, res.ok ? 'ok' : 'error', res.rowsRead ?? null, res.ok ? null : (res.error?.message ?? 'import failed').slice(0, 300)],
      );
    }
    return {
      ok: res.ok,
      rowsRead: res.rowsRead ?? 0,
      ...(res.batchId ? { batchId: res.batchId } : {}),
      ...(res.ok ? {} : { error: res.error?.message ?? 'import failed', errorCode: res.error?.code ?? 'import_failed', missingCaptions: res.error?.missingCaptions }),
    };
  });

  app.post('/internal/worker/jobs/:jobId/result', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = z.string().uuid().safeParse(jobId).success ? await runningJob(app.db, jobId) : undefined;
    if (!job) return notFoundReply(request, reply);
    if (job.status !== 'running') return reply.status(409).send({ ok: false, error: `job is ${job.status}` });
    const body = resultSchema.parse(request.body);
    await applyJobResult(app, jobId, body);
    return { ok: true };
  });
}
