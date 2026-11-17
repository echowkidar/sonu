import * as React from 'react';
import { AlertTriangle, Download, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ADMIN } from '@/lib/endpoints';
import { columnsFor, normCaption } from '@/lib/bulkColumns';
import type { BulkAction, BulkJob, BulkRowPreview } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { StatusBadge, type Tone } from '@/components/StatusBadge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ACTION: Record<BulkAction, { label: string; tone: Tone }> = {
  add: { label: 'Will be added', tone: 'success' },
  update: { label: 'Will be updated', tone: 'info' },
  problem: { label: 'Has problems', tone: 'danger' },
};

const MAX_ROWS = 300;

function Counter({ label, value, tone }: { label: string; value: number; tone: 'success' | 'info' | 'danger' | 'neutral' }) {
  const ring = { success: 'border-success/40', info: 'border-info/40', danger: 'border-danger/40', neutral: 'border-border' }[tone];
  return (
    <div className={cn('rounded-xl border bg-card p-3', ring)} data-testid={`counter-${label}`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

function SheetTable({ job, sheet, rows }: { job: BulkJob; sheet: string; rows: BulkRowPreview[] }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const cols = columnsFor(job.kind, sheet, rows.map((r) => r.values));
  // Problem rows first so they are never hidden by the row cap.
  const ordered = [...rows].sort((a, b) => Number(b.action === 'problem') - Number(a.action === 'problem') || a.rowNumber - b.rowNumber);
  const shown = ordered.slice(0, MAX_ROWS);
  return (
    <section className="grid gap-2" aria-label={`Sheet ${sheet}`}>
      <h3 className="text-base font-semibold">{sheet} <span className="font-normal text-muted-foreground">({rows.length} rows)</span></h3>
      <div className="overflow-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Row</TableHead>
              <TableHead className="min-w-40">Result</TableHead>
              {cols.map((c) => <TableHead key={c.field} className="whitespace-nowrap">{c.caption}</TableHead>)}
              <TableHead className="min-w-56">Problems</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => {
              const byCaption = new Map(r.problems.map((p) => [normCaption(p.column), p.reason]));
              const known = new Set(cols.map((c) => normCaption(c.caption)));
              const rowLevel = r.problems.filter((p) => !known.has(normCaption(p.column)));
              return (
                <TableRow key={`${r.sheet}-${r.rowNumber}`} data-testid="bulk-row" data-action={r.action}>
                  <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
                  <TableCell>
                    <StatusBadge tone={ACTION[r.action].tone}>{ACTION[r.action].label}</StatusBadge>
                    {r.notes.map((n) => <p key={n} className="mt-1 text-xs text-muted-foreground">{n}</p>)}
                  </TableCell>
                  {cols.map((c) => {
                    const reason = byCaption.get(normCaption(c.caption));
                    const text = show(r.values[c.field]);
                    if (!reason) return <TableCell key={c.field} className="whitespace-nowrap">{text}</TableCell>;
                    const id = `${r.sheet}-${r.rowNumber}-${c.field}`;
                    return (
                      <TableCell
                        key={c.field}
                        data-problem="true"
                        title={reason}
                        className="min-w-32 cursor-pointer border border-danger bg-danger-soft align-top text-danger"
                        onClick={() => setOpen(open === id ? null : id)}
                      >
                        <button type="button" className="text-start" aria-expanded={open === id} aria-label={`Problem in ${c.caption}, row ${r.rowNumber}: ${reason}`}>
                          <span className="font-medium">{text || '(empty)'}</span>
                          <AlertTriangle className="ms-1 inline size-3.5" aria-hidden />
                        </button>
                        {open === id && <p className="mt-1 whitespace-normal text-xs">{reason}</p>}
                      </TableCell>
                    );
                  })}
                  <TableCell className="whitespace-normal text-xs text-danger">{rowLevel.map((p) => p.reason).join(' ')}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {rows.length > shown.length && <p className="text-sm text-muted-foreground">Showing the first {shown.length} of {rows.length} rows (rows with problems first). All rows are processed on confirm.</p>}
    </section>
  );
}

/** The preview screen: counters, a table per sheet with problem cells marked, and the confirm button. */
export function BulkPreview({
  job, onConfirm, onCancel, confirming,
}: { job: BulkJob; onConfirm: () => void; onCancel: () => void; confirming?: boolean }) {
  const valid = job.counts.add + job.counts.update;
  const sheets = React.useMemo(() => {
    const m = new Map<string, BulkRowPreview[]>();
    for (const r of job.rows) m.set(r.sheet, [...(m.get(r.sheet) ?? []), r]);
    return [...m.entries()];
  }, [job.rows]);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Counter label="To add" value={job.counts.add} tone="success" />
        <Counter label="To update" value={job.counts.update} tone="info" />
        <Counter label="With problems" value={job.counts.problem} tone="danger" />
        <Counter label="EXAMPLE rows skipped" value={job.counts.skippedExamples} tone="neutral" />
      </div>

      <p className="flex items-center gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-sm text-info" role="note">
        <ShieldCheck className="size-4 shrink-0" aria-hidden /> Nothing is saved until you confirm. Rows with problems are never saved.
      </p>

      {job.counts.problem > 0 && (
        <p className="text-sm">
          <a className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline" href={ADMIN.bulkRejected(job.id)} download>
            <Download className="size-4" aria-hidden /> Download rows with problems
          </a>
          <span className="text-muted-foreground"> — fix them in Excel and upload again.</span>
        </p>
      )}

      {sheets.length === 0
        ? <p className="rounded-xl border bg-card p-6 text-center text-muted-foreground">The file has no rows to import.</p>
        : sheets.map(([sheet, rows]) => <SheetTable key={sheet} job={job} sheet={sheet} rows={rows} />)}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button onClick={onConfirm} disabled={valid === 0 || confirming}>
          {confirming ? 'Saving…' : `Confirm and save ${valid} row${valid === 1 ? '' : 's'}`}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={confirming}>Cancel</Button>
        {valid === 0 && <span className="text-sm text-muted-foreground">There is nothing valid to save.</span>}
      </div>
    </div>
  );
}
