/**
 * Demo data for presentations (run once, inside the app container):
 *   DEMO_PASSWORD='...' node server/dist/demo/seed.js
 *
 * - Adds one demo user per role to the contractor (DEMO_CONTRACTOR, default: "test" or the only contractor),
 *   all with the password from DEMO_PASSWORD (never stored in the repo, never printed).
 * - Loads the synthetic sample exports from /app/fixtures (fictional WRs, "Test Site ...").
 * - Hands a few WRs to technicians so the field view has jobs.
 * Safe to re-run: existing users are kept, imports of identical files are no-ops.
 * Demo users have e-mail notifications switched off (their addresses are fictional).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { loadConfig } from '../config.js';
import { ensureWorkTeams } from '../contractors/seed.js';
import { runImport } from '../ops/imports.js';
import { setUserWorkTeams } from '../users/service.js';

const FILES = ['pending-work-requests.xlsx', 'review-approved-estimations.xlsx', 'wr-dashboard.xlsx', 'pending-rfe-status.xlsx', 'manage-permit-to-work.xlsx'];
const TEAMS = ['TEST-WT-1', 'TEST-WT-2', 'TEST-WT-3'];
const DOMAIN = 'demo.sonu.example';

interface DemoUser { key: string; name: string; role: string; teams: string[]; reportsTo?: string; discipline?: string; mobile: string }
const USERS: DemoUser[] = [
  { key: 'manager', name: 'Demo Manager', role: 'manager', teams: [], mobile: '+97455500001' },
  { key: 'coordinator', name: 'Demo Coordinator', role: 'coordinator', teams: [], reportsTo: 'manager', mobile: '+97455500002' },
  { key: 'purchasing', name: 'Demo Purchasing', role: 'purchasing', teams: [], reportsTo: 'manager', mobile: '+97455500003' },
  { key: 'supervisor1', name: 'Demo Supervisor One', role: 'supervisor', teams: ['TEST-WT-1', 'TEST-WT-2'], reportsTo: 'manager', discipline: 'HVAC', mobile: '+97455500004' },
  { key: 'supervisor2', name: 'Demo Supervisor Two', role: 'supervisor', teams: ['TEST-WT-3'], reportsTo: 'manager', discipline: 'Electrical', mobile: '+97455500005' },
  { key: 'foreman1', name: 'Demo Foreman One', role: 'foreman', teams: ['TEST-WT-1', 'TEST-WT-2'], reportsTo: 'supervisor1', discipline: 'HVAC', mobile: '+97455500006' },
  { key: 'foreman2', name: 'Demo Foreman Two', role: 'foreman', teams: ['TEST-WT-3'], reportsTo: 'supervisor2', discipline: 'Electrical', mobile: '+97455500007' },
  { key: 'tech1', name: 'Demo Technician One', role: 'technician', teams: ['TEST-WT-1'], reportsTo: 'foreman1', discipline: 'HVAC', mobile: '+97455500008' },
  { key: 'tech2', name: 'Demo Technician Two', role: 'technician', teams: ['TEST-WT-2'], reportsTo: 'foreman1', discipline: 'HVAC', mobile: '+97455500009' },
  { key: 'tech3', name: 'Demo Technician Three', role: 'technician', teams: ['TEST-WT-3'], reportsTo: 'foreman2', discipline: 'Electrical', mobile: '+97455500010' },
];

async function main() {
  const password = process.env.DEMO_PASSWORD ?? '';
  if (password.length < 10) throw new Error('Set DEMO_PASSWORD (at least 10 characters).');
  const fixtures = process.env.DEMO_FIXTURES ?? '/app/fixtures';
  const config = loadConfig(process.env);
  const app = await buildApp({ config, logger: false });
  const db = app.db;
  try {
    const wanted = process.env.DEMO_CONTRACTOR?.trim().toLowerCase();
    const cs = (await db.query<{ id: string; code: string }>('SELECT id, code FROM contractor ORDER BY created_at')).rows;
    const c = wanted
      ? cs.find((r) => r.code.toLowerCase() === wanted)
      : cs.find((r) => r.code.toLowerCase() === 'test') ?? (cs.length === 1 ? cs[0] : undefined);
    if (!c) throw new Error(`Contractor not found. Set DEMO_CONTRACTOR to one of: ${cs.map((r) => r.code).join(', ') || '(none)'}`);
    console.log(`Contractor: ${c.code}`);

    await ensureWorkTeams(db, c.id, TEAMS);
    await db.query(
      'UPDATE contractor SET marafiq_work_teams = (SELECT array_agg(DISTINCT x) FROM unnest(marafiq_work_teams || $2::text[]) x) WHERE id = $1',
      [c.id, TEAMS],
    );
    const teamRows = (await db.query<{ id: string; code: string }>('SELECT id, code FROM work_team WHERE contractor_id = $1', [c.id])).rows;
    const teamId = new Map(teamRows.map((r) => [r.code, r.id]));

    for (const f of FILES) {
      const buf = await fs.readFile(path.join(fixtures, f)).catch(() => null);
      if (!buf) { console.log(`  skip ${f} (not found in ${fixtures})`); continue; }
      const r = await runImport(app, { contractorId: c.id, buffer: buf, fileName: f });
      console.log(`  import ${f}: ${r.ok ? `ok (${r.rowsRead} rows, ${r.new ?? 0} new)` : `refused: ${r.error?.message}`}`);
    }

    const hash = await hashPassword(password);
    const ids = new Map<string, string>();
    for (const u of USERS) {
      const email = `${u.key}@${DOMAIN}`;
      const ex = await db.query<{ id: string }>('SELECT id FROM app_user WHERE lower(email) = $1', [email]);
      let id = ex.rows[0]?.id;
      if (!id) {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO app_user (contractor_id, email, full_name, password_hash, role, status, email_verified_at, mobile, discipline, notify_email, notify_push, notify_whatsapp)
           VALUES ($1,$2,$3,$4,$5,'active',now(),$6,$7,false,true,false) RETURNING id`,
          [c.id, email, u.name, hash, u.role, u.mobile, u.discipline ?? null],
        );
        id = ins.rows[0]!.id;
        console.log(`  user ${email} (${u.role}) created`);
      } else console.log(`  user ${email} exists`);
      ids.set(u.key, id);
      await setUserWorkTeams(db, c.id, id, u.teams.map((t) => teamId.get(t)).filter((x): x is string => !!x));
    }
    for (const u of USERS) {
      if (u.reportsTo) await db.query('UPDATE app_user SET reports_to = $2 WHERE id = $1', [ids.get(u.key), ids.get(u.reportsTo)]);
    }

    // A few jobs per technician, from open WRs of their team (only when none exist yet).
    const have = await db.query('SELECT 1 FROM assignment WHERE contractor_id = $1 LIMIT 1', [c.id]);
    if (!have.rowCount) {
      const plan: [string, string][] = [['tech1', 'TEST-WT-1'], ['tech2', 'TEST-WT-2'], ['tech3', 'TEST-WT-3']];
      for (const [tech, team] of plan) {
        const wrs = await db.query<{ id: string }>(
          'SELECT id FROM work_request WHERE contractor_id = $1 AND work_team_code = $2 AND gone_at IS NULL ORDER BY wr_code LIMIT 4',
          [c.id, team],
        );
        let i = 0;
        for (const w of wrs.rows) {
          const status = i === 0 ? 'done' : i === 1 ? 'started' : 'assigned';
          await db.query(
            `INSERT INTO assignment (contractor_id, work_request_id, assignee_id, assigned_by, status, planned_date, hours_planned, note, started_at, done_at)
             VALUES ($1,$2,$3,$4,$5, current_date + $6::int, 4, 'Demo job',
                     CASE WHEN $5 <> 'assigned' THEN now() - interval '1 day' END, CASE WHEN $5 = 'done' THEN now() END)`,
            [c.id, w.id, ids.get(tech), ids.get('supervisor1'), status, i],
          );
          await db.query(
            `INSERT INTO wr_internal (contractor_id, work_request_id, owner_id) VALUES ($1,$2,$3)
             ON CONFLICT (work_request_id) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
            [c.id, w.id, ids.get(tech)],
          );
          i++;
        }
      }
      console.log('  demo jobs assigned to technicians');
    }
    console.log(`Done. Sign in as manager@${DOMAIN} (or any demo user) with the DEMO_PASSWORD you set.`);
  } finally {
    await app.close();
  }
}

main().catch((e) => { console.error(`[demo-seed] ${(e as Error).message}`); process.exit(1); });
