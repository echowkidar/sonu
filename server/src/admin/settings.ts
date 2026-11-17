import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, currentUser, requireRole } from '../auth/guards.js';
import { withTx } from '../db.js';
import { AppError } from '../errors.js';
import { getMailSender, mailSettingsInput, mailSettingsView, mailTemplates, saveMailSettings } from '../mail/index.js';
import { deleteSecret, hasSecret, putSecret } from '../secrets.js';

const scopeQuery = z.object({ contractorId: z.string().uuid().optional() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };

  // ───── Audit log ─────
  app.get('/api/admin/audit', admins, async (request) => {
    const q = z
      .object({
        contractorId: z.string().uuid().optional(),
        action: z.string().max(80).optional(),
        userId: z.string().uuid().optional(),
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(80).optional(),
        q: z.string().trim().max(100).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(50),
      })
      .parse(request.query);
    const user = currentUser(request);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (user.role === 'platform_admin') {
      if (q.contractorId) add('a.contractor_id = ?', q.contractorId);
    } else {
      add('a.contractor_id = ?', adminScope(request, q.contractorId));
    }
    if (q.action) add(q.action.endsWith('*') ? 'a.action LIKE ?' : 'a.action = ?', q.action.endsWith('*') ? `${q.action.slice(0, -1)}%` : q.action);
    if (q.userId) add('a.user_id = ?', q.userId);
    if (q.entityType) add('a.entity_type = ?', q.entityType);
    if (q.entityId) add('a.entity_id = ?', q.entityId);
    if (q.from) add('a.at >= ?', q.from);
    if (q.to) add('a.at < ?', q.to);
    if (q.q) add(`(lower(coalesce(a.summary,'')) LIKE ? OR lower(coalesce(a.user_email,'')) LIKE ? OR a.action LIKE ?)`, `%${q.q.toLowerCase()}%`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log a ${whereSql}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const r = await app.db.query(
      `SELECT a.id, a.contractor_id AS "contractorId", a.user_id AS "userId", a.user_email AS "userEmail", a.action,
              a.entity_type AS "entityType", a.entity_id AS "entityId", a.summary, a.details, a.ip, a.at
         FROM audit_log a ${whereSql} ORDER BY a.at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows, total, page: q.page, pageSize: q.pageSize };
  });

  // ───── Mail settings ─────
  // Contractor admin: own contractor. Platform admin: platform fallback (no contractorId) or a contractor.
  app.get('/api/admin/mail', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId, { allowPlatform: true });
    return mailSettingsView(app.db, contractorId);
  });

  app.put('/api/admin/mail', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId, { allowPlatform: true });
    const body = mailSettingsInput.parse(request.body);
    await withTx(app.db, async (c) => {
      const { changedSecrets } = await saveMailSettings(c, contractorId, body, request.auth!.user.id);
      await auditFromRequest(
        request,
        { contractorId, action: 'mail_settings.update', entityType: 'mail_settings', summary: `driver ${body.driver}`, details: { secretsChanged: changedSecrets.length } },
        c,
      );
    });
    return mailSettingsView(app.db, contractorId);
  });

  /** "Send test e-mail" to the caller's own address. */
  app.post('/api/admin/mail/test', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId, { allowPlatform: true });
    const user = currentUser(request);
    try {
      const sender = await getMailSender(app, contractorId);
      const res = await sender.send(mailTemplates.testMessage({ to: user.email, fullName: user.fullName, driver: sender.driver }));
      await auditFromRequest(request, { contractorId, action: 'mail.test', entityType: 'mail_settings', summary: `test sent via ${res.driver}` });
      return { ok: true, driver: res.driver, to: user.email, messageId: res.messageId ?? null };
    } catch (err) {
      const message = String((err as Error).message ?? err).slice(0, 300);
      await auditFromRequest(request, { contractorId, action: 'mail.test_failed', entityType: 'mail_settings', summary: message });
      throw new AppError(502, 'mail_failed', `The test e-mail could not be sent: ${message}`);
    }
  });

  // ───── Messaging settings ─────
  app.get('/api/admin/messaging', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    await app.db.query('INSERT INTO messaging_settings (contractor_id) VALUES ($1) ON CONFLICT DO NOTHING', [contractorId]);
    const r = await app.db.query(
      `SELECT whatsapp_mode AS "whatsappMode", whatsapp_number AS "whatsappNumber", linked_session_state AS "linkedSessionState",
              push_enabled AS "pushEnabled", sms_provider AS "smsProvider", rate_limit_per_minute AS "rateLimitPerMinute",
              to_char(quiet_hours_start, 'HH24:MI') AS "quietHoursStart", to_char(quiet_hours_end, 'HH24:MI') AS "quietHoursEnd",
              updated_at AS "updatedAt"
         FROM messaging_settings WHERE contractor_id = $1`,
      [contractorId],
    );
    return {
      ...r.rows[0],
      linkedSessionWarning:
        'Linked session (QR scan) is unofficial and against WhatsApp terms: the number can be banned and the session can drop. Use a separate number, only for contacts who agreed, at a slow rate.',
    };
  });

  app.put('/api/admin/messaging', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    const body = z
      .object({
        whatsappMode: z.enum(['click_to_chat', 'linked_session']).optional(),
        whatsappNumber: z.string().trim().regex(/^\+\d{8,15}$/).nullish(),
        pushEnabled: z.boolean().optional(),
        smsProvider: z.string().trim().max(60).nullish(),
        rateLimitPerMinute: z.number().int().min(1).max(120).optional(),
        quietHoursStart: time.nullish(),
        quietHoursEnd: time.nullish(),
      })
      .strict()
      .parse(request.body);
    await app.db.query('INSERT INTO messaging_settings (contractor_id) VALUES ($1) ON CONFLICT DO NOTHING', [contractorId]);
    await app.db.query(
      `UPDATE messaging_settings SET
         whatsapp_mode = COALESCE($2, whatsapp_mode),
         whatsapp_number = CASE WHEN $3::boolean THEN $4 ELSE whatsapp_number END,
         push_enabled = COALESCE($5, push_enabled),
         sms_provider = CASE WHEN $6::boolean THEN $7 ELSE sms_provider END,
         rate_limit_per_minute = COALESCE($8, rate_limit_per_minute),
         quiet_hours_start = CASE WHEN $9::boolean THEN $10::time ELSE quiet_hours_start END,
         quiet_hours_end = CASE WHEN $11::boolean THEN $12::time ELSE quiet_hours_end END,
         updated_by = $13, updated_at = now()
       WHERE contractor_id = $1`,
      [
        contractorId, body.whatsappMode ?? null, body.whatsappNumber !== undefined, body.whatsappNumber ?? null, body.pushEnabled ?? null,
        body.smsProvider !== undefined, body.smsProvider ?? null, body.rateLimitPerMinute ?? null, body.quietHoursStart !== undefined,
        body.quietHoursStart ?? null, body.quietHoursEnd !== undefined, body.quietHoursEnd ?? null, request.auth!.user.id,
      ],
    );
    await auditFromRequest(request, { contractorId, action: 'messaging_settings.update', entityType: 'messaging_settings', details: { changes: body } });
    return { ok: true };
  });

  // ───── Marafiq connection (settings only; worker endpoints come later) ─────
  const connectionView = async (contractorId: string) => {
    await app.db.query(`INSERT INTO marafiq_connection (contractor_id, name) VALUES ($1, 'Main') ON CONFLICT DO NOTHING`, [contractorId]);
    const r = await app.db.query(
      `SELECT id, name, base_url, project, username, secret_id, mode, write_level, paused, state, schedule, enabled_lists,
              last_success, last_sign_in_at, last_error, updated_at
         FROM marafiq_connection WHERE contractor_id = $1 AND name = 'Main'`,
      [contractorId],
    );
    const c = r.rows[0];
    return {
      id: c.id, name: c.name, baseUrl: c.base_url, project: c.project, username: c.username,
      hasPassword: await hasSecret(app.db, c.secret_id),
      mode: c.mode, writeLevel: c.write_level, paused: c.paused, state: c.state, schedule: c.schedule, enabledLists: c.enabled_lists,
      lastSuccess: c.last_success, lastSignInAt: c.last_sign_in_at, lastError: c.last_error, updatedAt: c.updated_at,
    };
  };

  app.get('/api/admin/marafiq-connection', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    return connectionView(contractorId);
  });

  app.put('/api/admin/marafiq-connection', admins, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId)!;
    const body = z
      .object({
        baseUrl: z.string().trim().url().refine((u) => u.startsWith('https://'), 'Use an https:// address.').nullish(),
        project: z.string().trim().min(1).max(40).optional(),
        username: z.string().trim().max(120).nullish(),
        /** Write-only. */
        password: z.string().max(500).optional(),
        clearPassword: z.boolean().optional(),
        mode: z.enum(['off', 'read_only']).optional(),
        paused: z.boolean().optional(),
        schedule: z.record(z.string(), z.unknown()).optional(),
        enabledLists: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      })
      .strict()
      .parse(request.body);
    await connectionView(contractorId); // ensures the row exists
    await withTx(app.db, async (c) => {
      const cur = (await c.query<{ id: string; secret_id: string | null; state: string }>(
        `SELECT id, secret_id, state FROM marafiq_connection WHERE contractor_id = $1 AND name = 'Main' FOR UPDATE`,
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
           secret_id = $7, mode = COALESCE($8, mode), paused = COALESCE($9, paused),
           schedule = COALESCE($10::jsonb, schedule), enabled_lists = COALESCE($11, enabled_lists),
           state = $12, updated_at = now()
         WHERE id = $1`,
        [
          cur.id, body.baseUrl !== undefined, body.baseUrl ?? null, body.project ?? null, body.username !== undefined, body.username ?? null,
          secretId, body.mode ?? null, body.paused ?? null, body.schedule ? JSON.stringify(body.schedule) : null, body.enabledLists ?? null, state,
        ],
      );
      const { password: _p, ...rest } = body;
      await auditFromRequest(
        request,
        { contractorId, action: 'marafiq_connection.update', entityType: 'marafiq_connection', entityId: cur.id, details: { fields: Object.keys(rest), passwordChanged: !!body.password } },
        c,
      );
    });
    return connectionView(contractorId);
  });
}
