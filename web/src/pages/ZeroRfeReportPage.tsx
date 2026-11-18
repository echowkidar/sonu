import * as React from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import { KpiTile } from '@/components/KpiTile';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { QueryBoundary } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { fmtDate } from '@/lib/ops';
import type { ZeroRfeReport } from '@/lib/types';

const qr = (n: number | null) => (n === null ? '—' : `QR ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

export function ZeroRfeReportView({ data }: { data: ZeroRfeReport }) {
  const t = data.totals;
  return (
    <div className="grid gap-4">
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="0 RFE jobs" value={t.jobs} />
        <KpiTile label="Expected (QR)" value={t.expected ?? 0} />
        <KpiTile label="Spent (QR)" value={t.spent ?? 0} />
        <KpiTile label="Without receipt" value={t.withoutReceipt} tone={t.withoutReceipt ? 'warning' : 'neutral'} />
      </section>
      {t.expected !== null && <p className="text-sm text-muted-foreground" data-testid="report-money">Expected {qr(t.expected)} · spent {qr(t.spent)}</p>}
      {data.items.length === 0 ? (
        <EmptyState illustration="inbox" title="No 0 RFE jobs this month" description="Jobs a supervisor converts to 0 RFE show here with their local purchases." />
      ) : (
        <ul className="grid gap-2" aria-label="0 RFE jobs">
          {data.items.map((i) => (
            <li key={i.wrCode}>
              <Card>
                <CardContent className="p-0">
                  <Link to={`/work-requests/${i.wrCode}`} className="grid gap-1 rounded-lg p-3 hover:bg-muted/50">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{i.wrCode}</span>
                      {i.receipts === 0 ? <StatusBadge tone="warning">No receipt</StatusBadge> : <StatusBadge tone="success">{i.receipts} {i.receipts === 1 ? 'receipt' : 'receipts'}</StatusBadge>}
                      <span className="text-xs text-muted-foreground">{i.qfStageLabel}</span>
                    </span>
                    <span className="truncate text-sm">{[i.buildingName, i.description].filter(Boolean).join(' — ')}</span>
                    <span className="text-xs text-muted-foreground">
                      {[i.zone, i.discipline, `Converted ${fmtDate(i.convertedAt)}${i.convertedByName ? ` by ${i.convertedByName}` : ''}`].filter(Boolean).join(' · ')}
                    </span>
                    <span className="text-sm tabular-nums">Expected {qr(i.expected)} · spent {qr(i.spent)} · {i.purchases} {i.purchases === 1 ? 'purchase' : 'purchases'}</span>
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ZeroRfeReportPage() {
  const [month, setMonth] = React.useState('');
  const q = useQuery({ queryKey: ['zero-rfe', month], queryFn: () => apiGet<ZeroRfeReport>(OPS.zeroRfeReport, { query: { month: month || undefined } }) });
  const shown = month || q.data?.month || '';
  return (
    <>
      <PageHeader
        title="0 RFE report"
        description="Jobs bought locally with petty cash, with no RFE sent to QF. Attach every receipt, then send the bills to QF to release the amount."
        actions={
          <div className="grid gap-1">
            <Label htmlFor="zr-month" className="text-xs">Month</Label>
            <Input id="zr-month" type="month" value={shown} onChange={(e) => setMonth(e.target.value)} className="w-44" />
          </div>
        }
      />
      <QueryBoundary query={q} skeleton={<div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>}>
        {(d) => <ZeroRfeReportView data={d} />}
      </QueryBoundary>
    </>
  );
}
