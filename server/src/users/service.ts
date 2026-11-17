import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';

export interface UserRowFull {
  id: string;
  contractor_id: string | null;
  email: string;
  full_name: string;
  role: string;
  status: string;
  email_verified_at: Date | null;
  mobile: string | null;
  mobile_verified_at: Date | null;
  language: string;
  notify_email: boolean;
  notify_push: boolean;
  notify_whatsapp: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  reports_to: string | null;
  employee_no: string | null;
  craftsperson_code: string | null;
  discipline: string | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  work_teams: { id: string; code: string; name: string | null }[] | null;
}

/** Column list for SELECTs: never includes password_hash. */
export const USER_COLUMNS = `u.id, u.contractor_id, u.email, u.full_name, u.role, u.status, u.email_verified_at, u.mobile,
  u.mobile_verified_at, u.language, u.notify_email, u.notify_push, u.notify_whatsapp,
  to_char(u.quiet_hours_start, 'HH24:MI') AS quiet_hours_start, to_char(u.quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
  u.reports_to, u.employee_no, u.craftsperson_code, u.discipline, u.last_login_at, u.created_at, u.updated_at,
  (SELECT json_agg(json_build_object('id', t.id, 'code', t.code, 'name', t.name) ORDER BY t.code)
     FROM user_work_team ut JOIN work_team t ON t.id = ut.work_team_id WHERE ut.user_id = u.id) AS work_teams`;

export function userView(r: UserRowFull) {
  return {
    id: r.id,
    contractorId: r.contractor_id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    status: r.status,
    emailVerified: !!r.email_verified_at,
    mobile: r.mobile,
    mobileVerified: !!r.mobile_verified_at,
    language: r.language,
    notifyEmail: r.notify_email,
    notifyPush: r.notify_push,
    notifyWhatsapp: r.notify_whatsapp,
    quietHoursStart: r.quiet_hours_start,
    quietHoursEnd: r.quiet_hours_end,
    reportsTo: r.reports_to,
    employeeNo: r.employee_no,
    craftspersonCode: r.craftsperson_code,
    discipline: r.discipline,
    workTeams: r.work_teams ?? [],
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type UserView = ReturnType<typeof userView>;

/**
 * Loads one user. contractorId: the tenant the caller may see (undefined = no check, platform use only).
 * A user of another contractor is reported as "not found".
 */
export async function getUser(db: Queryable, id: string, contractorId?: string | null): Promise<UserView> {
  const r = await db.query<UserRowFull>(
    `SELECT ${USER_COLUMNS} FROM app_user u WHERE u.id = $1 ${contractorId !== undefined ? 'AND u.contractor_id IS NOT DISTINCT FROM $2' : ''}`,
    contractorId !== undefined ? [id, contractorId] : [id],
  );
  if (!r.rows[0]) throw notFound('User not found.');
  return userView(r.rows[0]);
}

/** Replaces a user's work teams; ignores team ids that do not belong to the contractor. */
export async function setUserWorkTeams(db: Queryable, contractorId: string, userId: string, teamIds: string[]): Promise<void> {
  await db.query('DELETE FROM user_work_team WHERE user_id = $1 AND contractor_id = $2', [userId, contractorId]);
  if (!teamIds.length) return;
  await db.query(
    `INSERT INTO user_work_team (contractor_id, user_id, work_team_id)
     SELECT $1, $2, t.id FROM work_team t WHERE t.contractor_id = $1 AND t.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [contractorId, userId, teamIds],
  );
}
