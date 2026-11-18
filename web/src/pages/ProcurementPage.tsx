import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/PageHeader';
import { KpiTile } from '@/components/KpiTile';
import { QueryBoundary } from '@/components/admin/kit';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { COORD_LEVEL, mrListUrl } from '@/lib/mr';
import { useSession } from '@/lib/session';
import type { ProcurementSummary } from '@/lib/types';

/**
 * Procurement dashboard: one tile per MR section, each opening the filtered list.
 * Coming next (not shown in the UI yet): Petty Cash and LPO sections get their own tiles here.
 */
export function ProcurementView({ data }: { data: ProcurementSummary }) {
  const nav = useNavigate();
  const go = (filters: Record<string, string>) => () => nav(mrListUrl(filters));
  return (
    <div className="grid gap-4">
      <section aria-label="Material requests" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="New Material Requests" value={data.new} tone={data.new ? 'warning' : 'neutral'} onClick={go({ status: 'submitted' })} />
        <KpiTile label="Pending Material Requests" value={data.pending} onClick={go({ status: 'accepted' })} />
        <KpiTile label="Vendor Enquiries" value={data.enquiry} onClick={go({ status: 'enquiry' })} />
        <KpiTile label="Quotations Received" value={data.quoted} onClick={go({ status: 'quoted' })} />
        <KpiTile label="Materials Ordered" value={data.ordered} onClick={go({ status: 'ordered' })} />
        <KpiTile label="Materials Delivered" value={data.delivered} tone={data.delivered ? 'success' : 'neutral'} onClick={go({ status: 'delivered' })} />
        <KpiTile label="Rejected" value={data.rejected} onClick={go({ status: 'rejected' })} />
        <KpiTile label="Overdue" value={data.overdue} tone={data.overdue ? 'danger' : 'neutral'} onClick={go({ overdue: '1' })} />
      </section>
      <p className="text-sm text-muted-foreground" data-testid="closed-this-month">
        <Link to={mrListUrl({ status: 'closed' })} className="underline">{data.closedThisMonth} closed this month</Link>
      </p>
    </div>
  );
}

export default function ProcurementPage() {
  const { user } = useSession();
  const q = useQuery({ queryKey: ['procurement-summary'], queryFn: () => apiGet<ProcurementSummary>(OPS.procurementSummary) });
  const canRaise = user ? (COORD_LEVEL as readonly string[]).includes(user.role) : false;
  return (
    <>
      <PageHeader
        title="Procurement"
        description="Material requests from site, from New to Delivered."
        actions={
          <>
            <Button asChild variant="outline"><Link to="/procurement/mr">All requests</Link></Button>
            {canRaise && <Button asChild><Link to="/procurement/mr/new"><PackagePlus className="size-4" aria-hidden /> New request</Link></Button>}
          </>
        }
      />
      <QueryBoundary query={q} skeleton={<div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}>
        {(d) => <ProcurementView data={d} />}
      </QueryBoundary>
    </>
  );
}
