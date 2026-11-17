/**
 * Bulk import: preview (classify parsed rows against the database) and confirm (apply the good
 * rows in one transaction). Nothing but the import_job preview row is written before confirm.
 */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db.js';
import type { AuthUser } from '../types.js';
import { roleFromLabel } from '../auth/roles.js';
import { createInvitation } from '../auth/invitations.js';
import { endAllSessions } from '../auth/session.js';
import { createContractor } from '../contractors/service.js';
import { ensureWorkTeams } from '../contractors/seed.js';
import { TEMPLATE_SPECS, type BulkKind, type BulkParseResult, type BulkProblem, type BulkRow, type BulkValue } from './templateParser.js';

export type RowAction = 'add' | 'update' | 'problem';

export interface PreviewRow {
  sheet: string;
  rowNumber: number;
  action: RowAction;
  /** Match key: contractor code, e-mail, sub-contractor code or code+mobile. */
  key: string;
  values: Record<string, BulkValue>;
  raw: Record<string, string>;
  problems: BulkProblem[];
  /** Problems found by the template parser alone (re-used when the import is confirmed). */
  parseProblems: BulkProblem[];
  /** Information for the preview (not a problem), e.g. "admin user is not changed on update". */
  notes?: string[];
}

export interface Preview {
  kind: BulkKind;
  fileName: string;
  skippedExamples: number;
  rows: PreviewRow[];
}

export function counts(rows: PreviewRow[]) {
  return {
    add: rows.filter((r) => r.action === 'add').length,
    update: rows.filter((r) => r.action === 'update').length,
    problem: rows.filter((r) => r.action === 'problem').length,
  };
}

const s = (v: BulkValue | undefined): string => (typeof v === 'string' ? v : '');
const arr = (v: BulkValue | undefined): string[] => (Array.isArray(v) ? v : []);
const bool = (v: BulkValue | undefined): boolean | null => (typeof v === 'boolean' ? v : null);

interface Ctx {
  db: Queryable;
  caller: AuthUser;
  callerContractorCode: string | null;
}

async function contractorByCode(db: Queryable, code: string) {
  const r = await db.query<{ id: string; code: string }>('SELECT id, code FROM contractor WHERE lower(code) = lower($1)', [code]);
  return r.rows[0];
}

/** Contractor scope check for users / sub-contractor rows. */
async function resolveRowContractor(ctx: Ctx, code: string, problems: BulkProblem[]): Promise<{ id: string; code: string } | undefined> {
  if (!code) return undefined;
  if (ctx.caller.role !== 'platform_admin' && code.toLowerCase() !== (ctx.callerContractorCode ?? '').toLowerCase()) {
    problems.push({ column: 'Contractor Code', reason: `You can only import for your own contractor (${ctx.callerContractorCode}).` });
    return undefined;
  }
  const c = await contractorByCode(ctx.db, code);
  if (!c) problems.push({ column: 'Contractor Code', reason: `Contractor ${code} does not exist. Import or create it first.` });
  return c;
}

function base(row: BulkRow, key: string): PreviewRow {
  return { sheet: row.sheet, rowNumber: row.rowNumber, action: 'problem', key, values: row.values, raw: row.raw, problems: [...row.problems], parseProblems: [...row.problems] };
}

function finish(p: PreviewRow, existing: boolean): PreviewRow {
  p.action = p.problems.length ? 'problem' : existing ? 'update' : 'add';
  return p;
}

// ───────────────────────────── Classification ─────────────────────────────

export async function classify(db: Queryable, caller: AuthUser, parsed: BulkParseResult): Promise<PreviewRow[]> {
  let callerContractorCode: string | null = null;
  if (caller.contractorId) {
    const r = await db.query<{ code: string }>('SELECT code FROM contractor WHERE id = $1', [caller.contractorId]);
    callerContractorCode = r.rows[0]?.code ?? null;
  }
  const ctx: Ctx = { db, caller, callerContractorCode };
  if (parsed.kind === 'contractors') return classifyContractors(ctx, parsed.rows);
  if (parsed.kind === 'users') return classifyUsers(ctx, parsed.rows);
  return classifySubcontractors(ctx, parsed.rows);
}

