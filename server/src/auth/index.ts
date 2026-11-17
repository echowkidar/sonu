/**
 * Public auth API for route authors.
 *
 *   import { requireAuth, requireRole, requireTenant, adminScope, currentUser, teamScope } from '../auth/index.js';
 *
 *   app.get('/api/work-requests', { preHandler: requireRole('coordinator', 'manager', 'supervisor') }, async (req) => {
 *     const contractorId = requireTenant(req);   // ALWAYS filter queries by this
 *     const teams = await teamScope(app.db, currentUser(req)); // null = all teams
 *     ...
 *   });
 *
 * Mutating requests must carry `X-Requested-With: sonu` (checked globally by the auth plugin).
 */
export { requireAuth, requireRole, requireTenant, adminScope, currentUser, seesAllTeams, teamScope, userWorkTeamIds } from './guards.js';
export { ROLES, CONTRACTOR_ROLES, ALL_TEAMS_ROLES, TEAM_SCOPED_ROLES, ROLE_LABELS, roleFromLabel, isContractorRole } from './roles.js';
export type { Role, ContractorRole } from './roles.js';
export { hashPassword, verifyPassword, passwordSchema } from './password.js';
export { startSession, endSession, endAllSessions, SESSION_COOKIE } from './session.js';
export { createInvitation, sendInvitationEmail, inviteUser, sendPasswordResetEmail, inviteLink, findValidToken } from './invitations.js';
export { CSRF_HEADER, CSRF_VALUE } from './plugin.js';
export type { AuthUser, AuthContext } from '../types.js';
