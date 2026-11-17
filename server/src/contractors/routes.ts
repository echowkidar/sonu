import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { currentUser, requireRole, requireTenant } from '../auth/guards.js';
import { sendInvitationEmail } from '../auth/invitations.js';
import { endAllSessions } from '../auth/session.js';
import { withTx } from '../db.js';
import {
  contractorCreateSchema,
  contractorUpdateSchema,
  createContractor,
  getContractor,
  listContractors,
  updateContractor,
} from './service.js';

const idParam = z.object({ id: z.string().uuid() });

export default async function contractorRoutes(app: FastifyInstance): Promise<void> {
  const platformOnly = { preHandler: requireRole('platform_admin') };

  app.get('/api/admin/contractors', platformOnly, async () => ({ items: await listContractors(app.db) }));

  app.get('/api/admin/contractors/:id', platformOnly, async (request) => {
    const { id } = idParam.parse(request.params);
    return getContractor(app.db, id);
  });

  app.post('/api/admin/contractors', platformOnly, async (request, reply) => {
    const body = contractorCreateSchema.parse(request.body);
    const user = currentUser(request);
    const created = await withTx(app.db, async (c) => {
      const res = await createContractor(c, body, {
        createdBy: user.id,
        assetsDir: app.config.assetsDir,
        inviteTtlMs: app.config.inviteDays * 24 * 3600_000,
      });
      await auditFromRequest(
        request,
        {
          contractorId: res.contractorId,
          action: 'contractor.create',
          entityType: 'contractor',
          entityId: res.contractorId,
          summary: `Contractor ${body.code} created with admin ${body.admin.email}`,
        },
        c,
      );
      return res;
    });
    let mail: { driver: string } | { error: string };
    try {
      mail = await sendInvitationEmail(app, { userId: created.adminUserId, token: created.inviteToken });
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'invitation e-mail failed');
      mail = { error: 'The invitation e-mail could not be sent. Use "Resend invitation" after fixing the e-mail settings.' };
    }
    return reply.status(201).send({ contractor: await getContractor(app.db, created.contractorId), adminUserId: created.adminUserId, invitation: mail });
  });

  app.patch('/api/admin/contractors/:id', platformOnly, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = contractorUpdateSchema.parse(request.body);
    await withTx(app.db, async (c) => {
      await updateContractor(c, id, body);
      if (body.status === 'inactive') {
        const users = await c.query<{ id: string }>('SELECT id FROM app_user WHERE contractor_id = $1', [id]);
        for (const u of users.rows) await endAllSessions(c, u.id);
      }
      await auditFromRequest(request, { contractorId: id, action: 'contractor.update', entityType: 'contractor', entityId: id, details: { fields: Object.keys(body) } }, c);
    });
    return getContractor(app.db, id);
  });

  /** "Delete" = deactivate: work data and history are kept; users can no longer sign in. */
  app.delete('/api/admin/contractors/:id', platformOnly, async (request) => {
    const { id } = idParam.parse(request.params);
    await withTx(app.db, async (c) => {
      await updateContractor(c, id, { status: 'inactive' });
      const users = await c.query<{ id: string }>('SELECT id FROM app_user WHERE contractor_id = $1', [id]);
      for (const u of users.rows) await endAllSessions(c, u.id);
      await auditFromRequest(request, { contractorId: id, action: 'contractor.deactivate', entityType: 'contractor', entityId: id }, c);
    });
    return getContractor(app.db, id);
  });

  // Own company record for contractor users.
  app.get('/api/contractor', { preHandler: requireRole('contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman', 'technician') }, async (request) => {
    return getContractor(app.db, requireTenant(request));
  });
}