async function classifyContractors(ctx: Ctx, rows: BulkRow[]): Promise<PreviewRow[]> {
  const out: PreviewRow[] = [];
  const seenCodes = new Set<string>();
  const seenEmails = new Set<string>();
  for (const row of rows) {
    const code = s(row.values.code);
    const p = base(row, code);
    if (code && seenCodes.has(code.toLowerCase())) p.problems.push({ column: 'Contractor Code', reason: 'This code appears more than once in the file.' });
    seenCodes.add(code.toLowerCase());
    const existing = code ? await contractorByCode(ctx.db, code) : undefined;
    if (!existing) {
      const email = s(row.values.adminEmail);
      if (email) {
        const taken = await ctx.db.query('SELECT 1 FROM app_user WHERE lower(email) = $1', [email]);
        if (taken.rowCount) p.problems.push({ column: 'Admin Email', reason: 'This e-mail already belongs to a SONU user.' });
        if (seenEmails.has(email)) p.problems.push({ column: 'Admin Email', reason: 'This e-mail is used for another new contractor in the file.' });
        seenEmails.add(email);
      }
    } else {
      p.notes = ['Existing contractor: company details are updated; the admin user is not changed.'];
    }
    out.push(finish(p, !!existing));
  }
  return out;
}

async function classifyUsers(ctx: Ctx, rows: BulkRow[]): Promise<PreviewRow[]> {
  const out: PreviewRow[] = [];
  const seen = new Set<string>();
  const fileEmails = new Map<string, string>(); // email → contractor code (lower)
  for (const row of rows) {
    const e = s(row.values.email);
    if (e) fileEmails.set(e, s(row.values.contractorCode).toLowerCase());
  }
  const teamCache = new Map<string, Set<string>>();
  for (const row of rows) {
    const email = s(row.values.email);
    const p = base(row, email);
    if (email && seen.has(email)) p.problems.push({ column: 'Email', reason: 'This e-mail appears more than once in the file.' });
    seen.add(email);
    const ctr = await resolveRowContractor(ctx, s(row.values.contractorCode), p.problems);
    const roleLabel = s(row.values.role);
    if (roleLabel && !roleFromLabel(roleLabel) && !p.problems.some((x) => x.column === 'Role')) p.problems.push({ column: 'Role', reason: 'Unknown role.' });
    let existing = false;
    if (ctr && email) {
      const u = await ctx.db.query<{ contractor_id: string | null; role: string; status: string }>(
        'SELECT contractor_id, role, status FROM app_user WHERE lower(email) = $1',
        [email],
      );
      const found = u.rows[0];
      if (found) {
        if (found.contractor_id !== ctr.id) p.problems.push({ column: 'Email', reason: 'This e-mail belongs to a user of another contractor.' });
        else existing = true;
      }
      if (email === ctx.caller.email.toLowerCase()) {
        const role = roleFromLabel(roleLabel);
        if (role && role !== ctx.caller.role) p.problems.push({ column: 'Role', reason: 'You cannot change your own role.' });
        if (s(row.values.status) === 'Inactive') p.problems.push({ column: 'Status', reason: 'You cannot deactivate your own account.' });
      }
      // Work teams must exist for the contractor.
      const teams = arr(row.values.workTeams);
      if (teams.length) {
        let known = teamCache.get(ctr.id);
        if (!known) {
          const t = await ctx.db.query<{ code: string }>('SELECT code FROM work_team WHERE contractor_id = $1', [ctr.id]);
          known = new Set(t.rows.map((x) => x.code.toLowerCase()));
          teamCache.set(ctr.id, known);
        }
        const unknown = teams.filter((t) => !known!.has(t.toLowerCase()));
        if (unknown.length) {
          p.problems.push({ column: 'Work Teams', reason: `Unknown work team(s) for ${ctr.code}: ${unknown.join(', ')}. Add them under Work teams first.` });
        }
      }
      // Reports to: an existing user of the same contractor or a user in this file for the same contractor.
      const rt = s(row.values.reportsTo);
      if (rt) {
        if (rt === email) p.problems.push({ column: 'Reports To (Email)', reason: 'A user cannot report to themselves.' });
        else if (fileEmails.get(rt) !== ctr.code.toLowerCase()) {
          const m = await ctx.db.query('SELECT 1 FROM app_user WHERE lower(email) = $1 AND contractor_id = $2', [rt, ctr.id]);
          if (!m.rowCount) p.problems.push({ column: 'Reports To (Email)', reason: 'No user with this e-mail in the same contractor (in SONU or in this file).' });
        }
      }
    }
    out.push(finish(p, existing));
  }
  return out;
}

