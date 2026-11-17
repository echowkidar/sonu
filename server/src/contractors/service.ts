import { z } from 'zod';
import type { Queryable } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { createInvitation } from '../auth/invitations.js';
import { seedContractor, ensureWorkTeams } from './seed.js';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const mobileSchema = z.string().trim().regex(/^\+\d{8,15}$/, 'Mobile with country code, no spaces, e.g. +97455550100.');
const list = z.array(z.string().trim().min(1).max(60)).max(200);

export const contractorFields = {
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash or underscore.'),
  name: z.string().trim().min(2).max(200),
  nameAr: z.string().trim().max(200).nullish(),
  marafiqTradeCode: z.string().trim().max(60).nullish(),
  marafiqWorkTeams: list.optional(),
  disciplines: list.optional(),
  senderEmail: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional(),
  timeZone: z.string().trim().refine(isValidTimeZone, 'Unknown time zone.').optional(),
  status: z.enum(['active', 'inactive']).optional(),
  notes: z.string().max(5000).nullish(),
};

export const contractorCreateSchema = z
  .object({
    ...contractorFields,
    admin: z.object({
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email().max(254),
      mobile: mobileSchema.nullish(),
    }),
  })
  .strict();

export const contractorUpdateSchema = z.object(contractorFields).partial().strict();

export type ContractorCreate = z.infer<typeof contractorCreateSchema>;
export type ContractorUpdate = z.infer<typeof contractorUpdateSchema>;

interface ContractorRow {
  id: string;
  code: string;
  name: string;
  name_ar: string | null;
  marafiq_trade_code: string | null;
  marafiq_work_teams: string[];
  disciplines: string[];
  sender_email: string | null;
  time_zone: string;
  status: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  user_count?: number;
}

export function contractorView(r: ContractorRow) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    nameAr: r.name_ar,
    marafiqTradeCode: r.marafiq_trade_code,
    marafiqWorkTeams: r.marafiq_work_teams,
    disciplines: r.disciplines,
    senderEmail: r.sender_email,
    timeZone: r.time_zone,
    status: r.status,
    notes: r.notes,
    userCount: r.user_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listContractors(db: Queryable) {
  const r = await db.query<ContractorRow>(
    `SELECT c.*, (SELECT count(*)::int FROM app_user u WHERE u.contractor_id = c.id) AS user_count
       FROM contractor c ORDER BY c.name`,
  );
  return r.rows.map(contractorView);
}

export async function getContractor(db: Queryable, id: string) {
  const r = await db.query<ContractorRow>(
    `SELECT c.*, (SELECT count(*)::int FROM app_user u WHERE u.contractor_id = c.id) AS user_count FROM contractor c WHERE c.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound('Contractor not found.');
  return contractorView(r.rows[0]);
}

export async function findContractorByCode(db: Queryable, code: string): Promise<{ id: string; code: string } | undefined> {
  const r = await db.query<{ id: string; code: string }>('SELECT id, code FROM contractor WHERE lower(code) = lower($1)', [code]);
  return r.rows[0];
}

/**
 * Creates the contractor, its admin user (status invited), the invitation token, and seeds
 * deadline rules, lookups, messaging settings and the Marafiq connection row. Run inside a tx;
 * send the e-mail (sendInvitationEmail) after commit.
 */
export async function createContractor(
  db: Queryable,
  input: ContractorCreate,
  opts: { createdBy: string | null; assetsDir: string; inviteTtlMs: number },
): Promise<{ contractorId: string; adminUserId: string; inviteToken: string }> {
  if (await findContractorByCode(db, input.code)) throw conflict(`Contractor code ${input.code} already exists.`);
  const taken = await db.query('SELECT 1 FROM app_user WHERE lower(email) = lower($1)', [input.admin.email]);
  if (taken.rowCount) throw conflict(`The e-mail ${input.admin.email} already belongs to a user.`);

  const teams = input.marafiqWorkTeams ?? [];
  const c = await db.query<{ id: string }>(
    `INSERT INTO contractor (code, name, name_ar, marafiq_trade_code, marafiq_work_teams, disciplines, sender_email, time_zone, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.code, input.name, input.nameAr ?? null, input.marafiqTradeCode ?? null, teams, input.disciplines ?? [],
      input.senderEmail || null, input.timeZone ?? 'Asia/Qatar', input.status ?? 'active', input.notes ?? null,
    ],
  );
  const contractorId = c.rows[0]!.id;
  await seedContractor(db, contractorId, opts.assetsDir, teams);
  const u = await db.query<{ id: string }>(
    `INSERT INTO app_user (contractor_id, email, full_name, role, status, mobile) VALUES ($1, $2, $3, 'contractor_admin', 'invited', $4) RETURNING id`,
    [contractorId, input.admin.email, input.admin.fullName, input.admin.mobile ?? null],
  );
  const adminUserId = u.rows[0]!.id;
  const inviteToken = await createInvitation(db, { userId: adminUserId, contractorId, createdBy: opts.createdBy, ttlMs: opts.inviteTtlMs });
  return { contractorId, adminUserId, inviteToken };
}

export async function updateContractor(db: Queryable, id: string, input: ContractorUpdate): Promise<void> {
  const map: Record<string, [string, unknown]> = {
    code: ['code', input.code],
    name: ['name', input.name],
    nameAr: ['name_ar', input.nameAr],
    marafiqTradeCode: ['marafiq_trade_code', input.marafiqTradeCode],
    marafiqWorkTeams: ['marafiq_work_teams', input.marafiqWorkTeams],
    disciplines: ['disciplines', input.disciplines],
    senderEmail: ['sender_email', input.senderEmail === '' ? null : input.senderEmail],
    timeZone: ['time_zone', input.timeZone],
    status: ['status', input.status],
    notes: ['notes', input.notes],
  };
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, [col, val]] of Object.entries(map)) {
    if ((input as Record<string, unknown>)[key] === undefined) continue;
    params.push(val ?? null);
    sets.push(`${col} = $${params.length}`);
  }
  if (input.code) {
    const other = await findContractorByCode(db, input.code);
    if (other && other.id !== id) throw conflict(`Contractor code ${input.code} already exists.`);
  }
  if (!sets.length) return;
  const r = await db.query(`UPDATE contractor SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  if (!r.rowCount) throw notFound('Contractor not found.');
  if (input.marafiqWorkTeams) await ensureWorkTeams(db, id, input.marafiqWorkTeams);
}
