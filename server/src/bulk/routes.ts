import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditFromRequest } from '../audit.js';
import { currentUser, requireRole } from '../auth/guards.js';
import { sendInvitationEmail } from '../auth/invitations.js';
import { withTx, type Queryable } from '../db.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { applyRows, classify, counts, rejectedWorkbook, type Preview, type PreviewRow } from './service.js';
import { BULK_KINDS, TEMPLATE_FILES, getBulkParser, type BulkKind } from './templateParser.js';

const kindSchema = z.enum(BULK_KINDS as [BulkKind, ...BulkKind[]]);
const idParam = z.object({ id: z.string().uuid() });

interface JobRow {
  id: string;
  contractor_id: string | null;
  kind: BulkKind;
  file_name: string;
  user_id: string | null;
  status: string;
  preview: Preview;
  rows_added: number;
  rows_updated: number;
  rows_rejected: number;
  rows_skipped: number;
  created_at: Date;
  confirmed_at: Date | null;
}

function previewResponse(job: JobRow) {
  const c = counts(job.preview.rows);
  return {
    id: job.id,
    kind: job.kind,
    fileName: job.file_name,
    status: job.status,
    createdAt: job.created_at,
    confirmedAt: job.confirmed_at,
    counts: { ...c, skippedExamples: job.preview.skippedExamples },
    result: job.status === 'confirmed' ? { added: job.rows_added, updated: job.rows_updated, rejected: job.rows_rejected } : null,
    rows: job.preview.rows.map((r) => ({ sheet: r.sheet, rowNumber: r.rowNumber, action: r.action, key: r.key, values: r.values, problems: r.problems, notes: r.notes ?? [] })),
  };
}

