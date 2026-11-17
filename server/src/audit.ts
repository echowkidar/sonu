/**
 * Audit log: one row for every create / change / import / export / sign-in / connection use.
 * Details are passed through redactSecrets() so a stored secret can never land here.
 *
 *   await auditFromRequest(request, { action: 'user.create', entityType: 'user', entityId: id, summary: '...' });
 *   await audit(db, { contractorId, userId, action: 'import.confirm', details: { counts } });
 */
import type { FastifyRequest } from 'fastify';
import type { Queryable } from './db.js';
import { redactSecrets } from './secrets.js';

export interface AuditEntry {
  contractorId: string | null;
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (contractor_id, user_id, user_email, action, entity_type, entity_id, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.contractorId,
      e.userId ?? null,
      e.userEmail ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.summary ?? null,
      JSON.stringify(redactSecrets(e.details ?? {})),
      e.ip ?? null,
    ],
  );
}

/**
 * Audit with the caller taken from the request. contractorId defaults to the caller's contractor;
 * pass it explicitly when a platform admin acts on a contractor.
 */
export async function auditFromRequest(
  request: FastifyRequest,
  e: Omit<AuditEntry, 'userId' | 'userEmail' | 'ip' | 'contractorId'> & { contractorId?: string | null },
  db?: Queryable,
): Promise<void> {
  const user = request.auth?.user;
  await audit(db ?? request.server.db, {
    ...e,
    contractorId: e.contractorId !== undefined ? e.contractorId : (user?.contractorId ?? null),
    userId: user?.id ?? null,
    userEmail: user?.email ?? null,
    ip: request.clientIp,
  });
}
