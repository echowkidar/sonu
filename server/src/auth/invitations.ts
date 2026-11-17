/**
 * Invitation and password-reset links: single use, token stored only as a SHA-256 hash, expiry.
 *
 *   const token = await createInvitation(client, { userId, contractorId, createdBy });  // inside a tx
 *   ...commit...
 *   await sendInvitationEmail(app, { userId, token });                                  // after commit
 *
 * or, outside a transaction:  await inviteUser(app, userId, createdBy)
 */
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db.js';
import { sendMail, mailTemplates } from '../mail/index.js';
import { randomToken, sha256 } from './tokens.js';

export type TokenKind = 'invite' | 'password_reset';

export async function createInvitation(
  db: Queryable,
  p: { userId: string; contractorId: string | null; createdBy?: string | null; kind?: TokenKind; ttlMs?: number },
): Promise<string> {
  const kind = p.kind ?? 'invite';
  const ttlMs = p.ttlMs ?? (kind === 'invite' ? 7 * 24 * 3600_000 : 2 * 3600_000);
  // Only the newest link of a kind works.
  await db.query(
    `UPDATE invitation SET revoked_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [p.userId, kind],
  );
  const token = randomToken(32);
  await db.query(
    `INSERT INTO invitation (contractor_id, user_id, kind, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'), $6)`,
    [p.contractorId, p.userId, kind, sha256(token), ttlMs, p.createdBy ?? null],
  );
  return token;
}

export function inviteLink(app: FastifyInstance, token: string): string {
  return `${app.config.publicUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function resetLink(app: FastifyInstance, token: string): string {
  return `${app.config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

interface InviteeRow {
  id: string;
  email: string;
  full_name: string;
  contractor_id: string | null;
  company: string | null;
}

async function invitee(db: Queryable, userId: string): Promise<InviteeRow> {
  const r = await db.query<InviteeRow>(
    `SELECT u.id, u.email, u.full_name, u.contractor_id, c.name AS company
       FROM app_user u LEFT JOIN contractor c ON c.id = u.contractor_id WHERE u.id = $1`,
    [userId],
  );
  if (!r.rows[0]) throw new Error('invitee not found');
  return r.rows[0];
}

/** Sends the invitation e-mail through the contractor's sender (platform / log fallback). */
export async function sendInvitationEmail(app: FastifyInstance, p: { userId: string; token: string }): Promise<{ driver: string }> {
  const u = await invitee(app.db, p.userId);
  const res = await sendMail(
    app,
    u.contractor_id,
    mailTemplates.invitation({
      to: u.email,
      fullName: u.full_name,
      companyName: u.company,
      link: inviteLink(app, p.token),
      days: app.config.inviteDays,
    }),
  );
  return { driver: res.driver };
}

/** Creates a fresh invitation (old links stop working) and e-mails it. */
export async function inviteUser(app: FastifyInstance, userId: string, createdBy: string | null): Promise<{ driver: string }> {
  const u = await invitee(app.db, userId);
  const token = await createInvitation(app.db, {
    userId,
    contractorId: u.contractor_id,
    createdBy,
    ttlMs: app.config.inviteDays * 24 * 3600_000,
  });
  return sendInvitationEmail(app, { userId, token });
}

export async function sendPasswordResetEmail(app: FastifyInstance, userId: string): Promise<void> {
  const u = await invitee(app.db, userId);
  const token = await createInvitation(app.db, {
    userId,
    contractorId: u.contractor_id,
    kind: 'password_reset',
    ttlMs: app.config.resetHours * 3600_000,
  });
  await sendMail(app, u.contractor_id, mailTemplates.passwordReset({ to: u.email, fullName: u.full_name, link: resetLink(app, token), hours: app.config.resetHours }));
}

export interface ValidToken {
  invitationId: string;
  userId: string;
  contractorId: string | null;
  email: string;
  fullName: string;
  userStatus: 'invited' | 'active' | 'inactive';
}

/** Finds a usable token (not used, not revoked, not expired). Pass a tx client + forUpdate when consuming. */
export async function findValidToken(db: Queryable, token: string, kind: TokenKind, forUpdate = false): Promise<ValidToken | null> {
  const r = await db.query<{ id: string; user_id: string; contractor_id: string | null; email: string; full_name: string; status: ValidToken['userStatus'] }>(
    `SELECT i.id, i.user_id, i.contractor_id, u.email, u.full_name, u.status
       FROM invitation i JOIN app_user u ON u.id = i.user_id
      WHERE i.token_hash = $1 AND i.kind = $2 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
    [sha256(token), kind],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    invitationId: row.id,
    userId: row.user_id,
    contractorId: row.contractor_id,
    email: row.email,
    fullName: row.full_name,
    userStatus: row.status,
  };
}