async function classifySubcontractors(ctx: Ctx, rows: BulkRow[]): Promise<PreviewRow[]> {
  const out: PreviewRow[] = [];
  const seen = new Set<string>();
  // Sub-contractor code (lower) → { contractorId, rowNumber, ok }
  const fileSubs = new Map<string, { contractorId: string | undefined; rowNumber: number; ok: boolean }>();
  for (const row of rows.filter((r) => r.sheet === 'SubContractors')) {
    const code = s(row.values.code);
    const p = base(row, code);
    if (code && seen.has(code.toLowerCase())) p.problems.push({ column: 'Sub-contractor Code', reason: 'This code appears more than once in the file.' });
    seen.add(code.toLowerCase());
    const ctr = await resolveRowContractor(ctx, s(row.values.contractorCode), p.problems);
    let existing = false;
    if (ctr && code) {
      const r = await ctx.db.query('SELECT 1 FROM subcontractor WHERE contractor_id = $1 AND lower(code) = lower($2)', [ctr.id, code]);
      existing = !!r.rowCount;
    }
    finish(p, existing);
    fileSubs.set(code.toLowerCase(), { contractorId: ctr?.id, rowNumber: row.rowNumber, ok: p.action !== 'problem' });
    out.push(p);
  }
  const seenContacts = new Set<string>();
  for (const row of rows.filter((r) => r.sheet === 'Contacts')) {
    const subCode = s(row.values.subcontractorCode);
    const mobile = s(row.values.mobile);
    const p = base(row, `${subCode}/${mobile}`);
    const k = `${subCode.toLowerCase()}|${mobile}`;
    if (seenContacts.has(k)) p.problems.push({ column: 'Mobile', reason: 'This contact (same sub-contractor and mobile) appears more than once.' });
    seenContacts.add(k);
    let existing = false;
    const inFile = fileSubs.get(subCode.toLowerCase());
    if (inFile) {
      if (!inFile.ok) p.problems.push({ column: 'Sub-contractor Code', reason: `The sub-contractor row ${inFile.rowNumber} has problems, so this contact is skipped too.` });
      else if (mobile && inFile.contractorId) {
        const r = await ctx.db.query(
          `SELECT 1 FROM sub_contact c JOIN subcontractor s ON s.id = c.subcontractor_id
            WHERE s.contractor_id = $1 AND lower(s.code) = lower($2) AND c.mobile = $3`,
          [inFile.contractorId, subCode, mobile],
        );
        existing = !!r.rowCount;
      }
    } else if (subCode) {
      const params: unknown[] = [subCode];
      let where = 'lower(s.code) = lower($1)';
      if (ctx.caller.contractorId) {
        params.push(ctx.caller.contractorId);
        where += ' AND s.contractor_id = $2';
      }
      const r = await ctx.db.query<{ id: string }>(`SELECT s.id FROM subcontractor s WHERE ${where}`, params);
      if (r.rows.length === 0) p.problems.push({ column: 'Sub-contractor Code', reason: 'Unknown sub-contractor (not on the SubContractors sheet and not in SONU).' });
      else if (r.rows.length > 1) p.problems.push({ column: 'Sub-contractor Code', reason: 'This code exists for several contractors; add the company row to the SubContractors sheet.' });
      else if (mobile) {
        const c = await ctx.db.query('SELECT 1 FROM sub_contact WHERE subcontractor_id = $1 AND mobile = $2', [r.rows[0]!.id, mobile]);
        existing = !!c.rowCount;
      }
    }
    out.push(finish(p, existing));
  }
  return out;
}

// ───────────────────────────── Apply ─────────────────────────────

export interface ApplyResult {
  added: number;
  updated: number;
  rejected: number;
  /** Invitations to e-mail after commit. */
  invitations: { userId: string; token: string }[];
}