/** A job is visible only inside the scope that created it (contractor, or platform for the platform admin). */
async function loadJob(request: FastifyRequest, id: string, forUpdate = false, db: Queryable = request.server.db): Promise<JobRow> {
  const user = currentUser(request);
  const r = await db.query<JobRow>(
    `SELECT * FROM import_job WHERE id = $1 AND contractor_id IS NOT DISTINCT FROM $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id, user.contractorId],
  );
  if (!r.rows[0]) throw notFound('Import not found.');
  return r.rows[0];
}

function checkKindAllowed(request: FastifyRequest, kind: BulkKind): void {
  if (kind === 'contractors' && currentUser(request).role !== 'platform_admin') {
    throw forbidden('Only the platform admin imports contractors.');
  }
}

export default async function bulkRoutes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: requireRole('platform_admin', 'contractor_admin') };

  /** Blank template download (from assets/). */
  app.get('/api/admin/bulk-import/templates/:kind', admins, async (request, reply) => {
    const { kind } = z.object({ kind: kindSchema }).parse(request.params);
    const file = path.join(app.config.assetsDir, TEMPLATE_FILES[kind]);
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) throw notFound('Template file not found on the server.');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${TEMPLATE_FILES[kind]}"`)
      .send(buf);
  });

  app.get('/api/admin/bulk-import', admins, async (request) => {
    const user = currentUser(request);
    const r = await app.db.query(
      `SELECT id, kind, file_name AS "fileName", status, rows_added AS "added", rows_updated AS "updated", rows_rejected AS "rejected",
              rows_skipped AS "skippedExamples", created_at AS "createdAt", confirmed_at AS "confirmedAt"
         FROM import_job WHERE contractor_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT 100`,
      [user.contractorId],
    );
    return { items: r.rows };
  });

  /** multipart: fields "kind" (contractors | users | subcontractors) and "file" (.xlsx). kind may also be a query param. */
  app.post('/api/admin/bulk-import/preview', admins, async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('Send the file as multipart/form-data (fields: kind, file).');
    let kindRaw = (request.query as Record<string, string | undefined>)?.kind;
    let fileName = '';
    let buffer: Buffer | null = null;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (buffer) throw badRequest('Send one file only.');
        fileName = path.basename(part.filename || 'upload.xlsx');
        buffer = await part.toBuffer();
      } else if (part.fieldname === 'kind') {
        kindRaw = String(part.value);
      }
    }
    const kind = kindSchema.parse(kindRaw);
    checkKindAllowed(request, kind);
    if (!buffer || !buffer.length) throw badRequest('No file received.');
    if (!/\.xlsx$/i.test(fileName) || buffer.subarray(0, 2).toString('latin1') !== 'PK') {
      throw new AppError(415, 'unsupported_file', 'Upload the SONU template as an .xlsx file.');
    }

    const parsed = await getBulkParser(app.config.assetsDir).parse(kind, buffer);
    if (parsed.fileProblems.length) {
      const pw = parsed.fileProblems.filter((p) => p.code === 'password_column');
      // The file itself is not stored; only the refusal is audited (without any cell content).
      await auditFromRequest(request, {
        action: 'bulk_import.refused',
        entityType: 'import_job',
        summary: `${kind} file ${fileName} refused: ${parsed.fileProblems.map((p) => p.code).join(', ')}`,
      });
      throw new AppError(
        422,
        pw.length ? 'password_column' : 'invalid_template',
        pw.length ? pw[0]!.message : parsed.fileProblems.map((p) => p.message).join(' '),
        { problems: parsed.fileProblems },
      );
    }

    const user = currentUser(request);
    const rows = await classify(app.db, user, parsed);
    const preview: Preview = { kind, fileName, skippedExamples: parsed.skippedExamples, rows };
    const r = await app.db.query<JobRow>(
      `INSERT INTO import_job (contractor_id, kind, file_name, file_hash, user_id, preview, rows_rejected, rows_skipped)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.contractorId, kind, fileName, crypto.createHash('sha256').update(buffer).digest('hex'), user.id, JSON.stringify(preview),
        counts(rows).problem, parsed.skippedExamples],
    );
    await auditFromRequest(request, { action: 'bulk_import.preview', entityType: 'import_job', entityId: r.rows[0]!.id, summary: `${kind}: ${fileName}`, details: counts(rows) });
    return reply.status(201).send(previewResponse(r.rows[0]!));
  });

  app.get('/api/admin/bulk-import/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    return previewResponse(await loadJob(request, id));
  });

  app.post('/api/admin/bulk-import/confirm/:id', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const user = currentUser(request);
    const outcome = await withTx(app.db, async (c) => {
      const job = await loadJob(request, id, true, c);
      checkKindAllowed(request, job.kind);
      if (job.status !== 'preview') throw new AppError(409, 'already_confirmed', 'This import has already been confirmed or cancelled.');
      // Re-check against the current database (things may have changed since the preview).
      const fresh: PreviewRow[] = await classify(c, user, {
        kind: job.kind,
        skippedExamples: job.preview.skippedExamples,
        fileProblems: [],
        rows: job.preview.rows.map((r) => ({
          sheet: r.sheet,
          rowNumber: r.rowNumber,
          values: r.values,
          raw: r.raw,
          // only the parser's own cell problems; database checks are re-run by classify()
          problems: r.parseProblems ?? [],
        })),
      });
      const res = await applyRows(app, c, user, job.kind, fresh);
      const preview: Preview = { ...job.preview, rows: fresh };
      await c.query(
        `UPDATE import_job SET status = 'confirmed', confirmed_at = now(), preview = $2, rows_added = $3, rows_updated = $4, rows_rejected = $5
          WHERE id = $1`,
        [id, JSON.stringify(preview), res.added, res.updated, res.rejected],
      );
      await auditFromRequest(
        request,
        {
          action: 'bulk_import.confirm',
          entityType: 'import_job',
          entityId: id,
          summary: `${job.kind} import of ${job.file_name}: ${res.added} added, ${res.updated} updated, ${res.rejected} rejected, ${job.preview.skippedExamples} example row(s) skipped`,
          details: { fileName: job.file_name, kind: job.kind, added: res.added, updated: res.updated, rejected: res.rejected, skippedExamples: job.preview.skippedExamples },
        },
        c,
      );
      return res;
    });
    let invitationsSent = 0;
    const invitationErrors: string[] = [];
    for (const inv of outcome.invitations) {
      try {
        await sendInvitationEmail(app, inv);
        invitationsSent++;
      } catch (err) {
        invitationErrors.push((err as Error).message.slice(0, 200));
      }
    }
    const job = await loadJob(request, id);
    return { ...previewResponse(job), invitationsSent, invitationErrors };
  });

  app.post('/api/admin/bulk-import/:id/cancel', admins, async (request) => {
    const { id } = idParam.parse(request.params);
    const job = await loadJob(request, id);
    if (job.status !== 'preview') throw new AppError(409, 'already_confirmed', 'This import has already been confirmed or cancelled.');
    await app.db.query(`UPDATE import_job SET status = 'cancelled' WHERE id = $1`, [id]);
    await auditFromRequest(request, { action: 'bulk_import.cancel', entityType: 'import_job', entityId: id, summary: job.file_name });
    return { ok: true };
  });

  app.get('/api/admin/bulk-import/:id/rejected.xlsx', admins, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const job = await loadJob(request, id);
    const buf = await rejectedWorkbook(job.kind, job.preview.rows);
    await auditFromRequest(request, { action: 'bulk_import.rejected_export', entityType: 'import_job', entityId: id, summary: job.file_name });
    const base = job.file_name.replace(/\.xlsx$/i, '').replace(/[^\w.-]+/g, '_');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${base}-rejected.xlsx"`)
      .send(buf);
  });
}
