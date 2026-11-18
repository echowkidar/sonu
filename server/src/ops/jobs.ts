/** Routes: field staff — assignments, my jobs / team jobs, start / update (photos) / done, attachment download. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { requireRole } from '../auth/guards.js';
import { CONTRACTOR_ROLES } from '../auth/roles.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notifications/index.js';
import { inTeams, scopeOf, todayFor, type Scope } from './context.js';
import { canViewMrFile } from './material.js';
import { loadWrs } from './workRequests.js';

const ALL_SEEING = ['coordinator', 'manager', 'contractor_admin'];
export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Image type from magic bytes (never from the client's name or header). */
export function imageType(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

interface JobRow {
  id: string;
  contractor_id: string;
  work_request_id: string;
  assignee_id: string;
  assigned_by: string | null;
  status: 'assigned' | 'started' | 'done';
  planned_date: string | null;
  note: string | null;
  started_at: Date | null;
  done_at: Date | null;
  created_at: Date;
  assignee_name: string;
  assigned_by_name: string | null;
  wr_code: string;
  work_team_code: string | null;
  owner_id: string | null;
  site_name: string | null;
  building_code: string | null;
  building_name: string | null;
  floor_code: string | null;
  room_code: string | null;
  description: string | null;
  problem_type: string | null;
  priority: string | null;
  ptw_code: string | null;
  ptw_status: string | null;
  permit_status: string | null;
  permit_upto: string | null;
}

const JOB_SELECT = `
  SELECT a.id, a.contractor_id, a.work_request_id, a.assignee_id, a.assigned_by, a.status, a.planned_date, a.note,
         a.started_at, a.done_at, a.created_at, ua.full_name AS assignee_name, ub.full_name AS assigned_by_name,
         w.wr_code, w.work_team_code, i.owner_id, w.site_name, w.building_code, w.building_name, w.floor_code, w.room_code,
         w.description, w.problem_type, w.priority, w.ptw_code, w.ptw_status,
         p.status AS permit_status, to_char(p.date_upto AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS permit_upto
    FROM assignment a
    JOIN app_user ua ON ua.id = a.assignee_id
    LEFT JOIN app_user ub ON ub.id = a.assigned_by
    JOIN work_request w ON w.id = a.work_request_id
    LEFT JOIN wr_internal i ON i.work_request_id = w.id
    LEFT JOIN permit p ON p.contractor_id = w.contractor_id AND p.ptw_code = w.ptw_code`;

const jobView = (j: JobRow) => ({
  id: j.id,
  status: j.status,
  plannedDate: j.planned_date,
  note: j.note,
  createdAt: j.created_at,
  startedAt: j.started_at,
  doneAt: j.done_at,
  assignee: { id: j.assignee_id, fullName: j.assignee_name },
  assignedBy: j.assigned_by ? { id: j.assigned_by, fullName: j.assigned_by_name } : null,
  wr: {
    code: j.wr_code, siteName: j.site_name, buildingCode: j.building_code, buildingName: j.building_name, floorCode: j.floor_code,
    roomCode: j.room_code, description: j.description, problemType: j.problem_type, priority: j.priority, workTeamCode: j.work_team_code,
    ptwCode: j.ptw_code, ptwStatus: j.permit_status ?? j.ptw_status, permitDateUpto: j.permit_upto,
  },
});

/** Foreman: technicians who share a work team with him. */
async function foremanTeamIds(db: Queryable, foremanId: string, contractorId: string): Promise<string[]> {
  const r = await db.query<{ user_id: string }>(
    `SELECT DISTINCT ut2.user_id FROM user_work_team ut1 JOIN user_work_team ut2 ON ut2.work_team_id = ut1.work_team_id
      WHERE ut1.user_id = $1 AND ut1.contractor_id = $2`,
    [foremanId, contractorId],
  );
  return r.rows.map((x) => x.user_id);
}

type Access = 'none' | 'view' | 'act';

async function jobAccess(db: Queryable, scope: Scope, j: JobRow): Promise<Access> {
  const u = scope.user;
  if (j.assignee_id === u.id) return 'act';
  if (u.role === 'foreman' && (await foremanTeamIds(db, u.id, scope.contractorId)).includes(j.assignee_id)) return 'act';
  if (ALL_SEEING.includes(u.role)) return 'view';
  if (u.role === 'supervisor' && (inTeams(scope, j.work_team_code) || j.owner_id === u.id || j.assigned_by === u.id)) return 'view';
  return 'none';
}

async function getJob(app: FastifyInstance, scope: Scope, id: string): Promise<{ job: JobRow; access: Access }> {
  const r = await app.db.query<JobRow>(`${JOB_SELECT} WHERE a.id = $1 AND a.contractor_id = $2`, [id, scope.contractorId]);
  const job = r.rows[0];
  if (!job) throw notFound('Job not found.');
  const access = await jobAccess(app.db, scope, job);
  if (access === 'none') throw notFound('Job not found.');
  return { job, access };
}

interface Photo {
  rel: string;
  mime: string;
  size: number;
  sha256: string;
  name: string;
}

/** Reads a multipart body (note + up to 6 images) or a JSON body ({ note }). Images are saved under UPLOAD_DIR/<contractorId>/. */
async function readNoteAndPhotos(app: FastifyInstance, request: FastifyRequest, contractorId: string): Promise<{ note: string | null; photos: Photo[] }> {
  if (!request.isMultipart()) {
    const b = z.object({ note: z.string().trim().max(4000).nullish() }).parse(request.body ?? {});
    return { note: b.note || null, photos: [] };
  }
  const photos: Photo[] = [];
  let note: string | null = null;
  const dir = path.join(app.config.uploadDir, contractorId);
  const cap = Math.min(MAX_PHOTO_BYTES, app.config.maxUploadBytes);
  try {
    for await (const part of request.parts({ limits: { files: MAX_PHOTOS + 1, fileSize: cap, fields: 10 } })) {
      if (part.type === 'file') {
        if (photos.length >= MAX_PHOTOS) throw badRequest(`At most ${MAX_PHOTOS} photos per update.`);
        const buf = await part.toBuffer();
        if (part.file.truncated) throw new AppError(413, 'too_large', `A photo is larger than ${Math.round(cap / 1048576)} MB.`);
        if (!buf.length) continue;
        const t = imageType(buf);
        if (!t) throw new AppError(415, 'unsupported_file', 'Only JPEG, PNG or WebP photos can be uploaded.');
        await fsp.mkdir(dir, { recursive: true });
        const id = crypto.randomUUID();
        const rel = `${contractorId}/${id}.${t.ext}`;
        await fsp.writeFile(path.join(app.config.uploadDir, rel), buf, { flag: 'wx' });
        photos.push({ rel, mime: t.mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), name: `photo-${id.slice(0, 8)}.${t.ext}` });
      } else if (part.fieldname === 'note') {
        note = String(part.value ?? '').trim().slice(0, 4000) || null;
      }
    }
  } catch (err) {
    await removeFiles(app, photos);
    throw err;
  }
  return { note, photos };
}

