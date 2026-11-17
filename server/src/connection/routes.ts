/** Admin routes of the Marafiq connection: settings, test, pause / resume, health. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, currentUser, requireRole } from '../auth/guards.js';
import { withTx } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { deleteSecret, hasSecret, putSecret } from '../secrets.js';
import { isMarafiqListKey } from './lists.js';
import { scheduleSchema } from './schedule.js';
import { blockedReason, checkBaseUrl, connectionHealth, connectionView, createJob, ensureConnection } from './service.js';

const scopeQuery = z.object({ contractorId: z.string().uuid().optional() });

export default async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };
  const scope = (request: Parameters<typeof adminScope>[0]) => adminScope(request, scopeQuery.parse(request.query).contractorId)!;

  app.get('/api/admin/marafiq-connection', admins, async (request) => connectionView(app, scope(request)));

  app.put('/api/admin/marafiq-connection', admins, async (request) => {
    const contractorId = scope(request);
    const body = z
      .object({
        baseUrl: z.string().trim().max(300).nullish(),
        project: z.string().trim().min(1).max(40).optional(),
        username: z.string().trim().max(120).nullish(),
        /** Write-only. */
        password: z.string().min(1).max(500).optional(),
        clearPassword: z.boolean().optional(),
        mode: z.enum(['off', 'read_only']).optional(),
        schedule: scheduleSchema.optional(),
        enabledLists: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      })
      .strict()
      .parse(request.body);
    if (body.baseUrl) {
      const why = checkBaseUrl(body.baseUrl);
      if (why) throw badRequest(why, [{ path: 'baseUrl', message: why }]);
    }
    if (body.enabledLists) {
      const unknown = body.enabledLists.filter((k) => !isMarafiqListKey(k));
      if (unknown.length) throw badRequest(`Unknown list keys: ${unknown.join(', ')}.`);
    }
    if (body.schedule) {
      const unknown = Object.keys(body.schedule.lists).filter((k) => !isMarafiqListKey(k));
      if (unknown.length) throw badRequest(`Unknown list keys in the schedule: ${unknown.join(', ')}.`);
    }
    await ensureConnection(app.db, contractorId);
    await withTx(app.db, async (c) => {
      const cur = (await c.query<{ id: string; secret_id: string | null; state: string; mode: string }>(
        `SELECT id, secret_id, state, mode FROM marafiq_connection WHERE contractor_id = $1 AND name = 'Main' FOR UPDATE`,
        [contractorId],
      )).rows[0]!;
      let secretId = cur.secret_id;
      let state = cur.state;
      if (body.clearPassword) {
        await c.query('UPDATE marafiq_connection SET secret_id = NULL WHERE id = $1', [cur.id]);
        await deleteSecret(c, secretId);
        secretId = null;
      } else if (body.password) {
        secretId = await putSecret(c, { contractorId, purpose: 'marafiq.password', value: body.password, id: secretId });
        if (state === 'needs_attention') state = 'idle'; // saving the password again clears the stop (ARCHITECTURE)
      }
      await c.query(
        `UPDATE marafiq_connection SET
           base_url = CASE WHEN $2::boolean THEN $3 ELSE base_url END,
           project = COALESCE($4, project),
           username = CASE WHEN $5::boolean THEN $6 ELSE username END,
           secret_id = $7, mode = COALESCE($8, mode),
           schedule = COALESCE($9::jsonb, schedule), enabled_lists = COALESCE($10, enabled_lists),
           state = $11, last_error = CASE WHEN $11 <> $12 THEN NULL ELSE last_error END, updated_at = now()
         WHERE id = $1`,
        [
          cur.id, body.baseUrl !== undefined, body.baseUrl || null, body.project ?? null, body.username !== undefined, body.username || null,
          secretId, body.mode ?? null, body.schedule ? JSON.stringify(body.schedule) : null, body.enabledLists ?? null, state, cur.state,
        ],
      );
      const { password: _p, ...rest } = body;
      await auditFromRequest(
        request,
        {
          contractorId,
          action: 'marafiq_connection.update',
          entityType: 'marafiq_connection',
          entityId: cur.id,
          summary: body.mode && body.mode !== cur.mode ? `mode ${cur.mode} → ${body.mode}` : 'settings saved',
          details: { fields: Object.keys(rest), passwordChanged: !!body.password, needsAttentionCleared: state !== cur.state },
        },
        c,
      );
    });
    return connectionView(app, contractorId);
  });

  app.post('/api/admin/marafiq-connection/test', admins, async (request, reply) => {
    const contractorId = scope(request);
    const c = await ensureConnection(app.db, contractorId);
    const why = blockedReason(c, await hasSecret(app.db, c.secret_id));
    if (why) throw new AppError(409, 'not_ready', why);
    const id = await createJob(app.db, c, 'test', [], currentUser(request).id, app.comm.now());
    if (!id) throw new AppError(409, 'job_open', 'A job is already queued or running for this connection. Try again when it has finished.');
    await auditFromRequest(request, { contractorId, action: 'marafiq_connection.test', entityType: 'marafiq_connection', entityId: c.id, details: { jobId: id } });
    return reply.status(202).send({ ok: true, jobId: id });
  });

  app.post('/api/admin/marafiq-connection/pause', admins, async (request) => {
    const contractorId = scope(request);
    const c = await ensureConnection(app.db, contractorId);
    await app.db.query(`UPDATE marafiq_connection SET paused = true, updated_at = now() WHERE id = $1`, [c.id]);
    const cancelled = await app.db.query(
      `UPDATE worker_job SET status = 'cancelled', finished_at = now(), message = 'cancelled: paused by the admin' WHERE connection_id = $1 AND status = 'queued'`,
      [c.id],
    );
    await auditFromRequest(request, { contractorId, action: 'marafiq_connection.pause', entityType: 'marafiq_connection', entityId: c.id, details: { cancelledJobs: cancelled.rowCount ?? 0 } });
    return connectionView(app, contractorId);
  });

  app.post('/api/admin/marafiq-connection/resume', admins, async (request) => {
    const contractorId = scope(request);
    const c = await ensureConnection(app.db, contractorId);
    await app.db.query(
      `UPDATE marafiq_connection SET paused = false, state = CASE WHEN state = 'needs_attention' THEN 'idle' ELSE state END,
              last_error = CASE WHEN state = 'needs_attention' THEN NULL ELSE last_error END, updated_at = now() WHERE id = $1`,
      [c.id],
    );
    await auditFromRequest(request, { contractorId, action: 'marafiq_connection.resume', entityType: 'marafiq_connection', entityId: c.id, details: { clearedNeedsAttention: c.state === 'needs_attention' } });
    return connectionView(app, contractorId);
  });

  app.get('/api/admin/marafiq-connection/health', admins, async (request) => connectionHealth(app, scope(request)));
}
