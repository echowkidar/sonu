/**
 * Data every new contractor starts with: deadline rules (design 11 §3), tracker lookups
 * (assets/tracker-lookups.json), messaging settings and an "off" Marafiq connection row.
 * All of it is editable afterwards.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Queryable } from '../db.js';

export interface DeadlineRuleSeed {
  key: string;
  name: string;
  appliesTo: string;
  criteria?: number[] | null;
  stage?: string | null;
  clockStart?: string;
  limitValue: number | null;
  limitUnit: 'hours' | 'days' | 'working_days' | 'same_day' | 'date_field';
  limitField?: string | null;
  warnings: Record<string, unknown>[];
  onBreach: string;
  escalationRoles: string[];
  params?: Record<string, unknown>;
}

/**
 * Starting values from the contractor's procedure (design 11 §3, confirmed 2026-11-16):
 * the RFE limit is 14 days from Date Trade Assigned.
 */
export const DEFAULT_DEADLINE_RULES: DeadlineRuleSeed[] = [
  { key: 'take_ownership', name: 'Take ownership', appliesTo: 'Every new WR', limitValue: 1, limitUnit: 'working_days', warnings: [{ value: 4, unit: 'hours' }], onBreach: 'Coordinator told', escalationRoles: ['coordinator'] },
  { key: 'inspect_issue_c1', name: 'Site inspection and issue', appliesTo: 'Criterion 1 (zero cost)', criteria: [1], limitValue: 3, limitUnit: 'days', warnings: [{ value: 2, unit: 'days' }], onBreach: 'Supervisor, then project manager', escalationRoles: ['supervisor', 'manager'] },
  { key: 'inspect_issue_c2_low', name: 'Site inspection and issue', appliesTo: 'Criterion 2 below QR 100', criteria: [2], limitValue: 7, limitUnit: 'days', warnings: [{ value: 5, unit: 'days' }], onBreach: 'Supervisor, then project manager', escalationRoles: ['supervisor', 'manager'], params: { maxCost: 100, currency: 'QAR' } },
  { key: 'rfe_submit_14d', name: 'Estimate (RFE) submitted in Marafiq', appliesTo: 'Criterion 2 above QR 100, criterion 3', criteria: [2, 3], limitValue: 14, limitUnit: 'days', warnings: [{ value: 8, unit: 'days' }, { value: 11, unit: 'days' }], onBreach: 'Project manager', escalationRoles: ['manager'], params: { minCost: 100, currency: 'QAR' } },
  { key: 'submittal_approval', name: "Supplier's drawing / artwork / sample approved by QF", appliesTo: 'Orders that need a submittal', limitValue: 5, limitUnit: 'working_days', warnings: [{ every: 3, unit: 'days', note: 'reminder to the QF engineer (manual send)' }], onBreach: 'Project manager', escalationRoles: ['manager'] },
  { key: 'access_granted', name: 'Access granted by QF', appliesTo: 'Jobs waiting for access', limitValue: 3, limitUnit: 'working_days', warnings: [{ every: 2, unit: 'days' }], onBreach: 'Project manager; raise a target-date extension request', escalationRoles: ['manager'] },
  { key: 'rfe_submit_c4', name: 'Estimate submitted in Marafiq (new requirement)', appliesTo: 'Criterion 4 (new requirement)', criteria: [4], limitValue: 20, limitUnit: 'days', warnings: [{ value: 14, unit: 'days' }, { value: 17, unit: 'days' }], onBreach: 'Project manager', escalationRoles: ['manager'] },
  { key: 'quotations_received', name: 'Quotations received', appliesTo: 'Every MR', clockStart: 'mr_raised', limitValue: 7, limitUnit: 'days', warnings: [{ every: 3, unit: 'days' }], onBreach: 'Day 8: escalate to project manager', escalationRoles: ['manager'], params: { requiredQuotations: 3 } },
  { key: 'answer_rfe_comment', name: 'Answer a QF RFE comment', appliesTo: 'Every pending comment', clockStart: 'comment_created', limitValue: 2, limitUnit: 'working_days', warnings: [{ every: 1, unit: 'days' }], onBreach: "Supervisor's manager", escalationRoles: ['reports_to'] },
  { key: 'resubmit_returned', name: 'Re-submit a returned estimate', appliesTo: 'Stage 4', stage: '4', clockStart: 'stage_entered', limitValue: 5, limitUnit: 'days', warnings: [{ value: 3, unit: 'days' }], onBreach: 'Project manager', escalationRoles: ['manager'] },
  { key: 'lpo_after_approval', name: 'LPO after approval', appliesTo: 'Approved RFE', clockStart: 'rfe_approved', limitValue: 2, limitUnit: 'working_days', warnings: [{ every: 1, unit: 'days' }], onBreach: 'Project manager', escalationRoles: ['manager'] },
  { key: 'supplier_delivery', name: 'Supplier delivery', appliesTo: 'Every LPO', clockStart: 'lpo_issued', limitValue: null, limitUnit: 'date_field', limitField: 'lpo.promised_date', warnings: [{ every: 3, unit: 'days' }], onBreach: 'Purchasing, then project manager', escalationRoles: ['purchasing', 'manager'] },
  { key: 'permit_expiry', name: 'Permit expiry', appliesTo: 'Issued permits', clockStart: 'permit_issued', limitValue: null, limitUnit: 'date_field', limitField: 'permit.date_upto', warnings: [{ value: -2, unit: 'days', note: 'same as Marafiq orange' }, { value: 0, unit: 'days' }], onBreach: 'Applicant, supervisor', escalationRoles: ['supervisor'] },
  { key: 'closeout_after_completion', name: 'Close-out after field completion', appliesTo: 'Verified jobs', clockStart: 'field_verified', limitValue: 2, limitUnit: 'working_days', warnings: [{ every: 1, unit: 'days' }], onBreach: 'Supervisor', escalationRoles: ['supervisor'] },
  { key: 'permit_closure', name: 'Close the permit (applicant closure)', appliesTo: 'Contractor-completed WRs whose permit is still open', clockStart: 'contractor_completed', limitValue: 0, limitUnit: 'same_day', warnings: [{ value: 1, unit: 'days', note: 'next morning' }], onBreach: 'Supervisor — QF cannot close the WR until the permit is closed', escalationRoles: ['supervisor'] },
  { key: 'fix_returned_closeout', name: 'Fix a returned close-out', appliesTo: 'Stage 7', stage: '7', clockStart: 'stage_entered', limitValue: 3, limitUnit: 'days', warnings: [{ every: 1, unit: 'days' }], onBreach: 'Project manager', escalationRoles: ['manager'] },
];

