import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PackagePlus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { MrStatusBadge } from '@/components/ops/MrStatusBadge';
import { NativeSelect, QueryBoundary } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { COORD_LEVEL, MR_STATUS, MR_STATUS_ORDER, qr } from '@/lib/mr';
import { fmtDate } from '@/lib/ops';
import { useSession } from '@/lib/session';
import type { MrListItem } from '@/lib/types';

export function MrListView({ items }: { items: MrListItem[] }) {
  if (items.length === 0) return <EmptyState illustration="search" title="No material requests" description="Nothing matches these filters." />;
  return (
    <ul className="grid gap-2" aria-label="Material requests">
      {items.map((m) => (
        <li key={m.id}>
          <Card>
            <CardContent className="p-0">
              <Link to={`/procurement/mr/${m.id}`} className="grid gap-1 rounded-lg p-3 hover:bg-muted/50">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{m.mrCode}</span>
                  <MrStatusBadge status={m.status} />
                  {m.overdue && <StatusBadge tone="danger">Overdue</StatusBadge>}
                  {m.wrCode && <span className="font-mono text-xs text-muted-foreground">WR {m.wrCode}</span>}
                </span>
                <span className="truncate text-sm">{m.firstDescription}{m.lines > 1 ? ` +${m.lines - 1} more` : ''}</span>
                <span className="text-xs text-muted-foreground">
                  {[m.buildingName ?? m.facility, `Requested ${fmtDate(m.dateRequested)}`, m.requestedByName && `by ${m.requestedByName}`, m.assignedToName && `handled by ${m.assignedToName}`].filter(Boolean).join(' · ')}
                </span>
                {(m.vendorName || m.quotedAmount !== null || m.expectedDelivery) && (
                  <span className="text-xs text-muted-foreground">
                    {[m.vendorName, m.quotedAmount !== null ? qr(m.quotedAmount) : null, m.expectedDelivery ? `delivery ${fmtDate(m.expectedDelivery)}` : null].filter(Boolean).join(' · ')}
                  </span>
                )}
              </Link>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** /procurement/mr: filter by status, search by MR no / WR code / description, "Mine" toggle. Filters live in the URL. */
export default function MrListPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const mine = params.get('mine') === '1';
  const overdue = params.get('overdue') === '1';
  const wr = params.get('wr') ?? '';
  const [text, setText] = React.useState(params.get('q') ?? '');
  const deferred = React.useDeferredValue(text.trim());
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const canRaise = user ? (COORD_LEVEL as readonly string[]).includes(user.role) : false;
  const q = useQuery({
    queryKey: ['mrs', { status, mine, overdue, wr, q: deferred }],
    queryFn: () => apiGet<{ items: MrListItem[] }>(OPS.mrs, { query: { status: status || undefined, mine: mine ? 1 : undefined, overdue: overdue ? 1 : undefined, wr: wr || undefined, q: deferred || undefined } }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Material requests"
        actions={canRaise ? <Button asChild><Link to="/procurement/mr/new"><PackagePlus className="size-4" aria-hidden /> New request</Link></Button> : undefined}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="mr-search">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="mr-search" type="search" value={text} placeholder="MR no, WR code or item" onChange={(e) => setText(e.target.value)} onBlur={() => set('q', text.trim())} className="ps-9 text-base" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="mr-status">Status</Label>
          <NativeSelect id="mr-status" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {MR_STATUS_ORDER.map((s) => <option key={s} value={s}>{MR_STATUS[s].label}</option>)}
          </NativeSelect>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Switch id="mr-mine" checked={mine} onCheckedChange={(v) => set('mine', v ? '1' : '')} />
          <Label htmlFor="mr-mine">Mine</Label>
        </div>
      </div>
      {(overdue || wr) && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {overdue && <Button size="sm" variant="outline" onClick={() => set('overdue', '')}>Overdue only <X className="size-3.5" aria-hidden /></Button>}
          {wr && <Button size="sm" variant="outline" onClick={() => set('wr', '')}>WR {wr} <X className="size-3.5" aria-hidden /></Button>}
        </p>
      )}
      <QueryBoundary query={q} skeleton={<div className="grid gap-2" aria-busy="true" aria-label="Loading"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        {(d) => <MrListView items={d.items} />}
      </QueryBoundary>
    </>
  );
}
