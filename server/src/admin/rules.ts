import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, recordScope, requireAuth, requireRole } from '../auth/guards.js';
import { withTx } from '../db.js';
import { notFound } from '../errors.js';

const idParam = z.object({ id: z.string().uuid() });
const scopeQuery = z.object({ contractorId: z.string().uuid().optional() });

interface RuleRow {
  id: string; contractor_id: string; key: string; name: string; applies_to: string; criteria: number[] | null; stage: string | null;
  clock_start: string; limit_value: number | null; limit_unit: string; limit_field: string | null; warnings: unknown; on_breach: string;
  escalation_roles: string[]; params: unknown; active: boolean; sort_order: number; updated_at: Date;
}

const ruleView = (r: RuleRow) => ({
  id: r.id, contractorId: r.contractor_id, key: r.key, name: r.name, appliesTo: r.applies_to, criteria: r.criteria, stage: r.stage,
  clockStart: r.clock_start, limitValue: r.limit_value, limitUnit: r.limit_unit, limitField: r.limit_field, warnings: r.warnings,
  onBreach: r.on_breach, escalationRoles: r.escalation_roles, params: r.params, active: r.active, sortOrder: r.sort_order, updatedAt: r.updated_at,
});

const ruleUpdate = z
  .object({
    name: z.string().trim().min(2).max(200),
    appliesTo: z.string().trim().min(1).max(300),
    criteria: z.array(z.number().int().min(1).max(4)).max(4).nullable(),
    stage: z.string().trim().max(40).nullable(),
    clockStart: z.string().trim().min(1).max(60),
    limitValue: z.number().int().min(0).max(3650).nullable(),
    limitUnit: z.enum(['hours', 'days', 'working_days', 'same_day', 'date_field']),
    limitField: z.string().trim().max(80).nullable(),
    warnings: z.array(z.record(z.string(), z.unknown())).max(20),
    onBreach: z.string().trim().min(1).max(300),
    escalationRoles: z.array(z.string().trim().min(1).max(40)).max(10),
    params: z.record(z.string(), z.unknown()),
    active: z.boolean(),
  })
  .partial()
  .strict();

const RULE_COLS: Record<string, string> = {
  name: 'name', appliesTo: 'applies_to', criteria: 'criteria', stage: 'stage', clockStart: 'clock_start', limitValue: 'limit_value',
  limitUnit: 'limit_unit', limitField: 'limit_field', warnings: 'warnings', onBreach: 'on_breach', escalationRoles: 'escalation_roles',
  params: 'params', active: 'active',
};

const siteItem = z.object({
  siteCode: z.string().trim().min(1).max(40),
  siteName: z.string().trim().max(200).nullish(),
  zone: z.string().trim().max(60).nullish(),
  facility: z.string().trim().max(200).nullish(),
  groupName: z.string().trim().max(60).nullish(),
});
const problemItem = z.object({ problemType: z.string().trim().min(1).max(60), discipline: z.string().trim().min(1).max(60) });

