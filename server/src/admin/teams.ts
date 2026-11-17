import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { adminScope, recordScope, requireAuth, requireRole } from '../auth/guards.js';
import { conflict, notFound } from '../errors.js';

const idParam = z.object({ id: z.string().uuid() });
const teamFields = {
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().max(120).nullish(),
  zone: z.string().trim().max(60).nullish(),
  active: z.boolean().optional(),
};

interface TeamRow { id: string; contractor_id: string; code: string; name: string | null; zone: string | null; active: boolean; member_count: number }
const view = (r: TeamRow) => ({ id: r.id, contractorId: r.contractor_id, code: r.code, name: r.name, zone: r.zone, active: r.active, memberCount: r.member_count });
const SELECT = `SELECT t.*, (SELECT count(*)::int FROM user_work_team ut WHERE ut.work_team_id = t.id) AS member_count FROM work_team t`;

export default async function teamRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };

  app.get('/api/admin/work-teams', { preHandler: requireAuth }, async (request) => {
    const q = z.object({ contractorId: z.string().uuid().optional() }).parse(request.query);
    const contractorId = adminScope(request, q.contractorId);
    const r = await app.db.query<TeamRow>(`${SELECT} WHERE t.contractor_id = $1 ORDER BY t.code`, [contractorId]);
    return { items: r.rows.map(view) };
  });

  app.post('/api/admin/work-teams', admins, async (request, reply) => {
    const body = z.object({ ...teamFields, contractorId: z.string().uuid().optional() }).strict().parse(request.body);
    const contractorId = adminScope(request, body.contractorId);
    const dup = await app.db.query('SELECT 1 FROM work_team WHERE contractor_id = $1 AND lower(code) = lower($2)', [contractorId, body.code]);
    if (dup.rowCount) throw conflict(`Work team ${body.code} already exists.`);
    const r = await app.db.query<{ id: string }>(
      'INSERT INTO work_team (contractor_id, code, name, zone, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [contractorId, body.code, body.name ?? null, body.zone ?? null, body.active ?? true],
    );
    const id = r.rows[0]!.id;
    await auditFromRequest(request, { contractorId, action: 'work_team.create', entityType: 'work_team', entityId: id, summary: body.code });
    const row = await app.db.query<TeamRow>(`${SELECT} WHERE t.id = $1`, [id]);
    return reply.status(201).send(view(row.rows[0]!));
  });

  app.patch('/api/admin/work-teams/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object(teamFields).partial().strict().parse(request.body);
    const contractorId = await teamScopeFor(app, request, id);
    const r = await app.db.query(
      `UPDATE work_team SET code = COALESCE($3, code), name = CASE WHEN $4::boolean THEN $5 ELSE name END,
              zone = CASE WHEN $6::boolean THEN $7 ELSE zone END, active = COALESCE($8, active), updated_at = now()
        WHERE id = $1 AND contractor_id = $2`,
      [id, contractorId, body.code ?? null, body.name !== undefined, body.name ?? null, body.zone !== undefined, body.zone ?? null, body.active ?? null],
    );
    if (!r.rowCount) throw notFound('Work team not found.');
    await auditFromRequest(request, { contractorId, action: 'work_team.update', entityType: 'work_team', entityId: id, details: { fields: Object.keys(body) } });
    const row = await app.db.query<TeamRow>(`${SELECT} WHERE t.id = $1`, [id]);
    return view(row.rows[0]!);
  });

  app.delete('/api/admin/work-teams/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const contractorId = await teamScopeFor(app, request, id);
    const r = await app.db.query<{ code: string }>('DELETE FROM work_team WHERE id = $1 AND contractor_id = $2 RETURNING code', [id, contractorId]);
    if (!r.rowCount) throw notFound('Work team not found.');
    await auditFromRequest(request, { contractorId, action: 'work_team.delete', entityType: 'work_team', entityId: id, summary: r.rows[0]!.code });
    return { ok: true };
  });
}

async function teamScopeFor(app: FastifyInstance, request: FastifyRequest, id: string): Promise<string> {
  const r = await app.db.query<{ contractor_id: string }>('SELECT contractor_id FROM work_team WHERE id = $1', [id]);
  return recordScope(request, r.rows[0]?.contractor_id, 'Work team');
}
