import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FilterX } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FormSheet, ListSkeleton, NativeSelect, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { formatDateTime } from '@/lib/forms';
import type { AuditEntry, Paged, UserView } from '@/lib/types';

const PAGE_SIZE = 50;
const ACTION_GROUPS: [string, string][] = [
  ['', 'All actions'], ['auth.*', 'Sign-in and passwords'], ['user.*', 'Users'], ['contractor.*', 'Contractors'], ['work_team.*', 'Work teams'],
  ['bulk_import.*', 'Bulk import'], ['mail*', 'E-mail settings'], ['messaging_settings.*', 'Messaging'], ['marafiq_connection.*', 'Marafiq connection'],
  ['deadline_rule.*', 'Deadline rules'], ['lookup.*', 'Lookups'],
];
const ENTITY_TYPES = ['user', 'contractor', 'work_team', 'import_job', 'deadline_rule', 'mail_settings', 'messaging_settings', 'marafiq_connection', 'site_lookup', 'problem_type_lookup'];

const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const nextDayStart = (d: string) => { if (!d) return undefined; const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 1); return x.toISOString(); };

interface Filters { from: string; to: string; userId: string; q: string; action: string; entityType: string; entityId: string }
const NO_FILTERS: Filters = { from: '', to: '', userId: '', q: '', action: '', entityType: '', entityId: '' };

function Detail({ entry }: { entry: AuditEntry }) {
  const rows: [string, React.ReactNode][] = [
    ['When', formatDateTime(entry.at)], ['Who', entry.userEmail ?? 'System'], ['Action', <code key="a">{entry.action}</code>],
    ['Record', entry.entityType ? `${entry.entityType}${entry.entityId ? ` · ${entry.entityId}` : ''}` : ''], ['Summary', entry.summary ?? ''], ['IP address', entry.ip ?? ''],
  ];
  return (
    <div className="grid gap-4">
      <dl className="grid gap-3 text-sm">
        {rows.filter(([, v]) => v !== '').map(([k, v]) => (<div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="break-words">{v}</dd></div>))}
      </dl>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</h3>
        <pre className="max-h-80 overflow-auto rounded-lg border bg-muted p-3 text-xs" data-testid="audit-details">{JSON.stringify(entry.details ?? {}, null, 2)}</pre>
        <p className="mt-1 text-xs text-muted-foreground">Passwords and keys are never stored in the log.</p>
      </div>
    </div>
  );
}

export default function AdminAuditPage() {
  const scope = useContractorScope({ allowPlatform: true });
  const [f, setF] = React.useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = React.useState<Filters>(NO_FILTERS);
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<AuditEntry | null>(null);

  React.useEffect(() => { const t = setTimeout(() => { setApplied(f); setPage(1); }, 350); return () => clearTimeout(t); }, [f]);

  const people = useQuery({
    queryKey: ['admin', 'users', scope.key, '', '', ''],
    queryFn: () => apiGet<Paged<UserView>>(ADMIN.users, { query: { ...scope.query, pageSize: 500 } }),
    enabled: !scope.isPlatform || !!scope.scopeId,
  });

  const query = useQuery({
    queryKey: ['admin', 'audit', scope.key, applied, page],
    queryFn: () => apiGet<Paged<AuditEntry>>(ADMIN.audit, {
      query: {
        ...scope.query, page, pageSize: PAGE_SIZE, from: dayStart(applied.from), to: nextDayStart(applied.to), userId: applied.userId || undefined,
        q: applied.q || undefined, action: applied.action || undefined, entityType: applied.entityType || undefined, entityId: applied.entityId || undefined,
      },
    }),
    placeholderData: (prev) => prev,
  });
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((s) => ({ ...s, [k]: v }));
  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTERS);
  const pages = query.data ? Math.max(1, Math.ceil(query.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader title="Audit log" description="Who did what and when. Entries cannot be changed or deleted." />
      {scope.picker}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Audit filters">
        <div className="grid gap-1.5"><Label htmlFor="af-from">From date</Label><Input id="af-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="af-to">To date</Label><Input id="af-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></div>
        <div className="grid gap-1.5">
          <Label htmlFor="af-user">User</Label>
          <NativeSelect id="af-user" value={f.userId} onChange={(e) => set('userId', e.target.value)} disabled={!people.data}>
            <option value="">{people.data || !scope.isPlatform || scope.scopeId ? 'Anyone' : 'Choose a contractor to filter by user'}</option>
            {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="af-q">Search text</Label><Input id="af-q" placeholder="E-mail, IP, summary…" value={f.q} onChange={(e) => set('q', e.target.value)} /></div>
        <div className="grid gap-1.5">
          <Label htmlFor="af-action">Action</Label>
          <NativeSelect id="af-action" value={f.action} onChange={(e) => set('action', e.target.value)}>{ACTION_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="af-et">Record type</Label>
          <NativeSelect id="af-et" value={f.entityType} onChange={(e) => set('entityType', e.target.value)}><option value="">Any record</option>{ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</NativeSelect>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="af-eid">Record id</Label><Input id="af-eid" value={f.entityId} onChange={(e) => set('entityId', e.target.value)} /></div>
        <div className="flex items-end"><Button variant="outline" onClick={() => setF(NO_FILTERS)} disabled={!filtered && JSON.stringify(f) === JSON.stringify(NO_FILTERS)}><FilterX className="size-4" aria-hidden /> Clear filters</Button></div>
      </div>

      <QueryBoundary
        query={query}
        skeleton={<ListSkeleton rows={8} />}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState illustration={filtered ? 'search' : 'inbox'} title={filtered ? 'No entries match' : 'Nothing logged yet'} description={filtered ? 'Change or clear the filters.' : 'Actions in SONU appear here.'} />}
      >
        {(d) => (
          <>
            <div className="overflow-auto rounded-xl border bg-card">
              <Table>
                <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>IP address</TableHead><TableHead>Action</TableHead><TableHead>Record</TableHead><TableHead>Summary</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.items.map((a) => (
                    <TableRow key={a.id} data-testid="audit-row" tabIndex={0} className="cursor-pointer" onClick={() => setOpen(a)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(a); }}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(a.at)}</TableCell>
                      <TableCell className="whitespace-nowrap">{a.userEmail ?? 'System'}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{a.ip ?? ''}</TableCell>
                      <TableCell className="whitespace-nowrap"><code className="text-xs">{a.action}</code></TableCell>
                      <TableCell className="whitespace-nowrap">{a.entityType ?? ''}</TableCell>
                      <TableCell className="max-w-96 truncate">{a.summary ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <nav className="mt-3 flex flex-wrap items-center justify-between gap-2" aria-label="Pages">
              <span className="text-sm text-muted-foreground" aria-live="polite">{d.total.toLocaleString()} entries · page {page} of {pages}</span>
              <span className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" aria-hidden /> Newer</Button>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older <ChevronRight className="size-4" aria-hidden /></Button>
              </span>
            </nav>
          </>
        )}
      </QueryBoundary>

      <FormSheet open={!!open} onOpenChange={(o) => !o && setOpen(null)} title="Log entry" description={open?.action}>
        {open && <Detail entry={open} />}
      </FormSheet>
    </>
  );
}
