import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, auditFromRequest } from '../audit.js';
import { withTx } from '../db.js';
import { AppError } from '../errors.js';
import { getUser } from '../users/service.js';
import { currentUser, requireAuth } from './guards.js';
import { findValidToken, sendPasswordResetEmail } from './invitations.js';
import { burnPasswordTime, hashPassword, passwordSchema, verifyPassword } from './password.js';
import { clearSessionCookie, endAllSessions, endSession, startSession, toAuthUser } from './session.js';
import { sha256 } from './tokens.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export async function countUsers(app: FastifyInstance): Promise<number> {
  const r = await app.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_user');
  return r.rows[0]!.n;
}

async function meView(app: FastifyInstance, userId: string) {
  const user = await getUser(app.db, userId);
  let contractor = null;
  if (user.contractorId) {
    const r = await app.db.query<{ id: string; code: string; name: string; time_zone: string }>(
      'SELECT id, code, name, time_zone FROM contractor WHERE id = $1',
      [user.contractorId],
    );
    const c = r.rows[0];
    if (c) contractor = { id: c.id, code: c.code, name: c.name, timeZone: c.time_zone };
  }
  // web/src/lib/session.ts reads user.{id,email,fullName,role,contractorId,contractorName}
  return { user: { ...user, contractorName: contractor?.name ?? null }, contractor };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // ───── First run ─────
  app.get('/api/setup', async () => ({ needed: (await countUsers(app)) === 0 }));

  app.post('/api/setup', async (request, reply) => {
    const body = z
      .object({ code: z.string().trim().min(1), email: emailSchema, fullName: z.string().trim().min(2).max(120), password: passwordSchema })
      .parse(request.body);
    const expected = app.setupState.code;
    const given = body.code.toUpperCase().replace(/\s+/g, '');
    if (!expected || sha256(given) !== sha256(expected)) {
      throw new AppError(403, 'setup_code_invalid', 'The setup code is not valid (see the server log), or setup is already done.');
    }
    const hash = await hashPassword(body.password);
    const user = await withTx(app.db, async (c) => {
      await c.query('LOCK TABLE app_user IN EXCLUSIVE MODE');
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM app_user')).rows[0]!.n;
      if (n > 0) throw new AppError(409, 'setup_done', 'Setup is already done.');
      const r = await c.query(
        `INSERT INTO app_user (contractor_id, email, full_name, password_hash, role, status, email_verified_at)
         VALUES (NULL, $1, $2, $3, 'platform_admin', 'active', now())
         RETURNING id, email, full_name, role, contractor_id, status, language`,
        [body.email, body.fullName, hash],
      );
      const u = toAuthUser(r.rows[0]);
      await audit(c, { contractorId: null, userId: u.id, userEmail: u.email, action: 'setup.platform_admin_created', entityType: 'user', entityId: u.id, ip: request.clientIp });
      return u;
    });
    app.setupState.code = null;
    app.log.info('first-run setup completed; setup code is no longer valid');
    await startSession(request, reply, user);
    return reply.status(201).send(await meView(app, user.id));
  });

  // ───── Sign in / out ─────
  app.post('/api/auth/login', async (request, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(500) }).parse(request.body);
    const ip = request.clientIp;
    const wait = app.loginLimiter.check(ip, body.email);
    if (wait > 0) {
      reply.header('Retry-After', String(wait));
      throw new AppError(429, 'rate_limited', `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    }
    const r = await app.db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.contractor_id, u.status, u.language, u.password_hash,
              c.status AS contractor_status
         FROM app_user u LEFT JOIN contractor c ON c.id = u.contractor_id
        WHERE lower(u.email) = $1`,
      [body.email],
    );
    const row = r.rows[0];
    let ok = false;
    if (row?.password_hash) ok = await verifyPassword(body.password, row.password_hash);
    else await burnPasswordTime(body.password);
    const allowed = ok && row.status === 'active' && (row.contractor_id === null || row.contractor_status === 'active');
    if (!allowed) {
      app.loginLimiter.fail(ip, body.email);
      await audit(app.db, {
        contractorId: row?.contractor_id ?? null,
        userId: row?.id ?? null,
        userEmail: body.email,
        action: 'auth.login_failed',
        summary: ok ? 'account not active' : 'wrong e-mail or password',
        ip,
      });
      throw new AppError(401, 'invalid_credentials', 'E-mail or password is not correct.');
    }
    app.loginLimiter.succeed(body.email);
    const user = toAuthUser(row);
    await app.db.query('UPDATE app_user SET last_login_at = now() WHERE id = $1', [user.id]);
    await startSession(request, reply, user);
    await auditFromRequest(request, { action: 'auth.login', entityType: 'user', entityId: user.id });
    return meView(app, user.id);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth) {
      await auditFromRequest(request, { action: 'auth.logout', entityType: 'user', entityId: request.auth.user.id });
      await endSession(app.db, request.auth.sessionId);
    }
    clearSessionCookie(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => meView(app, currentUser(request).id));

  app.post('/api/auth/password', { preHandler: requireAuth }, async (request) => {
    const body = z.object({ currentPassword: z.string().max(500), newPassword: passwordSchema }).parse(request.body);
    const user = currentUser(request);
    const r = await app.db.query<{ password_hash: string | null }>('SELECT password_hash FROM app_user WHERE id = $1', [user.id]);
    if (!(await verifyPassword(body.currentPassword, r.rows[0]?.password_hash))) {
      throw new AppError(400, 'wrong_password', 'The current password is not correct.');
    }
    await app.db.query('UPDATE app_user SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
    await endAllSessions(app.db, user.id, request.auth!.sessionId);
    await auditFromRequest(request, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    return { ok: true };
  });

  // ───── Invitation ─────
  // Token travels in the POST body (not the URL) so it never appears in access logs.
  app.post('/api/auth/invitation/check', async (request) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
    const t = await findValidToken(app.db, token, 'invite');
    if (!t || t.userStatus === 'inactive') throw new AppError(410, 'invitation_invalid', 'This invitation link is not valid any more. Ask your administrator to send a new one.');
    return { email: t.email, fullName: t.fullName };
  });

  app.post('/api/auth/accept-invite', async (request, reply) => {
    const body = z
      .object({ token: z.string().min(10).max(200), password: passwordSchema, fullName: z.string().trim().min(2).max(120).optional() })
      .parse(request.body);
    const hash = await hashPassword(body.password);
    const userId = await withTx(app.db, async (c) => {
      const t = await findValidToken(c, body.token, 'invite', true);
      if (!t || t.userStatus === 'inactive') throw new AppError(410, 'invitation_invalid', 'This invitation link is not valid any more. Ask your administrator to send a new one.');
      await c.query('UPDATE invitation SET used_at = now() WHERE id = $1', [t.invitationId]);
      await c.query(
        `UPDATE app_user SET password_hash = $2, status = 'active', email_verified_at = COALESCE(email_verified_at, now()),
                full_name = COALESCE($3, full_name), updated_at = now() WHERE id = $1`,
        [t.userId, hash, body.fullName ?? null],
      );
      await audit(c, { contractorId: t.contractorId, userId: t.userId, userEmail: t.email, action: 'auth.invitation_accepted', entityType: 'user', entityId: t.userId, ip: request.clientIp });
      return t.userId;
    });
    const r = await app.db.query(
      'SELECT id, email, full_name, role, contractor_id, status, language FROM app_user WHERE id = $1',
      [userId],
    );
    await startSession(request, reply, toAuthUser(r.rows[0]));
    return meView(app, userId);
  });

  // ───── Password reset ─────
  app.post('/api/auth/forgot-password', async (request) => {
    const { email } = z.object({ email: emailSchema }).parse(request.body);
    const ip = request.clientIp;
    if (app.loginLimiter.check(ip, `reset:${email}`) === 0) {
      app.loginLimiter.fail(ip, `reset:${email}`); // counts towards the limit so the endpoint cannot be used to spam
      const r = await app.db.query<{ id: string; contractor_id: string | null }>(
        `SELECT id, contractor_id FROM app_user WHERE lower(email) = $1 AND status = 'active'`,
        [email],
      );
      const u = r.rows[0];
      if (u) {
        await sendPasswordResetEmail(app, u.id).catch((err) => request.log.warn({ err: (err as Error).message }, 'password reset mail failed'));
        await audit(app.db, { contractorId: u.contractor_id, userId: u.id, userEmail: email, action: 'auth.password_reset_requested', entityType: 'user', entityId: u.id, ip });
      }
    }
    // Same answer whether or not the address exists.
    return { ok: true, message: 'If the address belongs to an active account, a reset link has been sent.' };
  });

  app.post('/api/auth/reset-password', async (request) => {
    const body = z.object({ token: z.string().min(10).max(200), password: passwordSchema }).parse(request.body);
    const hash = await hashPassword(body.password);
    await withTx(app.db, async (c) => {
      const t = await findValidToken(c, body.token, 'password_reset', true);
      if (!t || t.userStatus !== 'active') throw new AppError(410, 'reset_invalid', 'This reset link is not valid any more. Ask for a new one.');
      await c.query('UPDATE invitation SET used_at = now() WHERE id = $1', [t.invitationId]);
      await c.query('UPDATE app_user SET password_hash = $2, updated_at = now() WHERE id = $1', [t.userId, hash]);
      await endAllSessions(c, t.userId);
      await audit(c, { contractorId: t.contractorId, userId: t.userId, userEmail: t.email, action: 'auth.password_reset', entityType: 'user', entityId: t.userId, ip: request.clientIp });
    });
    return { ok: true };
  });
}
