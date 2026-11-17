/**
 * Route guards and the tenant context. Every route that touches contractor data uses these.
 *
 *   app.get('/api/things', { preHandler: requireRole('coordinator', 'manager') }, async (req) => {
 *     const contractorId = requireTenant(req);           // caller's contractor, never from input
 *     return listThings(app.db, contractorId);
 *   });
 *
 *   // Admin routes a platform admin may also use for a chosen contractor:
 *   const contractorId = adminScope(req, query.contractorId);
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { AuthUser } from '../types.js';
import { ALL_TEAMS_ROLES, type Role } from './roles.js';
import type { Queryable } from '../db.js';

/** preHandler: any signed-in user. */
export const requireAuth: preHandlerAsyncHookHandler = async function (request: FastifyRequest, _reply: FastifyReply) {
  if (!request.auth) throw unauthorized();
};

/** preHandler: signed-in user with one of the given roles. */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  return async function (request: FastifyRequest) {
    if (!request.auth) throw unauthorized();
    if (!roles.includes(request.auth.user.role)) throw forbidden();
  };
}

/** The signed-in user (throws 401). */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.auth) throw unauthorized();
  return request.auth.user;
}

/**
 * The caller's contractor id for work-data routes. The platform admin has no contractor and
 * cannot see work data, so this throws 403 for them.
 */
export function requireTenant(request: FastifyRequest): string {
  const user = currentUser(request);
  if (!user.contractorId) throw forbidden('This needs a contractor account.');
  return user.contractorId;
}

/**
 * Contractor scope for ADMIN routes (users, teams, rules, lookups, mail, audit):
 *  - contractor users: always their own contractor; asking for another one → 403.
 *  - platform admin: the requested contractor (required unless allowPlatform, then null = platform scope).
 */
export function adminScope(request: FastifyRequest, requested?: string | null, opts: { allowPlatform?: boolean } = {}): string | null {
  const user = currentUser(request);
  if (user.role === 'platform_admin') {
    if (requested) return requested;
    if (opts.allowPlatform) return null;
    throw new AppError(400, 'contractor_required', 'Choose a contractor (contractorId).');
  }
  if (requested && requested !== user.contractorId) throw forbidden();
  return user.contractorId!;
}

/**
 * Scope for acting on ONE existing record (by id) in an admin route.
 * recordContractorId = the record's contractor_id (undefined when the record does not exist).
 * Contractor users acting on another contractor's record get 404 (existence is not revealed);
 * the platform admin gets the record's contractor.
 */
export function recordScope(request: FastifyRequest, recordContractorId: string | null | undefined, what = 'Record'): string {
  const user = currentUser(request);
  if (!recordContractorId) throw new AppError(404, 'not_found', `${what} not found.`);
  if (user.role === 'platform_admin') return recordContractorId;
  if (recordContractorId !== user.contractorId) throw new AppError(404, 'not_found', `${what} not found.`);
  return recordContractorId;
}

/** True when the user sees all work teams of the contractor. */
export function seesAllTeams(user: AuthUser): boolean {
  return ALL_TEAMS_ROLES.includes(user.role);
}

/** Work-team ids of a user (empty list for all-teams roles means "all"). */
export async function userWorkTeamIds(db: Queryable, userId: string, contractorId: string): Promise<string[]> {
  const r = await db.query<{ work_team_id: string }>(
    'SELECT work_team_id FROM user_work_team WHERE user_id = $1 AND contractor_id = $2',
    [userId, contractorId],
  );
  return r.rows.map((x) => x.work_team_id);
}

/**
 * Work-team codes that limit what the user sees, or null when the user sees every team
 * (all-teams role, or a team-scoped user without any team assigned = "Empty = all teams" per the template).
 */
export async function teamScope(db: Queryable, user: AuthUser): Promise<string[] | null> {
  if (!user.contractorId || seesAllTeams(user)) return null;
  const r = await db.query<{ code: string }>(
    `SELECT t.code FROM user_work_team ut JOIN work_team t ON t.id = ut.work_team_id
      WHERE ut.user_id = $1 AND ut.contractor_id = $2`,
    [user.id, user.contractorId],
  );
  return r.rows.length ? r.rows.map((x) => x.code) : null;
}
