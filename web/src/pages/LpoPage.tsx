import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileText, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { LpoDialog } from '@/components/ops/LpoCard';
import { ListSkeleton, QueryBoundary } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { qr } from '@/lib/mr';
import { fmtDate } from '@/lib/ops';
import type { Lpo, LpoPendingItem } from '@/lib/types';

export function LpoPendingList({ items }: { items: LpoPendingItem[] }) {
  const [adding, setAdding] = React.useState<string | null>(null);
  if (items.length === 0) return <EmptyState illustration="search" title="No LPO pending" description="Every work request with an approved RFE has its LPO." />;
  return (
    <>
      <ul className="grid gap-2" aria-label="Work requests waiting for an LPO">
        {items.map((p) => (
          <li key={p.wrCode}>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="grid min-w-0 gap-0.5 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link to={`/work-requests/${encodeURIComponent(p.wrCode)}`} className="font-mono font-semibold underline">WR {p.wrCode}</Link>
                    <StatusBadge tone={p.daysSinceApproval > 14 ? 'danger' : p.daysSinceApproval > 7 ? 'warning' : 'info'}>{p.daysSinceApproval} {p.daysSinceApproval === 1 ? 'day' : 'days'} since approval</StatusBadge>
                  </span>
                  <span className="truncate">{p.description ?? '—'}</span>
                  <span className="text-xs text-muted-foreground">{[p.buildingName, `RFE approved ${fmtDate(p.approvedOn)}`, p.rfeAmount != null ? `RFE ${qr(p.rfeAmount)}` : null].filter(Boolean).join(' · ')}</span>
                </div>
                <Button size="sm" aria-label={`Add LPO for WR ${p.wrCode}`} onClick={() => setAdding(p.wrCode)}><Plus className="size-4" aria-hidden /> Add LPO</Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {adding && <LpoDialog open onOpenChange={(v) => { if (!v) setAdding(null); }} wrCode={adding} />}
    </>
  );
}

export function LpoReleasedList({ items }: { items: Lpo[] }) {
  if (items.length === 0) return <EmptyState illustration="search" title="No LPOs" description="Nothing matches this search." />;
  return (
    <ul className="grid gap-2" aria-label="Released LPOs">
      {items.map((l) => (
        <li key={l.id}>
          <Card>
            <CardContent className="grid gap-1 p-3 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{l.lpoNo}</span>
                <StatusBadge tone={l.status === 'cancelled' ? 'neutral' : 'success'}>{l.status === 'cancelled' ? 'Cancelled' : 'Released'}</StatusBadge>
                <Link to={`/work-requests/${encodeURIComponent(l.wrCode)}`} className="font-mono text-xs underline">WR {l.wrCode}</Link>
                {l.mrCode && l.materialRequestId && <Link to={`/procurement/mr/${l.materialRequestId}`} className="font-mono text-xs underline">{l.mrCode}</Link>}
              </span>
              <span className="text-xs text-muted-foreground">{[fmtDate(l.issueDate), l.vendorName, l.approvedAmount !== null ? qr(l.approvedAmount) : null].filter(Boolean).join(' · ')}</span>
              {l.documents.map((d) => (
                <a key={d.id} href={OPS.attachment(d.id)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline"><FileText className="size-3.5" aria-hidden /> {d.fileName}</a>
              ))}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** /procurement/lpo: "Pending" (work requests with an approved RFE and no LPO) and "Released" (search the LPO list). */
export default function LpoPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'pending' ? 'pending' : 'released';
  const [text, setText] = React.useState(params.get('q') ?? '');
  const [q, setQ] = React.useState(text.trim());
  React.useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const pending = useQuery({ queryKey: ['lpo-pending'], queryFn: () => apiGet<{ items: LpoPendingItem[] }>(OPS.lpoPending) });
  const released = useQuery({ queryKey: ['lpo', 'released', q], queryFn: () => apiGet<{ items: Lpo[] }>(OPS.lpos, { query: q ? { q } : {} }), placeholderData: keepPreviousData });
  const setView = (v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'pending') n.set('view', 'pending'); else n.delete('view'); return n; }, { replace: true });
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/procurement"><ArrowLeft className="size-4" aria-hidden /> Procurement</Link></Button>
      <PageHeader title="LPO" description="Local purchase orders: work requests waiting for one, and the ones released." />
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="pending">Pending{pending.data ? ` (${pending.data.items.length})` : ''}</TabsTrigger>
          <TabsTrigger value="released">Released</TabsTrigger>
        </TabsList>
        <TabsContent value="pending" className="mt-4">
          <QueryBoundary query={pending} skeleton={<ListSkeleton />}>{(d) => <LpoPendingList items={d.items} />}</QueryBoundary>
        </TabsContent>
        <TabsContent value="released" className="mt-4 grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="lpo-search">Search LPO number, vendor or WR</Label>
            <div className="relative"><Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground" aria-hidden /><Input id="lpo-search" className="ps-9" value={text} onChange={(e) => setText(e.target.value)} /></div>
          </div>
          <QueryBoundary query={released} skeleton={<ListSkeleton />}>{(d) => <LpoReleasedList items={d.items} />}</QueryBoundary>
        </TabsContent>
      </Tabs>
    </>
  );
}
