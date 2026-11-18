import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Filter, Search, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState, FormSheet, ListSkeleton, NativeSelect } from '@/components/admin/kit';
import { apiGet, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { useIsDesktop } from '@/lib/hooks';
import { COORD_ROLES, kpiTone, OWNER_ROLES, RFE_KIND_LABELS, rfeTone, tdTone, useMeta } from '@/lib/ops';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { Meta, WrList, WrView } from '@/lib/types';

const FILTER_KEYS = ['zone', 'discipline', 'facility', 'contractorStatus', 'owner', 'criterion', 'tdStatus', 'kpi', 'ageBucket', 'rfeTimeFrame', 'workTeam', 'qfStage', 'breach', 'wrStatus', 'unowned', 'mine', 'building', 'inProgress', 'tdWithin'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

interface FilterDef { key: FilterKey; label: string; options: (m: Meta) => { value: string; label: string }[] }
const strings = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));
const FILTERS: FilterDef[] = [
  { key: 'zone', label: 'Zone', options: (m) => strings(m.lookups.zones) },
  { key: 'discipline', label: 'Discipline', options: (m) => strings(m.lookups.disciplines) },
  { key: 'facility', label: 'Facility', options: (m) => strings(m.lookups.facilities) },
  { key: 'building', label: 'Building', options: () => [] },
  { key: 'inProgress', label: 'In progress', options: () => [{ value: '1', label: 'In progress only' }] },
  { key: 'tdWithin', label: 'Target date within', options: () => [{ value: '10', label: 'Next 10 days (priority)' }] },
  { key: 'contractorStatus', label: 'Contractor status', options: (m) => [...m.contractorStatuses.map((s) => ({ value: s.name, label: s.name })), { value: '(none)', label: '(No status)' }] },
  { key: 'owner', label: 'Owner', options: (m) => [{ value: 'none', label: 'Unowned' }, ...m.people.filter((p) => OWNER_ROLES.includes(p.role)).map((p) => ({ value: p.id, label: p.fullName }))] },
  { key: 'criterion', label: 'Criterion', options: (m) => [...m.criteria.map((c) => ({ value: String(c.value), label: c.label })), { value: 'none', label: 'Not classified' }] },
  { key: 'tdStatus', label: 'Target date', options: (m) => strings(m.tdStatuses) },
  { key: 'kpi', label: 'KPI', options: (m) => strings(m.kpis) },
  { key: 'ageBucket', label: 'Age', options: (m) => strings(m.ageBuckets) },
  { key: 'rfeTimeFrame', label: 'RFE time frame', options: (m) => m.rfeTimeFrameKinds.map((k) => ({ value: k, label: RFE_KIND_LABELS[k] ?? k })) },
  { key: 'workTeam', label: 'Work team', options: (m) => m.workTeams.map((t) => ({ value: t.code, label: t.name ? `${t.code} — ${t.name}` : t.code })) },
  { key: 'qfStage', label: 'QF stage', options: (m) => m.qfStages.map((s) => ({ value: String(s.stage), label: s.label })) },
  { key: 'breach', label: 'Deadline', options: () => [{ value: '2', label: 'Breached' }, { value: '1', label: 'Due soon' }, { value: '0', label: 'On track' }] },
];

/** Saved quick views: each one is a set of URL parameters. */
const VIEWS: { id: string; label: string; params: Record<string, string> }[] = [
  { id: 'all', label: 'All', params: {} },
  { id: 'unowned', label: 'Unowned', params: { unowned: '1' } },
  { id: 'rfe', label: 'RFE time breach', params: { rfeTimeFrame: 'breach' } },
  { id: 'td', label: 'Breached TD', params: { tdStatus: 'Breached' } },
  { id: 'mine', label: 'Mine', params: { mine: '1' } },
];

function FilterSelect({ def, meta, value, onChange }: { def: FilterDef; meta: Meta; value: string; onChange: (v: string) => void }) {
  const options = def.options(meta);
  const known = options.some((o) => o.value === value);
  const id = `f-${def.key}`;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">{def.label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {value && !known && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </NativeSelect>
    </div>
  );
}

const dash = (v: string | null | undefined) => v || '—';

