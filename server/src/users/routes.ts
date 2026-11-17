import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, currentUser, requireAuth, requireRole } from '../auth/guards.js';
import { inviteUser } from '../auth/invitations.js';
import { CONTRACTOR_ROLES, type ContractorRole } from '../auth/roles.js';
import { endAllSessions } from '../auth/session.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { mobileSchema } from '../contractors/service.js';
import { USER_COLUMNS, getUser, setUserWorkTeams, userView, type UserRowFull } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');
const roleEnum = z.enum(CONTRACTOR_ROLES as [ContractorRole, ...ContractorRole[]]);

const preferenceFields = {
  language: z.string().trim().min(2).max(30).optional(),
  notifyEmail: z.boolean().optional(),
  notifyPush: z.boolean().optional(),
  notifyWhatsapp: z.boolean().optional(),
  quietHoursStart: time.nullish(),
  quietHoursEnd: time.nullish(),
};

const profileFields = {
  fullName: z.string().trim().min(2).max(120).optional(),
  mobile: mobileSchema.nullish(),
  ...preferenceFields,
};

const adminFields = {
  ...profileFields,
  role: roleEnum.optional(),
  discipline: z.string().trim().max(60).nullish(),
  employeeNo: z.string().trim().max(60).nullish(),
  craftspersonCode: z.string().trim().max(60).nullish(),
  reportsTo: z.string().uuid().nullish(),
  workTeamIds: z.array(z.string().uuid()).max(200).optional(),
};

const createSchema = z
  .object({
    ...adminFields,
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(2).max(120),
    role: roleEnum,
    contractorId: z.string().uuid().optional(),
    sendInvite: z.boolean().default(true),
  })
  .strict();

const updateSchema = z.object(adminFields).strict();
const preferencesSchema = z.object(preferenceFields).strict();
const profileSchema = z.object(profileFields).strict();

const COLS: Record<string, string> = {
  fullName: 'full_name',
  mobile: 'mobile',
  language: 'language',
  notifyEmail: 'notify_email',
  notifyPush: 'notify_push',
  notifyWhatsapp: 'notify_whatsapp',
  quietHoursStart: 'quiet_hours_start',
  quietHoursEnd: 'quiet_hours_end',
  role: 'role',
  discipline: 'discipline',
  employeeNo: 'employee_no',
  craftspersonCode: 'craftsperson_code',
  reportsTo: 'reports_to',
};