export async function applyRows(
  app: FastifyInstance,
  db: Queryable,
  caller: AuthUser,
  kind: BulkKind,
  rows: PreviewRow[],
): Promise<ApplyResult> {
  const res: ApplyResult = { added: 0, updated: 0, rejected: rows.filter((r) => r.action === 'problem').length, invitations: [] };
  const ttlMs = app.config.inviteDays * 24 * 3600_000;
  const good = rows.filter((r) => r.action !== 'problem');

  if (kind === 'contractors') {
    for (const r of good) {
      const v = r.values;
      if (r.action === 'add') {
        const c = await createContractor(
          db,
          {
            code: s(v.code), name: s(v.name), nameAr: s(v.nameAr) || null, marafiqTradeCode: s(v.marafiqTradeCode) || null,
            marafiqWorkTeams: arr(v.marafiqWorkTeams), disciplines: arr(v.disciplines), senderEmail: s(v.senderEmail) || null,
            timeZone: s(v.timeZone) || 'Asia/Qatar', status: s(v.status) === 'Inactive' ? 'inactive' : 'active', notes: s(v.notes) || null,
            admin: { fullName: s(v.adminName), email: s(v.adminEmail), mobile: s(v.adminMobile) || null },
          },
          { createdBy: caller.id, assetsDir: app.config.assetsDir, inviteTtlMs: ttlMs },
        );
        res.invitations.push({ userId: c.adminUserId, token: c.inviteToken });
        res.added++;
      } else {
        const cur = await contractorByCode(db, s(v.code));
        if (!cur) continue;
        await db.query(
          `UPDATE contractor SET name = $2, name_ar = $3, marafiq_trade_code = $4, marafiq_work_teams = $5, disciplines = $6,
                  sender_email = $7, time_zone = $8, status = $9, notes = $10, updated_at = now() WHERE id = $1`,
          [cur.id, s(v.name), s(v.nameAr) || null, s(v.marafiqTradeCode) || null, arr(v.marafiqWorkTeams), arr(v.disciplines),
            s(v.senderEmail) || null, s(v.timeZone) || 'Asia/Qatar', s(v.status) === 'Inactive' ? 'inactive' : 'active', s(v.notes) || null],
        );
        await ensureWorkTeams(db, cur.id, arr(v.marafiqWorkTeams));
        res.updated++;
      }
    }
    return res;
  }

  if (kind === 'users') {
    // Pass 1: create / update users. Pass 2: reports-to (may point at users created in pass 1).
    const ids = new Map<string, { id: string; contractorId: string }>();
    for (const r of good) {
      const v = r.values;
      const ctr = (await contractorByCode(db, s(v.contractorCode)))!;
      const role = roleFromLabel(s(v.role))!;
      const inactive = s(v.status) === 'Inactive';
      const fields = [
        s(v.fullName), s(v.mobile) || null, role, s(v.discipline) || null, s(v.employeeNo) || null, s(v.craftspersonCode) || null,
        s(v.language) || 'English', bool(v.notifyEmail) ?? true, bool(v.notifyPush) ?? true, bool(v.notifyWhatsapp) ?? false,
      ];
      let userId: string;
      if (r.action === 'add') {
        const u = await db.query<{ id: string }>(
          `INSERT INTO app_user (contractor_id, email, full_name, mobile, role, discipline, employee_no, craftsperson_code, language,
                                 notify_email, notify_push, notify_whatsapp, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [ctr.id, s(v.email), ...fields, inactive ? 'inactive' : 'invited'],
        );
        userId = u.rows[0]!.id;
        if (!inactive) res.invitations.push({ userId, token: await createInvitation(db, { userId, contractorId: ctr.id, createdBy: caller.id, ttlMs }) });
        res.added++;
      } else {
        const u = await db.query<{ id: string; role: string; status: string; mobile: string | null }>(
          'SELECT id, role, status, mobile FROM app_user WHERE lower(email) = $1 AND contractor_id = $2',
          [s(v.email), ctr.id],
        );
        const cur = u.rows[0]!;
        userId = cur.id;
        await db.query(
          `UPDATE app_user SET full_name = $2, mobile = $3, role = $4, discipline = $5, employee_no = $6, craftsperson_code = $7,
                  language = $8, notify_email = $9, notify_push = $10, notify_whatsapp = $11,
                  mobile_verified_at = CASE WHEN mobile IS DISTINCT FROM $3 THEN NULL ELSE mobile_verified_at END,
                  status = CASE WHEN $12 THEN 'inactive' WHEN status = 'inactive' THEN (CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END) ELSE status END,
                  updated_at = now()
            WHERE id = $1`,
          [userId, ...fields, inactive],
        );
        if (inactive || cur.role !== role) await endAllSessions(db, userId);
        res.updated++;
      }
      ids.set(s(v.email), { id: userId, contractorId: ctr.id });
      // Work teams: the file states the full list (empty = all teams).
      await db.query('DELETE FROM user_work_team WHERE user_id = $1', [userId]);
      const teams = arr(v.workTeams);
      if (teams.length) {
        await db.query(
          `INSERT INTO user_work_team (contractor_id, user_id, work_team_id)
           SELECT $1, $2, t.id FROM work_team t WHERE t.contractor_id = $1 AND lower(t.code) = ANY($3::text[]) ON CONFLICT DO NOTHING`,
          [ctr.id, userId, teams.map((t) => t.toLowerCase())],
        );
      }
    }
    for (const r of good) {
      const rt = s(r.values.reportsTo);
      const me = ids.get(s(r.values.email))!;
      let managerId: string | null = null;
      if (rt) {
        const m = await db.query<{ id: string }>('SELECT id FROM app_user WHERE lower(email) = $1 AND contractor_id = $2', [rt, me.contractorId]);
        managerId = m.rows[0]?.id ?? null;
      }
      await db.query('UPDATE app_user SET reports_to = $2 WHERE id = $1', [me.id, managerId]);
    }
    return res;
  }

  // subcontractors
  for (const r of good.filter((x) => x.sheet === 'SubContractors')) {
    const v = r.values;
    const ctr = (await contractorByCode(db, s(v.contractorCode)))!;
    const params = [
      ctr.id, s(v.code), s(v.name), s(v.nameAr) || null, s(v.crNumber) || null, arr(v.categories), arr(v.zonesServed), s(v.address) || null,
      s(v.website) || null, s(v.paymentTerms) || null, bool(v.emergencyCallout), s(v.status), s(v.notes) || null,
    ];
    if (r.action === 'add') {
      await db.query(
        `INSERT INTO subcontractor (contractor_id, code, name, name_ar, cr_number, categories, zones_served, address, website, payment_terms,
                                    emergency_callout, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        params,
      );
      res.added++;
    } else {
      await db.query(
        `UPDATE subcontractor SET name = $3, name_ar = $4, cr_number = $5, categories = $6, zones_served = $7, address = $8, website = $9,
                payment_terms = $10, emergency_callout = $11, status = $12, notes = $13, updated_at = now()
          WHERE contractor_id = $1 AND lower(code) = lower($2)`,
        params,
      );
      res.updated++;
    }
  }
  for (const r of good.filter((x) => x.sheet === 'Contacts')) {
    const v = r.values;
    const where = caller.contractorId ? 'AND contractor_id = $2' : '';
    const sub = await db.query<{ id: string; contractor_id: string }>(
      `SELECT id, contractor_id FROM subcontractor WHERE lower(code) = lower($1) ${where}`,
      caller.contractorId ? [s(v.subcontractorCode), caller.contractorId] : [s(v.subcontractorCode)],
    );
    const sc = sub.rows[0];
    if (!sc) continue;
    const params = [
      sc.contractor_id, sc.id, s(v.name), s(v.role) || null, s(v.mobile), s(v.whatsapp) || null, s(v.email) || null, s(v.preferredChannel) || null,
      s(v.language) || null, bool(v.receivesEnquiries), bool(v.receivesUrgent), typeof v.escalationOrder === 'number' ? v.escalationOrder : null,
      bool(v.consent) ?? false,
    ];
    const ins = await db.query<{ inserted: boolean }>(
      `INSERT INTO sub_contact (contractor_id, subcontractor_id, name, role, mobile, whatsapp, email, preferred_channel, language,
                                receives_enquiries, receives_urgent, escalation_order, consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (subcontractor_id, mobile) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, whatsapp = EXCLUDED.whatsapp,
         email = EXCLUDED.email, preferred_channel = EXCLUDED.preferred_channel, language = EXCLUDED.language,
         receives_enquiries = EXCLUDED.receives_enquiries, receives_urgent = EXCLUDED.receives_urgent,
         escalation_order = EXCLUDED.escalation_order, consent = EXCLUDED.consent, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      params,
    );
    if (ins.rows[0]?.inserted) res.added++;
    else res.updated++;
  }
  return res;
}

// ───────────────────────────── Rejected rows file ─────────────────────────────

export async function rejectedWorkbook(kind: BulkKind, rows: PreviewRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SONU';
  for (const spec of TEMPLATE_SPECS[kind]) {
    const ws = wb.addWorksheet(spec.sheet);
    const captions = spec.columns.map((c) => (c.required ? `${c.caption}*` : c.caption));
    ws.addRow([...captions, 'Problems (delete this column before uploading again)', 'Row in uploaded file']);
    ws.getRow(1).font = { bold: true };
    for (const r of rows.filter((x) => x.action === 'problem' && x.sheet === spec.sheet)) {
      ws.addRow([
        ...spec.columns.map((c) => r.raw[c.caption] ?? ''),
        r.problems.map((p) => `${p.column}: ${p.reason}`).join(' | '),
        r.rowNumber,
      ]);
    }
    ws.columns.forEach((col) => {
      col.width = 22;
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
