import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, currentUser, requireRole } from '../auth/guards.js';
import { withTx } from '../db.js';
import { AppError } from '../errors.js';
import { getMailSender, mailSettingsInput, mailSettingsView, mailTemplates, saveMailSettings } from '../mail/index.js';

const scopeQuery = z.object({ contractorId: z.string().uuid().optional() });

/**
 * Audit log and mail settings.
 * Messaging settings (/api/admin/messaging) live in src/comm/routes.ts;
 * the Marafiq connection (/api/admin/marafiq-connection*) in src/connection/routes.ts.
 */
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
}
