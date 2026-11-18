import { Link } from 'react-router';
import { PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MrStatusBadge } from '@/components/ops/MrStatusBadge';
import { canRaiseMr } from '@/lib/mr';
import { fmtDate } from '@/lib/ops';
import type { WrDetail } from '@/lib/types';

/** WR detail: the material requests of this work request, with a "Raise MR" button for the roles that may. */
export function MaterialRequestsCard({ wr, role }: { wr: WrDetail; role: string }) {
  const list = wr.materialRequests ?? [];
  const canRaise = canRaiseMr(role) && !wr.goneAt;
  if (!list.length && !canRaise) return null;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Material requests</CardTitle>
        {canRaise && (
          <Button asChild size="sm"><Link to={`/procurement/mr/new?wr=${encodeURIComponent(wr.wrCode)}`}><PackagePlus className="size-4" aria-hidden /> Raise MR</Link></Button>
        )}
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No material requests for this work request yet.</p>
        ) : (
          <ul className="grid gap-2">
            {list.map((m) => (
              <li key={m.id}>
                <Link to={`/procurement/mr/${m.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm hover:bg-muted/50">
                  <span className="font-mono font-semibold">{m.mrCode}</span>
                  <MrStatusBadge status={m.status} />
                  <span className="text-muted-foreground">
                    {[`${m.lines} ${m.lines === 1 ? 'line' : 'lines'}`, fmtDate(m.dateRequested), m.requestedByName].filter(Boolean).join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