/** UPDATE app_user with the given camelCase fields (only known columns). */
export async function updateUserFields(db: Queryable, userId: string, fields: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const [k, v] of Object.entries(fields)) {
    const col = COLS[k];
    if (!col || v === undefined) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (mobileChanged(fields)) sets.push('mobile_verified_at = NULL');
  if (!sets.length) return;
  await db.query(`UPDATE app_user SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

function mobileChanged(fields: Record<string, unknown>): boolean {
  return fields.mobile !== undefined;
}

async function checkReportsTo(db: Queryable, contractorId: string, reportsTo: string | null | undefined, selfId?: string) {
  if (!reportsTo) return;
  if (reportsTo === selfId) throw badRequest('A user cannot report to themselves.');
  const r = await db.query('SELECT 1 FROM app_user WHERE id = $1 AND contractor_id = $2', [reportsTo, contractorId]);
  if (!r.rowCount) throw badRequest('"Reports to" must be a user of the same contractor.');
}

/**
 * Resolves the contractor of a target user the caller may administer.
 * Contractor admins: only their own contractor (others → 404). Platform admin: any contractor user.
 */
async function targetScope(request: FastifyRequest, userId: string): Promise<string> {
  const caller = currentUser(request);
  const db = request.server.db;
  if (caller.role === 'platform_admin') {
    const r = await db.query<{ contractor_id: string | null }>('SELECT contractor_id FROM app_user WHERE id = $1', [userId]);
    const row = r.rows[0];
    if (!row) throw notFound('User not found.');
    if (!row.contractor_id) throw forbidden('Platform admin accounts are managed from their own profile.');
    return row.contractor_id;
  }
  const r = await db.query('SELECT 1 FROM app_user WHERE id = $1 AND contractor_id = $2', [userId, caller.contractorId]);
  if (!r.rowCount) throw notFound('User not found.');
  return caller.contractorId!;
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  const readers = { preHandler: requireRole('platform_admin', 'contractor_admin', 'manager', 'coordinator') };
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };

  app.get('/api/admin/users', readers, async (request) => {
    const q = z
      .object({
        contractorId: z.string().uuid().optional(),
        q: z.string().trim().max(100).optional(),
        role: z.string().optional(),
        status: z.enum(['invited', 'active', 'inactive']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const contractorId = adminScope(request, q.contractorId);
    const where = ['u.contractor_id = $1'];
    const params: unknown[] = [contractorId];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where.push(`(lower(u.email) LIKE $${params.length} OR lower(u.full_name) LIKE $${params.length})`);
    }
    if (q.role) {
      params.push(q.role);
      where.push(`u.role = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`u.status = $${params.length}`);
    }
    const total = (await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app_user u WHERE ${where.join(' AND ')}`, params)).rows[0]!.n;
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const r = await app.db.query<UserRowFull>(
      `SELECT ${USER_COLUMNS} FROM app_user u WHERE ${where.join(' AND ')} ORDER BY u.full_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(userView), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/admin/users/:id', readers, async (request) => {
    const { id } = idParam.parse(request.params);
    const contractorId = await targetScope(request, id);
    return getUser(app.db, id, contractorId);
  });

  app.post('/api/admin/users', admins, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const contractorId = adminScope(request, body.contractorId)!;
    const caller = currentUser(request);
    const userId = await withTx(app.db, async (c) => {
      const ctr = await c.query('SELECT 1 FROM contractor WHERE id = $1', [contractorId]);
      if (!ctr.rowCount) throw notFound('Contractor not found.');
      const taken = await c.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [body.email]);
      if (taken.rowCount) throw conflict(`The e-mail ${body.email} already belongs to a user.`);
      await checkReportsTo(c, contractorId, body.reportsTo);
      const r = await c.query<{ id: string }>(
        `INSERT INTO app_user (contractor_id, email, full_name, role, status) VALUES ($1, $2, $3, $4, 'invited') RETURNING id`,
        [contractorId, body.email, body.fullName, body.role],
      );
      const id = r.rows[0]!.id;
      const { email: _e, fullName: _f, role: _r, contractorId: _c, sendInvite: _s, workTeamIds, ...rest } = body;
      await updateUserFields(c, id, rest);
      if (workTeamIds) await setUserWorkTeams(c, contractorId, id, workTeamIds);
      await auditFromRequest(request, { contractorId, action: 'user.create', entityType: 'user', entityId: id, summary: `${body.email} invited as ${body.role}` }, c);
      return id;
    });
    let invitation: unknown = null;
    if (body.sendInvite) {
      try {
        invitation = await inviteUser(app, userId, caller.id);
      } catch (err) {
        request.log.warn({ err: (err as Error).message }, 'invitation e-mail failed');
        invitation = { error: 'The invitation e-mail could not be sent. Use "Resend invitation" after fixing the e-mail settings.' };
      }
    }
    return reply.status(201).send({ user: await getUser(app.db, userId, contractorId), invitation });
  });

  app.patch('/api/admin/users/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);
    const contractorId = await targetScope(request, id);
    const caller = currentUser(request);
    if (id === caller.id && body.role && body.role !== caller.role) throw badRequest('You cannot change your own role.');
    await withTx(app.db, async (c) => {
      await checkReportsTo(c, contractorId, body.reportsTo, id);
      const { workTeamIds, ...rest } = body;
      await updateUserFields(c, id, rest);
      if (workTeamIds) await setUserWorkTeams(c, contractorId, id, workTeamIds);
      if (body.role) await endAllSessions(c, id); // new role → sign in again
      await auditFromRequest(request, { contractorId, action: 'user.update', entityType: 'user', entityId: id, details: { fields: Object.keys(body) } }, c);
    });
    return getUser(app.db, id, contractorId);
  });

  app.put('/api/admin/users/:id/work-teams', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const { workTeamIds } = z.object({ workTeamIds: z.array(z.string().uuid()).max(200) }).parse(request.body);
    const contractorId = await targetScope(request, id);
    await withTx(app.db, async (c) => {
      await setUserWorkTeams(c, contractorId, id, workTeamIds);
      await auditFromRequest(request, { contractorId, action: 'user.work_teams', entityType: 'user', entityId: id, details: { workTeamIds } }, c);
    });
    return getUser(app.db, id, contractorId);
  });

  app.patch('/api/admin/users/:id/preferences', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = preferencesSchema.parse(request.body);
    const contractorId = await targetScope(request, id);
    await updateUserFields(app.db, id, body);
    await auditFromRequest(request, { contractorId, action: 'user.preferences', entityType: 'user', entityId: id, details: { fields: Object.keys(body) } });
    return getUser(app.db, id, contractorId);
  });

  app.post('/api/admin/users/:id/deactivate', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const contractorId = await targetScope(request, id);
    if (id === currentUser(request).id) throw badRequest('You cannot deactivate your own account.');
    await withTx(app.db, async (c) => {
      await c.query(`UPDATE app_user SET status = 'inactive', updated_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE invitation SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [id]);
      await endAllSessions(c, id);
      await auditFromRequest(request, { contractorId, action: 'user.deactivate', entityType: 'user', entityId: id }, c);
    });
    return getUser(app.db, id, contractorId);
  });

  app.post('/api/admin/users/:id/activate', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const contractorId = await targetScope(request, id);
    await app.db.query(
      `UPDATE app_user SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END, updated_at = now() WHERE id = $1`,
      [id],
    );
    await auditFromRequest(request, { contractorId, action: 'user.activate', entityType: 'user', entityId: id });
    return getUser(app.db, id, contractorId);
  });

  app.post('/api/admin/users/:id/resend-invite', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const contractorId = await targetScope(request, id);
    const u = await getUser(app.db, id, contractorId);
    if (u.status !== 'invited') throw new AppError(409, 'not_invited', 'This user has already accepted the invitation (or is inactive).');
    const res = await inviteUser(app, id, currentUser(request).id);
    await auditFromRequest(request, { contractorId, action: 'user.invite_resent', entityType: 'user', entityId: id });
    return { ok: true, invitation: res };
  });

  // ───── Own profile ─────
  app.get('/api/me/profile', { preHandler: requireAuth }, async (request) => getUser(app.db, currentUser(request).id));

  app.patch('/api/me/profile', { preHandler: requireAuth }, async (request) => {
    const body = profileSchema.parse(request.body);
    const user = currentUser(request);
    await updateUserFields(app.db, user.id, body);
    await auditFromRequest(request, { action: 'user.profile', entityType: 'user', entityId: user.id, details: { fields: Object.keys(body) } });
    return getUser(app.db, user.id);
  });
}