async function removeFiles(app: FastifyInstance, photos: Photo[]) {
  for (const p of photos) await fsp.rm(path.join(app.config.uploadDir, p.rel), { force: true }).catch(() => undefined);
}

async function saveUpdate(
  app: FastifyInstance,
  request: FastifyRequest,
  scope: Scope,
  job: JobRow,
  input: { note: string | null; photos: Photo[] },
  statusTo: 'started' | 'done' | null,
): Promise<{ updateId: string; attachmentIds: string[] }> {
  try {
    return await withTx(app.db, async (c) => {
      if (statusTo) {
        const from = statusTo === 'started' ? 'assigned' : 'started';
        const r = await c.query(
          `UPDATE assignment SET status = $2, ${statusTo === 'started' ? 'started_at' : 'done_at'} = now(), updated_at = now()
            WHERE id = $1 AND status = $3`,
          [job.id, statusTo, from],
        );
        if (!r.rowCount) throw conflict(`The job is ${job.status}; it cannot be ${statusTo === 'started' ? 'started' : 'marked done'}.`);
      }
      const u = await c.query<{ id: string }>(
        `INSERT INTO job_update (contractor_id, assignment_id, user_id, note, status_to) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [scope.contractorId, job.id, scope.user.id, input.note, statusTo],
      );
      const updateId = u.rows[0]!.id;
      const attachmentIds: string[] = [];
      for (const p of input.photos) {
        const a = await c.query<{ id: string }>(
          `INSERT INTO attachment (contractor_id, owner_type, owner_id, work_request_id, file_path, file_name, mime, size_bytes, sha256, uploaded_by)
           VALUES ($1,'job_update',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [scope.contractorId, updateId, job.work_request_id, p.rel, p.name, p.mime, p.size, p.sha256, scope.user.id],
        );
        attachmentIds.push(a.rows[0]!.id);
      }
      await c.query(
        `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, user_id) VALUES ($1,$2,$3,'sonu',$4,$5)`,
        [scope.contractorId, job.work_request_id, statusTo ? `job.${statusTo}` : 'job.update', JSON.stringify({ assignmentId: job.id, note: input.note, photos: attachmentIds.length }), scope.user.id],
      );
      await auditFromRequest(request, { action: statusTo ? `job.${statusTo}` : 'job.update', entityType: 'assignment', entityId: job.id, details: { photos: attachmentIds.length } }, c);
      return { updateId, attachmentIds };
    });
  } catch (err) {
    await removeFiles(app, input.photos);
    throw err;
  }
}

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  const contractorUsers = { preHandler: requireRole(...CONTRACTOR_ROLES) };

  app.post('/api/work-requests/:code/assignments', { preHandler: requireRole('supervisor', 'coordinator', 'manager', 'contractor_admin') }, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { code } = z.object({ code: z.string().min(1).max(40) }).parse(request.params);
    const body = z
      .object({
        assigneeId: z.string().uuid(),
        plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        hoursPlanned: z.number().min(0).max(999).nullish(),
        note: z.string().trim().max(2000).nullish(),
      })
      .strict()
      .parse(request.body);
    const wr = (await loadWrs(app.db, scope, { code }))[0];
    if (!wr) throw notFound('Work request not found.');
    if (scope.user.role === 'supervisor' && !inTeams(scope, wr.work_team_code) && wr.owner_id !== scope.user.id) {
      throw forbidden('You can only assign jobs in your own zones.');
    }
    const a = await app.db.query<{ id: string; full_name: string; role: string; status: string }>(
      'SELECT id, full_name, role, status FROM app_user WHERE id = $1 AND contractor_id = $2',
      [body.assigneeId, scope.contractorId],
    );
    const assignee = a.rows[0];
    if (!assignee || assignee.status !== 'active' || !['technician', 'foreman'].includes(assignee.role)) {
      throw badRequest('The assignee must be an active technician or foreman of your company.');
    }
    const id = await withTx(app.db, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO assignment (contractor_id, work_request_id, assignee_id, assigned_by, planned_date, hours_planned, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [scope.contractorId, wr.id, assignee.id, scope.user.id, body.plannedDate ?? null, body.hoursPlanned ?? null, body.note ?? null],
      );
      const jobId = r.rows[0]!.id;
      await c.query(`INSERT INTO job_update (contractor_id, assignment_id, user_id, note, status_to) VALUES ($1,$2,$3,$4,'assigned')`, [scope.contractorId, jobId, scope.user.id, body.note ?? null]);
      await c.query(
        `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload, user_id) VALUES ($1,$2,'job.assigned','sonu',$3,$4)`,
        [scope.contractorId, wr.id, JSON.stringify({ assignmentId: jobId, assigneeId: assignee.id, assignee: assignee.full_name, plannedDate: body.plannedDate ?? null }), scope.user.id],
      );
      await auditFromRequest(request, { action: 'job.assign', entityType: 'assignment', entityId: jobId, summary: `WR ${wr.wr_code} -> ${assignee.full_name}` }, c);
      return jobId;
    });
    await notify(app, {
      contractorId: scope.contractorId, event: 'job.assigned', recipients: [assignee.id], title: `New job: WR ${wr.wr_code}`,
      body: [wr.building_name, wr.room_code, (wr.description ?? '').slice(0, 140)].filter(Boolean).join(' - ') || null,
      link: `/my-jobs/${id}`, entityType: 'assignment', entityId: id, workRequestId: wr.id, channels: ['in_app', 'push', 'email'],
    });
    const { job } = await getJob(app, scope, id);
    return reply.status(201).send(jobView(job));
  });

  app.get('/api/my-jobs', contractorUsers, async (request) => {
    const scope = await scopeOf(app, request);
    const tz = (await app.db.query<{ time_zone: string }>('SELECT time_zone FROM contractor WHERE id = $1', [scope.contractorId])).rows[0]?.time_zone;
    const today = todayFor(app, tz);
    const r = await app.db.query<JobRow>(
      `${JOB_SELECT} WHERE a.contractor_id = $1 AND a.assignee_id = $2 AND (a.status <> 'done' OR a.done_at > now() - interval '7 days')
        ORDER BY a.planned_date NULLS LAST, a.created_at`,
      [scope.contractorId, scope.user.id],
    );
    const open = r.rows.filter((j) => j.status !== 'done');
    return {
      today,
      todayJobs: open.filter((j) => j.status === 'started' || !j.planned_date || j.planned_date <= today).map(jobView),
      open: open.map(jobView),
      doneRecently: r.rows.filter((j) => j.status === 'done').map(jobView),
    };
  });

  app.get('/api/team-jobs', { preHandler: requireRole('foreman', 'supervisor', 'coordinator', 'manager', 'contractor_admin') }, async (request) => {
    const scope = await scopeOf(app, request);
    const q = z.object({ status: z.enum(['assigned', 'started', 'done', 'open']).default('open') }).parse(request.query);
    const params: unknown[] = [scope.contractorId];
    const where = ['a.contractor_id = $1'];
    if (q.status === 'open') where.push(`a.status <> 'done'`);
    else {
      params.push(q.status);
      where.push(`a.status = $${params.length}`);
    }
    if (scope.user.role === 'foreman') {
      params.push([...new Set([scope.user.id, ...(await foremanTeamIds(app.db, scope.user.id, scope.contractorId))])]);
      where.push(`a.assignee_id = ANY($${params.length}::uuid[])`);
    } else if (scope.user.role === 'supervisor' && scope.teams !== null) {
      params.push(scope.teams);
      const t = params.length;
      params.push(scope.user.id);
      where.push(`(lower(w.work_team_code) = ANY($${t}::text[]) OR a.assigned_by = $${params.length} OR i.owner_id = $${params.length})`);
    }
    const r = await app.db.query<JobRow>(`${JOB_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.planned_date NULLS LAST, a.created_at LIMIT 1000`, params);
    return { items: r.rows.map(jobView) };
  });

  app.get('/api/jobs/:id', contractorUsers, async (request) => {
    const scope = await scopeOf(app, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { job, access } = await getJob(app, scope, id);
    const updates = await app.db.query(
      `SELECT j.id, j.note, j.status_to AS "statusTo", j.at, u.full_name AS "userName",
              COALESCE((SELECT json_agg(json_build_object('id', t.id, 'fileName', t.file_name, 'mime', t.mime, 'sizeBytes', t.size_bytes) ORDER BY t.created_at)
                          FROM attachment t WHERE t.contractor_id = j.contractor_id AND t.owner_type = 'job_update' AND t.owner_id = j.id), '[]') AS attachments
         FROM job_update j LEFT JOIN app_user u ON u.id = j.user_id WHERE j.assignment_id = $1 AND j.contractor_id = $2 ORDER BY j.at`,
      [id, scope.contractorId],
    );
    return { ...jobView(job), canAct: access === 'act', updates: updates.rows };
  });

  const act = async (request: FastifyRequest) => {
    const scope = await scopeOf(app, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { job, access } = await getJob(app, scope, id);
    if (access !== 'act') throw forbidden('Only the assigned person or his foreman can update this job.');
    return { scope, job };
  };

  app.post('/api/jobs/:id/start', contractorUsers, async (request) => {
    const { scope, job } = await act(request);
    if (job.status !== 'assigned') throw conflict(`The job is already ${job.status}.`);
    const b = z.object({ note: z.string().trim().max(4000).nullish() }).parse(request.body ?? {});
    await saveUpdate(app, request, scope, job, { note: b.note || null, photos: [] }, 'started');
    return jobView((await getJob(app, scope, job.id)).job);
  });

  app.post('/api/jobs/:id/updates', contractorUsers, async (request, reply) => {
    const { scope, job } = await act(request);
    if (job.status !== 'started') throw conflict(job.status === 'assigned' ? 'Start the job first.' : 'The job is done.');
    const input = await readNoteAndPhotos(app, request, scope.contractorId);
    if (!input.note && !input.photos.length) {
      throw badRequest('Add a note or at least one photo.');
    }
    const r = await saveUpdate(app, request, scope, job, input, null);
    return reply.status(201).send({ id: r.updateId, attachments: r.attachmentIds });
  });

  app.post('/api/jobs/:id/done', contractorUsers, async (request) => {
    const { scope, job } = await act(request);
    if (job.status !== 'started') throw conflict(job.status === 'assigned' ? 'Start the job first.' : 'The job is already done.');
    const input = await readNoteAndPhotos(app, request, scope.contractorId);
    const r = await saveUpdate(app, request, scope, job, input, 'done');
    const recipients = [...new Set([job.assigned_by, job.owner_id].filter((x): x is string => Boolean(x) && x !== scope.user.id))];
    await notify(app, {
      contractorId: scope.contractorId, event: 'job.done', recipients, title: `Job done: WR ${job.wr_code} by ${job.assignee_name}`,
      body: input.note, link: `/work-requests/${job.wr_code}`, entityType: 'assignment', entityId: job.id, workRequestId: job.work_request_id, channels: ['in_app', 'push'],
    });
    return { ...jobView((await getJob(app, scope, job.id)).job), attachments: r.attachmentIds };
  });

  app.get('/api/attachments/:id', contractorUsers, async (request, reply) => {
    const scope = await scopeOf(app, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const r = await app.db.query<{ owner_type: string; owner_id: string; work_request_id: string | null; file_path: string; file_name: string; mime: string; size_bytes: number }>(
      'SELECT owner_type, owner_id, work_request_id, file_path, file_name, mime, size_bytes FROM attachment WHERE id = $1 AND contractor_id = $2',
      [id, scope.contractorId],
    );
    const att = r.rows[0];
    if (!att) throw notFound('File not found.');
    let allowed = false;
    if (att.owner_type === 'job_update') {
      const j = await app.db.query<{ assignment_id: string }>('SELECT assignment_id FROM job_update WHERE id = $1 AND contractor_id = $2', [att.owner_id, scope.contractorId]);
      if (j.rows[0]) {
        try {
          await getJob(app, scope, j.rows[0].assignment_id);
          allowed = true;
        } catch {
          allowed = false;
        }
      }
    }
    // Material request files are decided by the MR rules only (they may have no work request at all).
    const isMrFile = att.owner_type === 'mr_line' || att.owner_type === 'mr_doc';
    if (isMrFile) allowed = await canViewMrFile(app.db, scope, att.owner_type, att.owner_id);
    if (!allowed && !isMrFile && att.work_request_id && !scope.assignedOnly) {
      const ok = await app.db.query(`SELECT w.wr_code FROM work_request w WHERE w.id = $1 AND w.contractor_id = $2`, [att.work_request_id, scope.contractorId]);
      const code = (ok.rows[0] as { wr_code: string } | undefined)?.wr_code;
      if (code) allowed = (await loadWrs(app.db, scope, { code, includeGone: true })).length > 0;
    }
    if (!allowed) throw notFound('File not found.');
    const root = path.resolve(app.config.uploadDir);
    const full = path.resolve(root, att.file_path);
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) throw notFound('File not found.');
    return reply
      .header('Content-Type', att.mime)
      .header('Content-Length', String(att.size_bytes))
      .header('Content-Disposition', `inline; filename="${att.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .send(fs.createReadStream(full));
  });
}