function BulkSheet({ open, onOpenChange, codes, meta, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; codes: string[]; meta: Meta; onDone: () => void }) {
  const [ownerId, setOwnerId] = React.useState('');
  const [criterion, setCriterion] = React.useState('');
  const m = useMutation({
    mutationFn: () => apiPost<{ updated: number; notFound: string[] }>(OPS.workRequestsBulk, {
      codes, ...(ownerId ? { ownerId } : {}), ...(criterion ? { criterion: Number(criterion) } : {}),
    }),
    onSuccess: (r) => { toast.success(`${r.updated} work requests updated${r.notFound.length ? `, ${r.notFound.length} not found` : ''}.`); onDone(); onOpenChange(false); },
  });
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={`Change ${codes.length} work requests`} description="Only the fields you choose are changed.">
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-owner">Assign owner</Label>
          <NativeSelect id="bulk-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Leave as is</option>
            {meta.people.filter((p) => OWNER_ROLES.includes(p.role)).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="bulk-criterion">Set criterion</Label>
          <NativeSelect id="bulk-criterion" value={criterion} onChange={(e) => setCriterion(e.target.value)}>
            <option value="">Leave as is</option>
            {meta.criteria.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </NativeSelect>
        </div>
        {m.isError && <p role="alert" className="text-sm text-danger">{errorMessage(m.error)}</p>}
        <Button disabled={(!ownerId && !criterion) || m.isPending} onClick={() => m.mutate()}>Apply to {codes.length}</Button>
      </div>
    </FormSheet>
  );
}

export default function WorkRequestsPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user } = useSession();
  const desktop = useIsDesktop();
  const meta = useMeta();
  const [showFilters, setShowFilters] = React.useState(() => FILTER_KEYS.some((k) => params.has(k) && !['unowned', 'mine'].includes(k)));
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const isCoord = !!user && (COORD_ROLES as readonly string[]).includes(user.role);

  // Search box -> URL (debounced)
  const urlQ = params.get('q') ?? '';
  const [text, setText] = React.useState(urlQ);
  React.useEffect(() => setText(urlQ), [urlQ]);
  React.useEffect(() => {
    if (text === urlQ) return;
    const t = setTimeout(() => setParams((p) => { const n = new URLSearchParams(p); if (text) n.set('q', text); else n.delete('q'); return n; }, { replace: true }), 300);
    return () => clearTimeout(t);
  }, [text, urlQ, setParams]);

  const apiQuery = React.useMemo(() => {
    const o: Record<string, string> = { pageSize: '2000' };
    for (const k of [...FILTER_KEYS, 'q'] as string[]) { const v = params.get(k); if (v) o[k] = v; }
    return o;
  }, [params]);
  const q = useQuery({ queryKey: ['work-requests', apiQuery], queryFn: () => apiGet<WrList>(OPS.workRequests, { query: apiQuery }) });

  const setFilter = (key: string, value: string) => setParams((p) => { const n = new URLSearchParams(p); if (value) n.set(key, value); else n.delete(key); return n; });
  const applyView = (v: (typeof VIEWS)[number]) => setParams(new URLSearchParams(v.params));
  const activeView = VIEWS.find((v) => {
    const keys = [...FILTER_KEYS, 'q'].filter((k) => params.has(k));
    const want = Object.keys(v.params);
    return keys.length === want.length && want.every((k) => params.get(k) === v.params[k]);
  });
  const activeCount = [...FILTER_KEYS, 'q'].filter((k) => params.has(k)).length;

  const items = q.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((w) => selected.has(w.wrCode));

  const columns = React.useMemo<ColumnDef<WrView, unknown>[]>(() => {
    const cols: ColumnDef<WrView, unknown>[] = [];
    if (isCoord) {
      cols.push({
        id: 'select', size: 52, enableSorting: false,
        header: () => (
          <input type="checkbox" aria-label="Select all rows" className="size-5 accent-[var(--primary)]" checked={allSelected}
            onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((w) => w.wrCode)) : new Set())} />
        ),
        cell: ({ row }) => (
          <input type="checkbox" aria-label={`Select ${row.original.wrCode}`} className="size-5 accent-[var(--primary)]" checked={selected.has(row.original.wrCode)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(row.original.wrCode); else n.delete(row.original.wrCode); return n; })} />
        ),
      });
    }
    cols.push(
      { id: 'wrCode', header: 'WR code', size: 110, accessorFn: (w) => w.wrCode, cell: ({ row }) => <span className="font-mono font-semibold">{row.original.wrCode}</span> },
      { id: 'building', header: 'Building', size: 170, accessorFn: (w) => w.buildingName ?? '' },
      { id: 'problemType', header: 'Problem type', size: 170, accessorFn: (w) => w.problemType ?? '' },
      { id: 'priority', header: 'Priority', size: 110, accessorFn: (w) => w.priority ?? '' },
      { id: 'description', header: 'Description', size: 280, accessorFn: (w) => w.description ?? '' },
      { id: 'wrStatus', header: 'Marafiq status', size: 170, accessorFn: (w) => w.wrStatus ?? '' },
      { id: 'qf', header: 'QF stage', size: 230, accessorFn: (w) => w.descriptiveStatus ?? '' },
      { id: 'owner', header: 'Owner', size: 150, accessorFn: (w) => w.internal.ownerName ?? '', cell: ({ row }) => row.original.internal.ownerName ?? <span className="text-muted-foreground">Unowned</span> },
      { id: 'criterion', header: 'Criterion', size: 100, accessorFn: (w) => w.internal.criterion ?? 0, cell: ({ row }) => dash(row.original.internal.criterion ? String(row.original.internal.criterion) : null) },
      { id: 'contractorStatus', header: 'Contractor status', size: 230, accessorFn: (w) => w.internal.contractorStatus ?? '', cell: ({ row }) => dash(row.original.internal.contractorStatus) },
      { id: 'targetDate', header: 'Target date', size: 120, accessorFn: (w) => w.targetDate ?? '' , cell: ({ row }) => dash(row.original.targetDate) },
      { id: 'td', header: 'TD status', size: 130, accessorFn: (w) => w.computed.tdStatus, cell: ({ row }) => <StatusBadge tone={tdTone(row.original.computed.tdStatus)}>{row.original.computed.tdStatus}</StatusBadge> },
      { id: 'daysToBreach', header: 'Days to breach', size: 130, accessorFn: (w) => w.computed.daysToBreach ?? 0, cell: ({ row }) => dash(row.original.computed.daysToBreach === null ? null : String(row.original.computed.daysToBreach)) },
      { id: 'kpi', header: 'KPI', size: 130, accessorFn: (w) => w.computed.kpi, cell: ({ row }) => <StatusBadge tone={kpiTone(row.original.computed.kpi)}>{row.original.computed.kpi}</StatusBadge> },
      { id: 'rfe', header: 'RFE time frame', size: 200, accessorFn: (w) => w.computed.rfeTimeFrame, cell: ({ row }) => <StatusBadge tone={rfeTone(row.original.computed.rfeTimeFrameKind)}>{row.original.computed.rfeTimeFrame}</StatusBadge> },
      { id: 'age', header: 'Age (days)', size: 110, accessorFn: (w) => w.computed.daysSinceRequested ?? -1, cell: ({ row }) => dash(row.original.computed.daysSinceRequested === null ? null : String(row.original.computed.daysSinceRequested)) },
      { id: 'month', header: 'Age bucket', size: 190, accessorFn: (w) => w.computed.month },
      { id: 'discipline', header: 'Discipline', size: 140, accessorFn: (w) => w.computed.discipline },
      { id: 'zone', header: 'Zone', size: 130, accessorFn: (w) => w.computed.zone },
      { id: 'facility', header: 'Facility', size: 150, accessorFn: (w) => w.computed.facility },
      { id: 'requested', header: 'Requested', size: 120, accessorFn: (w) => w.dateRequested ?? '', cell: ({ row }) => dash(row.original.dateRequested) },
    );
    return cols;
  }, [isCoord, items, selected, allSelected]);

  return (
    <>
      <PageHeader
        title="Work requests"
        description={q.data ? `${q.data.total.toLocaleString()} work requests${q.data.total > q.data.items.length ? ` (first ${q.data.items.length.toLocaleString()} shown; narrow the filters)` : ''}` : undefined}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick views">
        {VIEWS.map((v) => (
          <Button key={v.id} size="sm" variant={activeView?.id === v.id ? 'default' : 'outline'} aria-pressed={activeView?.id === v.id} onClick={() => applyView(v)}>{v.label}</Button>
        ))}
        <div className="relative ms-auto min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search code, building, text…" aria-label="Search work requests" className="ps-9" />
        </div>
        <Button size="sm" variant="outline" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}><Filter className="size-4" aria-hidden /> Filters{activeCount ? ` (${activeCount})` : ''}</Button>
        {activeCount > 0 && <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams())}><X className="size-4" aria-hidden /> Clear</Button>}
      </div>

      {showFilters && meta.data && (
        <div className="mb-3 grid grid-cols-2 gap-3 rounded-xl border bg-card p-3 md:grid-cols-4 xl:grid-cols-6" aria-label="Filters">
          {FILTERS.map((f) => <FilterSelect key={f.key} def={f} meta={meta.data!} value={params.get(f.key) ?? ''} onChange={(v) => setFilter(f.key, v)} />)}
        </div>
      )}

      {isCoord && selected.size > 0 && meta.data && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary-soft/40 p-3" role="region" aria-label="Bulk actions">
          <span className="text-sm font-semibold">{selected.size} selected</span>
          <Button size="sm" onClick={() => setBulkOpen(true)}><Users className="size-4" aria-hidden /> Assign owner / set criterion</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {q.isPending ? <ListSkeleton rows={8} />
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : items.length === 0 ? <EmptyState illustration="search" title="No work requests match" description={activeCount ? 'Try removing a filter.' : 'Upload the Marafiq exports on the Imports page.'} action={activeCount ? <Button variant="outline" onClick={() => setParams(new URLSearchParams())}>Clear filters</Button> : undefined} />
        : (
          <DataTable
            aria-label="Work requests"
            columns={columns}
            data={items}
            searchable={false}
            columnFilters={false}
            pinStart={['wrCode']}
            getRowId={(w) => w.wrCode}
            height={desktop ? 620 : 480}
            onRowClick={(w) => nav(`/work-requests/${w.wrCode}`)}
            className={cn(desktop && 'min-h-0')}
          />
        )}

      {meta.data && <BulkSheet open={bulkOpen} onOpenChange={setBulkOpen} codes={[...selected]} meta={meta.data} onDone={() => { setSelected(new Set()); void qc.invalidateQueries({ queryKey: ['work-requests'] }); }} />}
    </>
  );
}
