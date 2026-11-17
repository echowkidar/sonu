import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Lock } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { FileDrop } from '@/components/FileDrop';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';
import { BulkPreview } from '@/components/admin/BulkPreview';
import { FormError, QueryBoundary } from '@/components/admin/kit';
import { apiGet, apiPost, apiUpload } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { BULK_LABELS } from '@/lib/bulkColumns';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { BulkHistoryItem, BulkJob, BulkKind } from '@/lib/types';

export default function AdminBulkImportPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const kinds: BulkKind[] = user?.role === 'platform_admin' ? ['contractors', 'users', 'subcontractors'] : ['users', 'subcontractors'];
  const [kind, setKind] = React.useState<BulkKind>(kinds[0]!);
  const [files, setFiles] = React.useState<File[]>([]);
  const [job, setJob] = React.useState<BulkJob | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [cancelAsk, setCancelAsk] = React.useState(false);

  const history = useQuery({ queryKey: ['admin', 'bulk-import', 'history'], queryFn: () => apiGet<{ items: BulkHistoryItem[] }>(ADMIN.bulkList) });

  const preview = useMutation({
    mutationFn: (file: File) => apiUpload<BulkJob>(ADMIN.bulkPreview, { kind, file }),
    onSuccess: (j) => { setJob(j); setUploadError(null); void qc.invalidateQueries({ queryKey: ['admin', 'bulk-import'] }); },
    onError: (e) => setUploadError(errorMessage(e)),
  });
  const confirm = useMutation({
    mutationFn: (id: string) => apiPost<BulkJob>(ADMIN.bulkConfirm(id)),
    onSuccess: (j) => { setJob(j); toast.success('Import saved.'); void qc.invalidateQueries({ queryKey: ['admin'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => apiPost(ADMIN.bulkCancel(id)),
    onSuccess: () => { reset(); toast.success('Import cancelled. Nothing was saved.'); void qc.invalidateQueries({ queryKey: ['admin', 'bulk-import'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function reset() { setJob(null); setFiles([]); setUploadError(null); }

  const done = job?.status === 'confirmed';

  return (
    <>
      <PageHeader title="Bulk import" description="Add or update many contractors, users or sub-contractors from an Excel file." />

      <Alert variant="info" className="mb-4">
        <Lock className="size-4" aria-hidden />
        <AlertDescription>Passwords are never imported from Excel. New users get an invitation e-mail and set their own password.</AlertDescription>
      </Alert>

      {!job && (
        <div className="grid gap-5">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">1. What do you want to import?</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {kinds.map((k) => (
                <label key={k} className={cn('flex min-h-11 cursor-pointer flex-col gap-1 rounded-xl border bg-card p-3', kind === k && 'border-primary bg-primary-soft')}>
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="bulk-kind" checked={kind === k} onChange={() => { setKind(k); setUploadError(null); }} className="accent-[var(--primary)]" />
                    {BULK_LABELS[k].title}
                  </span>
                  <span className="text-sm text-muted-foreground">{BULK_LABELS[k].hint}</span>
                  <a href={ADMIN.bulkTemplate(k)} download className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
                    <Download className="size-4" aria-hidden /> Download template
                  </a>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">2. Upload the filled template</h2>
            <FileDrop files={files} onFiles={setFiles} accept=".xlsx" label="Drop the .xlsx file here, or click to choose" />
            <FormError message={uploadError} />
            <div>
              <Button disabled={files.length === 0 || preview.isPending} onClick={() => files[0] && preview.mutate(files[0])}>
                {preview.isPending ? 'Checking the file…' : 'Check the file'}
              </Button>
              <p className="mt-2 text-sm text-muted-foreground">You see a preview first. Nothing is saved until you confirm.</p>
            </div>
          </section>
        </div>
      )}

      {job && !done && (
        <>
          <p className="mb-3 text-sm text-muted-foreground">Preview of <strong>{job.fileName}</strong> ({BULK_LABELS[job.kind].title.toLowerCase()})</p>
          <BulkPreview job={job} confirming={confirm.isPending} onConfirm={() => confirm.mutate(job.id)} onCancel={() => setCancelAsk(true)} />
        </>
      )}

      {job && done && (
        <div className="grid gap-4" data-testid="bulk-result">
          <Alert variant="success">
            <CheckCircle2 className="size-5" aria-hidden />
            <div>
              <AlertTitle>Import finished</AlertTitle>
              <AlertDescription>
                {job.result?.added ?? 0} added, {job.result?.updated ?? 0} updated, {job.result?.rejected ?? 0} not saved
                {job.invitationsSent ? `, ${job.invitationsSent} invitation e-mail(s) sent` : ''}.
              </AlertDescription>
            </div>
          </Alert>
          {job.invitationErrors && job.invitationErrors.length > 0 && (
            <Alert variant="warning"><AlertDescription>{job.invitationErrors.length} invitation e-mail(s) could not be sent. Use "Resend invitation" on the Users page after fixing the e-mail settings.</AlertDescription></Alert>
          )}
          {(job.result?.rejected ?? 0) > 0 && (
            <a className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline" href={ADMIN.bulkRejected(job.id)} download>
              <Download className="size-4" aria-hidden /> Download rows with problems
            </a>
          )}
          <div><Button onClick={reset}>Import another file</Button></div>
        </div>
      )}

      <section className="mt-10" aria-label="Import history">
        <h2 className="mb-2 text-lg font-semibold">History</h2>
        <QueryBoundary
          query={history}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState illustration="inbox" title="No imports yet" description="Finished and cancelled imports are listed here." />}
        >
          {(d) => (
            <div className="overflow-auto rounded-xl border bg-card">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>When</TableHead><TableHead>File</TableHead><TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead>Added</TableHead><TableHead>Updated</TableHead><TableHead>Not saved</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {d.items.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(h.confirmedAt ?? h.createdAt)}</TableCell>
                      <TableCell>{h.fileName}</TableCell>
                      <TableCell>{BULK_LABELS[h.kind]?.title ?? h.kind}</TableCell>
                      <TableCell><StatusBadge tone={h.status === 'confirmed' ? 'success' : h.status === 'preview' ? 'warning' : 'neutral'}>{h.status === 'confirmed' ? 'Saved' : h.status === 'preview' ? 'Not confirmed' : 'Cancelled'}</StatusBadge></TableCell>
                      <TableCell>{h.added}</TableCell><TableCell>{h.updated}</TableCell><TableCell>{h.rejected}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      </section>

      <ConfirmDialog
        open={cancelAsk}
        onOpenChange={setCancelAsk}
        title="Cancel this import?"
        description="Nothing has been saved. You can upload the file again."
        confirmLabel="Cancel import"
        cancelLabel="Keep preview"
        destructive
        onConfirm={async () => { if (job) await cancel.mutateAsync(job.id).catch(() => undefined); }}
      />
    </>
  );
}
