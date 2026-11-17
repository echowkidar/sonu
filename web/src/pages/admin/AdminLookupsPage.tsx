import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';
import { FormError, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, serverErrors } from '@/lib/forms';
import type { ProblemLookup, SiteLookup } from '@/lib/types';

const siteRow = z.object({ siteCode: z.string().trim().min(1, 'Site code is needed.').max(40), siteName: z.string().max(200), zone: z.string().max(60), facility: z.string().max(200), groupName: z.string().max(60) });
const problemRow = z.object({ problemType: z.string().trim().min(1, 'Problem type is needed.').max(60), discipline: z.string().trim().min(1, 'Discipline is needed.').max(60) });

interface ColumnDef2<T> { key: keyof T & string; label: string; width?: string }

/** Generic editable lookup table: edit cells, add and remove rows, save replaces the whole list. */
function LookupEditor<T extends Record<string, string>>({
  rows: initial, columns, keyField, schema, blank, isUnmapped, onSave, noun,
}: {
  rows: T[]; columns: ColumnDef2<T>[]; keyField: keyof T & string; schema: z.ZodType<unknown>; blank: T;
  isUnmapped: (r: T) => boolean; onSave: (rows: T[]) => Promise<void>; noun: string;
}) {
  const [rows, setRows] = React.useState<T[]>(initial);
  const [rowErrors, setRowErrors] = React.useState<Record<number, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

  const edit = (i: number, k: string, v: string) => { setRows((s) => s.map((r, j) => (j === i ? { ...r, [k]: v } : r))); setRowErrors((s) => ({ ...s, [i]: '' })); };

  async function save() {
    const errs: Record<number, string> = {};
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      const res = schema.safeParse(r);
      if (!res.success) errs[i] = res.error.issues[0]!.message;
      else if (seen.has(r[keyField]!.trim().toLowerCase())) errs[i] = `Duplicate ${noun}.`;
      seen.add(r[keyField]!.trim().toLowerCase());
    });
    setRowErrors(errs);
    if (Object.keys(errs).length) { setFormError('Fix the marked rows first.'); return; }
    setFormError(null); setBusy(true);
    try { await onSave(rows); } catch (e) { setFormError(serverErrors(e).message ?? 'Could not save.'); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-3">
      <div className="overflow-auto rounded-xl border bg-card">
        <Table>
          <TableHeader><TableRow>
            {columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}
            <TableHead>Check</TableHead><TableHead><span className="sr-only">Remove</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={columns.length + 2} className="py-8 text-center text-muted-foreground">No rows yet.</TableCell></TableRow>}
            {rows.map((r, i) => (
              <TableRow key={i} data-testid="lookup-row" className={rowErrors[i] ? 'bg-danger-soft' : undefined}>
                {columns.map((c) => (
                  <TableCell key={c.key} className={c.width ?? 'min-w-40'}>
                    <Input aria-label={`${c.label}, row ${i + 1}`} value={r[c.key] ?? ''} onChange={(e) => edit(i, c.key, e.target.value)} aria-invalid={!!rowErrors[i]} />
                  </TableCell>
                ))}
                <TableCell className="min-w-32">
                  {rowErrors[i] ? <span className="text-xs text-danger" role="alert">{rowErrors[i]}</span> : isUnmapped(r) ? <StatusBadge tone="warning">Unmapped</StatusBadge> : <StatusBadge tone="success">Mapped</StatusBadge>}
                </TableCell>
                <TableCell><Button size="sm" variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((s) => s.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <FormError message={formError} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setRows((s) => [...s, { ...blank }])}><Plus className="size-4" aria-hidden /> Add row</Button>
        <Button onClick={() => void save()} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        {dirty && <Button variant="ghost" onClick={() => { setRows(initial); setRowErrors({}); setFormError(null); }}>Discard changes</Button>}
      </div>
    </div>
  );
}

const str = (v: string | null | undefined) => v ?? '';

export default function AdminLookupsPage() {
  const qc = useQueryClient();
  const scope = useContractorScope();
  const sites = useQuery({
    queryKey: ['admin', 'lookups', 'sites', scope.key],
    queryFn: () => apiGet<{ items: SiteLookup[] }>(ADMIN.lookupSites, { query: scope.query }),
    enabled: scope.ready,
  });
  const problems = useQuery({
    queryKey: ['admin', 'lookups', 'problems', scope.key],
    queryFn: () => apiGet<{ items: ProblemLookup[] }>(ADMIN.lookupProblemTypes, { query: scope.query }),
    enabled: scope.ready,
  });
  const body = (items: unknown[]) => ({ items, ...(scope.scopeId ? { contractorId: scope.scopeId } : {}) });

  return (
    <>
      <PageHeader title="Lookups" description="Tables that turn a site into a facility and zone, and a problem type into a discipline." />
      {scope.picker}
      <Alert variant="info" className="mb-4">
        <Info className="size-4" aria-hidden />
        <AlertDescription>
          <strong>Unmapped</strong> means a row is missing its target (no zone or facility for a site, no discipline for a problem type), or a work request arrives with a site or problem type that is not listed here.
          Such work shows as "Unmapped" and a coordinator has to choose the zone or discipline by hand. Add or complete the row and it is filled in automatically next time.
        </AlertDescription>
      </Alert>
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to edit its lookups." />
      ) : (
        <Tabs defaultValue="sites">
          <TabsList>
            <TabsTrigger value="sites">Site → facility / zone</TabsTrigger>
            <TabsTrigger value="problems">Problem type → discipline</TabsTrigger>
          </TabsList>
          <TabsContent value="sites" className="mt-4">
            <QueryBoundary query={sites}>
              {(d) => (
                <LookupEditor
                  key={JSON.stringify(d.items)}
                  noun="site code"
                  keyField="siteCode"
                  schema={siteRow}
                  rows={d.items.map((s) => ({ siteCode: s.siteCode, siteName: str(s.siteName), zone: str(s.zone), facility: str(s.facility), groupName: str(s.groupName) }))}
                  columns={[{ key: 'siteCode', label: 'Site code', width: 'min-w-32' }, { key: 'siteName', label: 'Site name' }, { key: 'facility', label: 'Facility' }, { key: 'zone', label: 'Zone', width: 'min-w-28' }, { key: 'groupName', label: 'Group', width: 'min-w-28' }]}
                  blank={{ siteCode: '', siteName: '', zone: '', facility: '', groupName: '' }}
                  isUnmapped={(r) => !r.zone.trim() || !r.facility.trim()}
                  onSave={async (rows) => {
                    await api(ADMIN.lookupSites, { method: 'PUT', body: body(rows.map((r) => ({ siteCode: r.siteCode.trim(), siteName: blankToNull(r.siteName), zone: blankToNull(r.zone), facility: blankToNull(r.facility), groupName: blankToNull(r.groupName) }))) });
                    toast.success('Site lookup saved.');
                    await qc.invalidateQueries({ queryKey: ['admin', 'lookups', 'sites'] });
                  }}
                />
              )}
            </QueryBoundary>
          </TabsContent>
          <TabsContent value="problems" className="mt-4">
            <QueryBoundary query={problems}>
              {(d) => (
                <LookupEditor
                  key={JSON.stringify(d.items)}
                  noun="problem type"
                  keyField="problemType"
                  schema={problemRow}
                  rows={d.items.map((p) => ({ problemType: p.problemType, discipline: p.discipline }))}
                  columns={[{ key: 'problemType', label: 'Problem type' }, { key: 'discipline', label: 'Discipline' }]}
                  blank={{ problemType: '', discipline: '' }}
                  isUnmapped={(r) => !r.discipline.trim()}
                  onSave={async (rows) => {
                    await api(ADMIN.lookupProblemTypes, { method: 'PUT', body: body(rows.map((r) => ({ problemType: r.problemType.trim(), discipline: r.discipline.trim() }))) });
                    toast.success('Problem type lookup saved.');
                    await qc.invalidateQueries({ queryKey: ['admin', 'lookups', 'problems'] });
                  }}
                />
              )}
            </QueryBoundary>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
