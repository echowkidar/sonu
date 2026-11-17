import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db.js';
import type { AuthUser } from '../types.js';
import { randomToken, sha256 } from './tokens.js';

export const SESSION_COOKIE = 'sonu_session';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: AuthUser['role'];
  contractor_id: string | null;
  status: AuthUser['status'];
  language: string;
}

export function toAuthUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    contractorId: r.contractor_id,
    status: r.status,
    language: r.language,
  };
}

function isHttps(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/** Creates a DB session and sets the httpOnly cookie. */
export async function startSession(request: FastifyRequest, reply: FastifyReply, user: AuthUser): Promise<string> {
  const token = randomToken(32);
  const days = request.server.config.sessionDays;
  const r = await request.server.db.query<{ id: string }>(
    `INSERT INTO session (user_id, contractor_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id`,
    [user.id, user.contractorId, sha256(token), request.clientIp, (request.headers['user-agent'] ?? '').slice(0, 300), days],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(request),
    maxAge: days * 24 * 3600,
  });
  const id = r.rows[0]!.id;
  request.auth = { user, sessionId: id };
  return id;
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps(request) });
}

/** Looks up an active session by its cookie token; refreshes last_seen_at at most every 5 minutes. */
export async function loadSession(db: Queryable, token: string): Promise<{ sessionId: string; user: AuthUser } | null> {
  const r = await db.query<UserRow & { session_id: string; stale: boolean }>(
    `SELECT s.id AS session_id, (s.last_seen_at < now() - interval '5 minutes') AS stale,
            u.id, u.email, u.full_name, u.role, u.contractor_id, u.status, u.language
       FROM session s
       JOIN app_user u ON u.id = s.user_id
       LEFT JOIN contractor c ON c.id = u.contractor_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'
        AND (u.contractor_id IS NULL OR c.status = 'active')`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.stale) await db.query('UPDATE session SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  return { sessionId: row.session_id, user: toAuthUser(row) };
}

export async function endSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM session WHERE id = $1', [sessionId]);
}

export async function endAllSessions(db: Queryable, userId: string, exceptSessionId?: string): Promise<void> {
  await db.query('DELETE FROM session WHERE user_id = $1 AND id IS DISTINCT FROM $2', [userId, exceptSessionId ?? null]);
}
