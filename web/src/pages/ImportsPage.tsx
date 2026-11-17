import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FileDrop } from '@/components/FileDrop';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorState, ListSkeleton, NativeSelect, QueryBoundary } from '@/components/admin/kit';
import { ApiError, apiGet, apiPost, apiUpload } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { useMeta } from '@/lib/ops';
import type { ExpectedList, ImportBatch, ImportResult, TrackerPreview } from '@/lib/types';

const XLSX = '.xlsx,.xls';

interface FileOutcome {
  name: string;
  state: 'waiting' | 'running' | 'ok' | 'failed';
  result?: ImportResult;
  failure?: { code: string; message: string; missingCaptions: string[]; candidates: string[] };
}

export function ImportOutcome({ o, titles }: { o: FileOutcome; titles: Record<string, string> }) {
  return (
    <li className="grid gap-1.5 rounded-xl border bg-card p-3 text-sm" data-testid="import-outcome">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{o.name}</span>
        {o.state === 'running' && <Loader2 className="size-4 animate-spin" aria-label="Uploading" />}
        {o.state === 'waiting' && <StatusBadge tone="neutral">Waiting</StatusBadge>}
        {o.state === 'ok' && <StatusBadge tone="success">Loaded</StatusBadge>}
        {o.state === 'failed' && <StatusBadge tone="danger">Not loaded</StatusBadge>}
      </div>
      {o.result && (
        <>
          <p>List detected: <strong>{titles[o.result.listKey] ?? o.result.listKey}</strong></p>
          <p className="tabular-nums">{o.result.rowsRead} rows read · {o.result.new} new · {o.result.changed} changed · {o.result.gone} gone · {o.result.events} events{o.result.unchanged ? ` · ${o.result.unchanged} unchanged` : ''}</p>
          {o.result.warnings.length > 0 && <ul className="list-disc ps-5 text-warning">{o.result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </>
      )}
      {o.failure && (
        <div role="alert" className="text-danger">
          <p className="font-semibold">{o.failure.message}</p>
          {o.failure.missingCaptions.length > 0 && (
            <p>Missing column caption{o.failure.missingCaptions.length > 1 ? 's' : ''}: {o.failure.missingCaptions.map((c, i) => <strong key={c}>{i ? ', ' : ''}“{c}”</strong>)}.</p>
          )}
          {o.failure.candidates.length > 0 && <p>It could be: {o.failure.candidates.map((c) => titles[c] ?? c).join(', ')}.</p>}
          <p className="font-semibold">Nothing was loaded.</p>
        </div>
      )}
    </li>
  );
}

function UploadCard({ titles }: { titles: Record<string, string> }) {
  const qc = useQueryClient();
  const [files, setFiles] = React.useState<File[]>([]);
  const [outcomes, setOutcomes] = React.useState<FileOutcome[]>([]);
  const [busy, setBusy] = React.useState(false);

  async function run() {
    const batch = files;
    setBusy(true);
    setFiles([]);
    const state: FileOutcome[] = batch.map((f) => ({ name: f.name, state: 'waiting' }));
    setOutcomes([...state]);
    for (let i = 0; i < batch.length; i++) {
      state[i] = { ...state[i]!, state: 'running' };
      setOutcomes([...state]);
      try {
        const result = await apiUpload<ImportResult>(OPS.imports, { file: batch[i]! });
        state[i] = { name: batch[i]!.name, state: 'ok', result };
      } catch (e) {
        const d = e instanceof ApiError ? (e.details as { missingCaptions?: string[]; candidates?: string[] } | undefined) : undefined;
        state[i] = {
          name: batch[i]!.name, state: 'failed',
          failure: { code: e instanceof ApiError ? e.code : 'error', message: errorMessage(e), missingCaptions: d?.missingCaptions ?? [], candidates: d?.candidates ?? [] },
        };
      }
      setOutcomes([...state]);
    }
    setBusy(false);
    for (const k of ['imports-expected', 'imports-history', 'data-as-of', 'dashboard', 'work-requests', 'my-work']) void qc.invalidateQueries({ queryKey: [k] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Marafiq exports</CardTitle>
        <CardDescription>Choose one or more Excel files exported from Marafiq. Each file is checked first; a file that does not match is refused and nothing from it is loaded.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <FileDrop files={files} onFiles={setFiles} accept={XLSX} multiple label="Drop Excel files here, or click to choose" />
        <Button className="justify-self-start" disabled={files.length === 0 || busy} onClick={() => void run()}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />} Upload {files.length > 1 ? `${files.length} files` : 'file'}
        </Button>
        {outcomes.length > 0 && <ul className="grid gap-2" aria-label="Upload results">{outcomes.map((o, i) => <ImportOutcome key={i} o={o} titles={titles} />)}</ul>}
      </CardContent>
    </Card>
  );
}

function TrackerCard() {
  const qc = useQueryClient();
  const meta = useMeta();
  const [files, setFiles] = React.useState<File[]>([]);
  const [preview, setPreview] = React.useState<TrackerPreview | null>(null);
  const [map, setMap] = React.useState<Record<string, string>>({});
  const [done, setDone] = React.useState<number | null>(null);

  const up = useMutation({
    mutationFn: (f: File) => apiUpload<TrackerPreview>(OPS.trackerPreview, { file: f }),
    onSuccess: (p) => { setPreview(p); setDone(null); setMap(Object.fromEntries(p.unknownStatuses.filter((u) => u.suggested).map((u) => [u.value, u.suggested!]))); },
  });
  const confirm = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; written: number }>(OPS.trackerConfirm(preview!.id), { statusMap: map }),
    onSuccess: (r) => { setDone(r.written); setPreview(null); setFiles([]); toast.success(`${r.written} work requests updated from the tracker.`); void qc.invalidateQueries({ queryKey: ['work-requests'] }); },
  });
  const statuses = meta.data?.contractorStatuses ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Load the tracker workbook once</CardTitle>
        <CardDescription>Brings the contractor status and FC remarks from your existing tracker into SONU. You see a preview first; nothing is written until you confirm.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!preview && (
          <>
            <FileDrop files={files} onFiles={setFiles} accept={XLSX} label="Drop the tracker workbook here, or click to choose" />
            <Button className="justify-self-start" disabled={files.length === 0 || up.isPending} onClick={() => up.mutate(files[0]!)}>
              {up.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />} Preview
            </Button>
            {up.isError && <p role="alert" className="text-danger">{errorMessage(up.error)} Nothing was loaded.</p>}
            {done !== null && <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4" aria-hidden /> {done} work requests updated.</p>}
          </>
        )}
        {preview && (
          <div className="grid gap-3" data-testid="tracker-preview">
            <p className="font-medium">{preview.fileName}</p>
            <dl className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg border p-3"><dd className="text-2xl font-bold tabular-nums">{preview.rows}</dd><dt className="text-xs text-muted-foreground">Rows</dt></div>
              <div className="rounded-lg border p-3"><dd className="text-2xl font-bold tabular-nums text-success">{preview.matched}</dd><dt className="text-xs text-muted-foreground">Matched</dt></div>
              <div className="rounded-lg border p-3"><dd className="text-2xl font-bold tabular-nums text-warning">{preview.unknownWrCodes.length}</dd><dt className="text-xs text-muted-foreground">Unknown codes</dt></div>
            </dl>
            {preview.unknownWrCodes.length > 0 && (
              <p className="text-sm"><strong>Unknown work request codes (skipped):</strong> {preview.unknownWrCodes.slice(0, 30).join(', ')}{preview.unknownWrCodes.length > 30 ? ` and ${preview.unknownWrCodes.length - 30} more` : ''}</p>
            )}
            {preview.unknownStatuses.length > 0 && (
              <div className="grid gap-2">
                <p className="text-sm font-semibold">Unknown statuses: choose what each one means</p>
                {preview.unknownStatuses.map((u) => (
                  <div key={u.value} className="grid gap-1 sm:grid-cols-2 sm:items-center">
                    <span className="text-sm">“{u.value}” <span className="text-muted-foreground">({u.count} rows)</span></span>
                    <NativeSelect aria-label={`Meaning of ${u.value}`} value={map[u.value] ?? ''} onChange={(e) => setMap((m) => { const n = { ...m }; if (e.target.value) n[u.value] = e.target.value; else delete n[u.value]; return n; })}>
                      <option value="">Leave empty</option>
                      {statuses.map((s) => <option key={s.name} value={s.name}>{s.name}{u.suggested === s.name ? ' (suggested)' : ''}</option>)}
                    </NativeSelect>
                  </div>
                ))}
              </div>
            )}
            {confirm.isError && <p role="alert" className="text-danger">{errorMessage(confirm.error)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button disabled={confirm.isPending || preview.matched === 0} onClick={() => confirm.mutate()}>Confirm and load {preview.matched}</Button>
              <Button variant="outline" onClick={() => { setPreview(null); setFiles([]); }}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const RESULT_TONE = { ok: 'success', unchanged: 'neutral', failed: 'danger' } as const;

export default function ImportsPage() {
  const expected = useQuery({ queryKey: ['imports-expected'], queryFn: () => apiGet<{ items: ExpectedList[] }>(OPS.importsExpected) });
  const history = useQuery({ queryKey: ['imports-history'], queryFn: () => apiGet<{ items: ImportBatch[] }>(OPS.imports, { query: { limit: 50 } }) });
  const titles = React.useMemo(() => Object.fromEntries((expected.data?.items ?? []).map((e) => [e.key, e.title])), [expected.data]);

  return (
    <>
      <PageHeader title="Imports" description="Load the Marafiq exports. SONU mirrors them; it never writes to Marafiq." />
      <div className="grid gap-4">
        <UploadCard titles={titles} />

        <Card>
          <CardHeader><CardTitle>Expected lists</CardTitle><CardDescription>Where to find each export in Marafiq, and when it was last loaded.</CardDescription></CardHeader>
          <CardContent>
            <QueryBoundary query={expected} skeleton={<ListSkeleton rows={6} />}>
              {(d) => (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>List</TableHead><TableHead>Where in Marafiq</TableHead><TableHead>Last import</TableHead><TableHead className="text-end">Rows</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {d.items.map((e) => (
                        <TableRow key={e.key}>
                          <TableCell className="font-medium">{e.title}</TableCell>
                          <TableCell className="text-muted-foreground">{e.menuPath}</TableCell>
                          <TableCell>{e.lastImportAt ? formatDateTime(e.lastImportAt) : <StatusBadge tone="warning">Never</StatusBadge>}</TableCell>
                          <TableCell className="text-end tabular-nums">{e.rows ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>

        <TrackerCard />

        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent>
            {history.isError ? <ErrorState error={history.error} onRetry={() => void history.refetch()} /> : history.isPending ? <ListSkeleton rows={5} /> : history.data.items.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="size-4" aria-hidden /> Nothing has been imported yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>List</TableHead><TableHead>File</TableHead><TableHead>Result</TableHead><TableHead className="text-end">Read</TableHead><TableHead className="text-end">New</TableHead><TableHead className="text-end">Changed</TableHead><TableHead className="text-end">Gone</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {history.data.items.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(b.createdAt)}</TableCell>
                        <TableCell>{b.title ?? b.listKey}</TableCell>
                        <TableCell className="max-w-48 truncate">{b.fileName ?? '—'}</TableCell>
                        <TableCell><StatusBadge tone={RESULT_TONE[b.result] ?? 'neutral'}>{b.result === 'ok' ? 'Loaded' : b.result === 'unchanged' ? 'No changes' : 'Failed'}</StatusBadge>{b.error && <span className="ms-2 text-xs text-danger">{b.error}</span>}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.rowsRead ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.new ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.changed ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.gone ?? '—'}</TableCell>
                        <TableCell>{b.user?.fullName ?? 'Automatic'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
