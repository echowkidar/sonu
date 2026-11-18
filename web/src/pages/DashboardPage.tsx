import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/PageHeader';
import { KpiTile } from '@/components/KpiTile';
import { EmptyState } from '@/components/EmptyState';
import { DayCounter } from '@/components/DayCounter';
import { QueryBoundary } from '@/components/admin/kit';
import { StatusMatrix } from '@/components/ops/StatusMatrix';
import { apiBlob, apiGet, saveBlob } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { RFE_KIND_LABELS, wrListUrl } from '@/lib/ops';
import type { DashboardData, DeadlineCard } from '@/lib/types';

function DashSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** A split (age buckets, KPI, TD, RFE time frame): every line is a link to the filtered list. */
function Split({ title, entries, filterKey, labels }: { title: string; entries: Record<string, number>; filterKey: string; labels?: Record<string, string> }) {
  const list = Object.entries(entries);
  const max = Math.max(1, ...list.map(([, n]) => n));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <ul className="grid gap-1.5">
          {list.map(([k, n]) => (
            <li key={k}>
              <Link to={wrListUrl({ [filterKey]: k })} className="grid min-h-11 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 hover:bg-muted/60" aria-label={`${labels?.[k] ?? k}: ${n}`}>
                <span className="truncate text-sm">{labels?.[k] ?? k}</span>
                <span className="font-semibold tabular-nums">{n.toLocaleString()}</span>
                <span className="col-span-2 h-1.5 rounded-full bg-muted" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${(n / max) * 100}%` }} /></span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ActionList({ title, count, items, to, danger, limit = 8, className, subtitle }: {
  title: string; count: number; items: DeadlineCard[]; to?: string; danger?: boolean; limit?: number; className?: string; subtitle?: string;
}) {
  const pill = danger ? 'bg-destructive text-destructive-foreground' : 'bg-muted';
  return (
    <Card className={[danger ? 'border-destructive/60' : '', className ?? ''].join(' ')}>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <CardTitle className={danger ? 'text-destructive' : undefined}>{title}</CardTitle>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {to ? <Link to={to} className={`rounded-full px-2.5 py-0.5 text-sm font-semibold hover:underline ${pill}`} aria-label={`${title}: ${count}`}>{count}</Link> : <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${pill}`}>{count}</span>}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : (
          <ul className={`grid gap-1 ${limit > 8 ? 'md:grid-cols-2' : ''}`}>
            {items.slice(0, limit).map((c, i) => (
              <li key={c.wrCode}>
                <Link to={`/work-requests/${c.wrCode}`} className="grid min-h-11 gap-0.5 rounded-lg px-2 py-1 hover:bg-muted/60">
                  <span className="flex flex-wrap items-center gap-2">
                    {danger && <span className="text-xs font-semibold tabular-nums text-muted-foreground">#{i + 1}</span>}
                    <span className="font-mono text-sm font-semibold">{c.wrCode}</span>
                    {c.overdueDays !== undefined && <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">{c.overdueDays > 0 ? `${c.overdueDays} ${c.overdueDays === 1 ? 'day' : 'days'} past target date` : 'Target date today'}</span>}
                    {c.ownerName ? <span className="text-xs text-muted-foreground">Owner: {c.ownerName}</span> : danger && <span className="text-xs font-semibold text-warning">No owner</span>}
                    {c.deadline && <DayCounter day={c.deadline.dayNumber} of={c.deadline.limit} />}</span>
                  <span className="truncate text-sm text-muted-foreground">{[c.buildingName, c.description].filter(Boolean).join(' — ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardView({ data }: { data: DashboardData }) {
  const nav = useNavigate();
  const n = data.needsActionToday;
  return (
    <div className="grid grid-cols-1 gap-5">
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Total outstanding" value={data.totalOutstanding} onClick={() => nav(wrListUrl({}))} />
        <KpiTile label="Breached (target date)" value={data.breached} tone={data.breached ? 'danger' : 'neutral'} onClick={() => nav(wrListUrl({ tdStatus: 'Breached' }))} />
        <KpiTile label="Backlog KPI" value={data.backlogKpi} tone={data.backlogKpi ? 'warning' : 'neutral'} onClick={() => nav(wrListUrl({ kpi: 'Backlog KPI' }))} />
        <KpiTile label="Average age (days)" value={Math.round(data.averageAge)} />
      </section>

      {data.descriptiveStages && (
        <section aria-label="QF stages" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {data.descriptiveStages.map((s) => (
            <KpiTile key={s.stage} label={s.label} value={s.count} onClick={() => nav(wrListUrl({ qfStage: s.stage }))} />
          ))}
        </section>
      )}

      {data.zeroRfe && (
        <Link to="/zero-rfe" className="rounded-lg border bg-card px-4 py-3 text-sm hover:bg-muted/50" data-testid="zero-rfe-card">
          <span className="font-semibold">0 RFE this month:</span>{' '}
          {data.zeroRfe.monthJobs} {data.zeroRfe.monthJobs === 1 ? 'job' : 'jobs'}
          {data.zeroRfe.monthSpent != null && <> · QR {data.zeroRfe.monthSpent.toLocaleString(undefined, { maximumFractionDigits: 2 })} spent</>}
          {' '}· {data.zeroRfe.withoutReceipt} without receipt
        </Link>
      )}

      {n.breachedTd && (
        <section aria-label="Top priority">
          <ActionList
            danger
            limit={10}
            title="Breached — top priority"
            subtitle="Past the agreed target date, most overdue first"
            count={n.breachedTdCount ?? n.breachedTd.length}
            items={n.breachedTd}
            to={wrListUrl({ tdStatus: 'Breached' })}
          />
        </section>
      )}

      <section aria-label="Needs action today" className="grid gap-3 lg:grid-cols-3">
        <ActionList title="Deadlines due today" count={n.deadlinesTodayCount} items={n.deadlinesToday} to={wrListUrl({ breach: 1 })} />
        <ActionList title="Not owned" count={n.unownedCount} items={n.unowned} to={wrListUrl({ unowned: 1 })} />
        <ActionList title="Returned by QF" count={n.returnsCount} items={n.returns} to={wrListUrl({ qfStage: '4,7' })} />
        <Card className="lg:col-span-3">
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
            <Link className="font-medium text-primary hover:underline" to={wrListUrl({ breach: 2 })}>Breached deadlines: <span className="tabular-nums">{n.breachedDeadlines}</span></Link>
            <span>Unanswered QF comments: <strong className="tabular-nums">{n.unansweredComments}</strong></span>
          </CardContent>
        </Card>
      </section>

      <StatusMatrix title="Status by discipline" matrix={data.byDiscipline} dimension="discipline" />
      <StatusMatrix title="Status by zone" matrix={data.byZone} dimension="zone" />
      <StatusMatrix title="Status by facility" matrix={data.byFacility} dimension="facility" />

      <section aria-label="Splits" className="grid gap-3 md:grid-cols-2">
        <Split title="Age" entries={data.ageBuckets} filterKey="ageBucket" />
        <Split title="KPI" entries={data.kpiSplit} filterKey="kpi" />
        <Split title="Target date" entries={data.tdSplit} filterKey="tdStatus" />
        <Split title="RFE time frame" entries={data.rfeTimeFrameSplit} filterKey="rfeTimeFrame" labels={RFE_KIND_LABELS} />
      </section>
    </div>
  );
}

export default function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => apiGet<DashboardData>(OPS.dashboard) });
  const [busy, setBusy] = React.useState(false);

  async function exportMaster() {
    setBusy(true);
    try {
      const { blob, fileName } = await apiBlob(OPS.masterExport);
      saveBlob(blob, fileName ?? 'sonu-master.xlsx');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={q.data?.today ? `Open work requests as of ${q.data.today}` : undefined}
        actions={
          <Button variant="outline" onClick={() => void exportMaster()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />} Export Master workbook
          </Button>
        }
      />
      <QueryBoundary
        query={q}
        skeleton={<DashSkeleton />}
        isEmpty={(d) => d.totalOutstanding === 0 && !d.dataAsOf}
        empty={<EmptyState illustration="inbox" title="No data yet" description="Upload the Marafiq exports on the Imports page and the dashboard fills in." action={<Button asChild><Link to="/imports">Go to Imports</Link></Button>} />}
      >
        {(d) => <DashboardView data={d} />}
      </QueryBoundary>
    </>
  );
}