export async function seedDeadlineRules(db: Queryable, contractorId: string): Promise<number> {
  let i = 0;
  for (const r of DEFAULT_DEADLINE_RULES) {
    i++;
    await db.query(
      `INSERT INTO deadline_rule (contractor_id, key, name, applies_to, criteria, stage, clock_start, limit_value, limit_unit,
                                  limit_field, warnings, on_breach, escalation_roles, params, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (contractor_id, key) DO NOTHING`,
      [
        contractorId, r.key, r.name, r.appliesTo, r.criteria ?? null, r.stage ?? null, r.clockStart ?? 'date_trade_assigned',
        r.limitValue, r.limitUnit, r.limitField ?? null, JSON.stringify(r.warnings), r.onBreach, r.escalationRoles,
        JSON.stringify(r.params ?? {}), i * 10,
      ],
    );
  }
  return DEFAULT_DEADLINE_RULES.length;
}

interface TrackerLookups {
  site_to_facility_zone?: Record<string, { site_name?: string; zone?: string; facility?: string; group?: string }>;
  problem_type_to_discipline?: Record<string, string>;
}

let cachedLookups: TrackerLookups | null = null;

export async function readTrackerLookups(assetsDir: string): Promise<TrackerLookups> {
  if (cachedLookups) return cachedLookups;
  try {
    cachedLookups = JSON.parse(await fs.readFile(path.join(assetsDir, 'tracker-lookups.json'), 'utf8')) as TrackerLookups;
  } catch {
    cachedLookups = {};
  }
  return cachedLookups;
}

export async function seedLookups(db: Queryable, contractorId: string, assetsDir: string): Promise<{ sites: number; problemTypes: number }> {
  const l = await readTrackerLookups(assetsDir);
  const sites = Object.entries(l.site_to_facility_zone ?? {});
  for (const [code, s] of sites) {
    await db.query(
      `INSERT INTO site_lookup (contractor_id, site_code, site_name, zone, facility, group_name)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contractor_id, site_code) DO NOTHING`,
      [contractorId, code, s.site_name || null, s.zone || null, s.facility || null, s.group || null],
    );
  }
  const pts = Object.entries(l.problem_type_to_discipline ?? {});
  for (const [pt, d] of pts) {
    await db.query(
      `INSERT INTO problem_type_lookup (contractor_id, problem_type, discipline) VALUES ($1,$2,$3)
       ON CONFLICT (contractor_id, problem_type) DO NOTHING`,
      [contractorId, pt, d],
    );
  }
  return { sites: sites.length, problemTypes: pts.length };
}

/** Everything a fresh contractor needs besides its admin user. */
export async function seedContractor(db: Queryable, contractorId: string, assetsDir: string, workTeams: string[]): Promise<void> {
  await seedDeadlineRules(db, contractorId);
  await seedLookups(db, contractorId, assetsDir);
  await db.query('INSERT INTO messaging_settings (contractor_id) VALUES ($1) ON CONFLICT DO NOTHING', [contractorId]);
  await db.query(
    `INSERT INTO marafiq_connection (contractor_id, name) VALUES ($1, 'Main') ON CONFLICT DO NOTHING`,
    [contractorId],
  );
  await ensureWorkTeams(db, contractorId, workTeams);
}

export async function ensureWorkTeams(db: Queryable, contractorId: string, codes: string[]): Promise<void> {
  for (const code of codes) {
    if (!code.trim()) continue;
    await db.query(
      `INSERT INTO work_team (contractor_id, code) VALUES ($1, $2) ON CONFLICT (contractor_id, lower(code)) DO NOTHING`,
      [contractorId, code.trim()],
    );
  }
}