export default async function ruleRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };
  const lookupEditors = { preHandler: requireRole('platform_admin', 'contractor_admin', 'coordinator') };

  // ───── Deadline rules ─────
  app.get('/api/admin/deadline-rules', { preHandler: requireAuth }, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId);
    const r = await app.db.query<RuleRow>('SELECT * FROM deadline_rule WHERE contractor_id = $1 ORDER BY sort_order, key', [contractorId]);
    return { items: r.rows.map(ruleView) };
  });

  app.patch('/api/admin/deadline-rules/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = ruleUpdate.parse(request.body);
    const owner = await app.db.query<{ contractor_id: string }>('SELECT contractor_id FROM deadline_rule WHERE id = $1', [id]);
    const contractorId = recordScope(request, owner.rows[0]?.contractor_id, 'Deadline rule');
    const sets: string[] = [];
    const params: unknown[] = [id, contractorId, request.auth!.user.id];
    for (const [k, v] of Object.entries(body)) {
      const col = RULE_COLS[k];
      if (!col || v === undefined) continue;
      params.push(k === 'warnings' || k === 'params' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) {
      const r = await app.db.query(
        `UPDATE deadline_rule SET ${sets.join(', ')}, updated_by = $3, updated_at = now() WHERE id = $1 AND contractor_id = $2`,
        params,
      );
      if (!r.rowCount) throw notFound('Deadline rule not found.');
      await auditFromRequest(request, { contractorId, action: 'deadline_rule.update', entityType: 'deadline_rule', entityId: id, details: { changes: body } });
    }
    const r = await app.db.query<RuleRow>('SELECT * FROM deadline_rule WHERE id = $1', [id]);
    return ruleView(r.rows[0]!);
  });

  // ───── Lookups ─────
  app.get('/api/admin/lookups/sites', { preHandler: requireAuth }, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId);
    const r = await app.db.query(
      `SELECT site_code AS "siteCode", site_name AS "siteName", zone, facility, group_name AS "groupName"
         FROM site_lookup WHERE contractor_id = $1 ORDER BY site_code`,
      [contractorId],
    );
    return { items: r.rows };
  });

  /** Replaces the whole site list (the UI edits the table and saves it). */
  app.put('/api/admin/lookups/sites', lookupEditors, async (request) => {
    const body = z.object({ contractorId: z.string().uuid().optional(), items: z.array(siteItem).max(5000) }).strict().parse(request.body);
    const contractorId = adminScope(request, body.contractorId)!;
    await withTx(app.db, async (c) => {
      await c.query('DELETE FROM site_lookup WHERE contractor_id = $1', [contractorId]);
      for (const s of body.items) {
        await c.query(
          `INSERT INTO site_lookup (contractor_id, site_code, site_name, zone, facility, group_name) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (contractor_id, site_code) DO UPDATE SET site_name = EXCLUDED.site_name, zone = EXCLUDED.zone,
             facility = EXCLUDED.facility, group_name = EXCLUDED.group_name, updated_at = now()`,
          [contractorId, s.siteCode, s.siteName ?? null, s.zone ?? null, s.facility ?? null, s.groupName ?? null],
        );
      }
      await auditFromRequest(request, { contractorId, action: 'lookup.sites_update', entityType: 'site_lookup', details: { count: body.items.length } }, c);
    });
    return { ok: true, count: body.items.length };
  });

  app.get('/api/admin/lookups/problem-types', { preHandler: requireAuth }, async (request) => {
    const contractorId = adminScope(request, scopeQuery.parse(request.query).contractorId);
    const r = await app.db.query(
      `SELECT problem_type AS "problemType", discipline FROM problem_type_lookup WHERE contractor_id = $1 ORDER BY problem_type`,
      [contractorId],
    );
    return { items: r.rows };
  });

  app.put('/api/admin/lookups/problem-types', lookupEditors, async (request) => {
    const body = z.object({ contractorId: z.string().uuid().optional(), items: z.array(problemItem).max(2000) }).strict().parse(request.body);
    const contractorId = adminScope(request, body.contractorId)!;
    await withTx(app.db, async (c) => {
      await c.query('DELETE FROM problem_type_lookup WHERE contractor_id = $1', [contractorId]);
      for (const p of body.items) {
        await c.query(
          `INSERT INTO problem_type_lookup (contractor_id, problem_type, discipline) VALUES ($1,$2,$3)
           ON CONFLICT (contractor_id, problem_type) DO UPDATE SET discipline = EXCLUDED.discipline, updated_at = now()`,
          [contractorId, p.problemType, p.discipline],
        );
      }
      await auditFromRequest(request, { contractorId, action: 'lookup.problem_types_update', entityType: 'problem_type_lookup', details: { count: body.items.length } }, c);
    });
    return { ok: true, count: body.items.length };
  });
}
