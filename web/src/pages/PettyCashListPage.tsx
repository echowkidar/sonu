import { Link, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { PettyCashStatusBadge } from '@/components/ops/PettyCashStatusBadge';
import { NativeSelect, QueryBoundary } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { fmtDate } from '@/lib/ops';
import { canPrepareClaim, monthLabel, PC_STATUS, PC_STATUS_ORDER, qar } from '@/lib/pettyCash';
import { useSession } from '@/lib/session';
import type { PettyCashListItem } from '@/lib/types';

/** Status filters that group several statuses (the dashboard tiles link to these). */
const STATUS_GROUPS: [string, string][] = [
  ['draft,returned', 'Draft or returned (with the preparer)'],
  ['submitted,reviewed', 'Waiting for approval (Admin or Manager)'],
  ['approved,rejected', 'Approved or rejected'],
];

export function PettyCashListView({ items }: { items: PettyCashListItem[] }) {
  if (items.length === 0) return <EmptyState illustration="search" title="No petty cash claims" description="Nothing matches these filters." />;
  return (
    <ul className="grid gap-2" aria-label="Petty cash claims">
      {items.map((c) => (
        <li key={c.id}>
          <Card>
            <CardContent className="p-0">
              <Link to={`/petty-cash/${c.id}`} className="grid gap-1 rounded-lg p-3 hover:bg-muted/50">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{c.code}</span>
                  <PettyCashStatusBadge status={c.status} />
                  <span className="text-sm text-muted-foreground">{monthLabel(c.month)}</span>
                </span>
                <span className="text-sm tabular-nums">
                  {qar(c.totalAmount)}{c.approvedAmount !== null ? ` · approved ${qar(c.approvedAmount)}` : ''} · {c.lines} {c.lines === 1 ? 'line' : 'lines'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[c.projectName, c.purchaseType === 'services' ? 'Services' : 'Materials', c.preparedByName && `prepared by ${c.preparedByName}`, `updated ${fmtDate(c.updatedAt)}`].filter(Boolean).join(' · ')}
                </span>
                {c.pending.label && <span className="text-xs text-muted-foreground">Waiting for: {c.pending.label}</span>}
              </Link>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** /petty-cash: filter by status and month, "Mine" toggle. Filters live in the URL. */
export default function PettyCashListPage() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const month = params.get('month') ?? '';
  const mine = params.get('mine') === '1';
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const q = useQuery({
    queryKey: ['petty-cash-list', { status, month, mine }],
    queryFn: () => apiGet<{ items: PettyCashListItem[] }>(OPS.pettyCashClaims, { query: { status: status || undefined, month: month || undefined, mine: mine ? 1 : undefined } }),
    placeholderData: keepPreviousData,
  });
  const known = new Set<string>([...PC_STATUS_ORDER, ...STATUS_GROUPS.map(([v]) => v)]);
  return (
    <>
      <PageHeader
        title="Petty cash claims"
        description="Expense petty cash reimbursement claims: prepared by the supervisor, reviewed by the Admin, approved by the Project Manager."
        actions={user && canPrepareClaim(user.role) ? <Button asChild><Link to="/petty-cash/new"><Plus className="size-4" aria-hidden /> New claim</Link></Button> : undefined}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="pc-status">Status</Label>
          <NativeSelect id="pc-status" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All statuses</option>
            {PC_STATUS_ORDER.map((s) => <option key={s} value={s}>{PC_STATUS[s].label}</option>)}
            {STATUS_GROUPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            {status && !known.has(status) && <option value={status}>{status}</option>}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pc-month">Month</Label>
          <Input id="pc-month" type="month" value={month} onChange={(e) => set('month', e.target.value)} className="text-base" />
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <Switch id="pc-mine" checked={mine} onCheckedChange={(v) => set('mine', v ? '1' : '')} />
          <Label htmlFor="pc-mine">Mine</Label>
        </div>
      </div>
      <QueryBoundary query={q} skeleton={<div className="grid gap-2" aria-busy="true" aria-label="Loading"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        {(d) => <PettyCashListView items={d.items} />}
      </QueryBoundary>
    </>
  );
}
