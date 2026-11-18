import * as React from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Copy, ExternalLink, FileText, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DayCounter } from '@/components/DayCounter';
import { StatusBadge } from '@/components/StatusBadge';
import { Timeline, type TimelineItem } from '@/components/Timeline';
import { ShareWhatsApp } from '@/components/ShareWhatsApp';
import { ErrorState } from '@/components/admin/kit';
import { SonuPanel } from '@/components/ops/SonuPanel';
import { AssignSheet } from '@/components/ops/AssignSheet';
import { LocalPurchasesCard } from '@/components/ops/ZeroRfe';
import { MaterialRequestsCard } from '@/components/ops/MrCard';
import { RfeLpoCard } from '@/components/ops/LpoCard';
import { RfeEditor } from '@/components/ops/RfeEditor';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { formatDateTime } from '@/lib/forms';
import { fmtDate, kpiTone, rfeTone, tdTone, useMeta } from '@/lib/ops';
import { useSession } from '@/lib/session';
import type { TimelineEvent, WrDetail } from '@/lib/types';

const humanize = (t: string) => { const s = t.replace(/[._]/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

function eventNote(e: TimelineEvent): string | null {
  const p = e.payload ?? {};
  const parts: string[] = [];
  if (e.type === 'stage' && (p.from !== undefined || p.to !== undefined)) parts.push(`Stage ${String(p.from ?? '—')} → ${String(p.to ?? '—')}`);
  if (typeof p.assignee === 'string') parts.push(`Assigned to ${p.assignee}`);
  if (typeof p.note === 'string' && p.note) parts.push(p.note);
  if (typeof p.text === 'string' && p.text) parts.push(p.text);
  return parts.join(' · ') || null;
}

export function toTimelineItems(events: TimelineEvent[]): TimelineItem[] {
  return [...events].reverse().map((e) => {
    const sonu = e.source === 'sonu';
    const note = eventNote(e);
    return {
      id: `${e.kind}-${e.id}`,
      title: humanize(e.type),
      at: formatDateTime(e.at),
      state: 'done' as const,
      note: (
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={sonu ? 'default' : 'neutral'} data-testid="event-source">{sonu ? 'SONU' : 'Marafiq'}</Badge>
          {e.userName && <span>{e.userName}</span>}
          {note && <span>{note}</span>}
        </span>
      ),
    };
  });
}

function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-medium">{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

const MONEY_LABELS: Record<string, string> = {
  demandNote: 'Demand note', prNo: 'PR no.', prDate: 'PR date', prStatus: 'PR status', poNo: 'PO no.', poDate: 'PO date', poStatus: 'PO status',
  wccNo: 'WCC no.', wccDate: 'WCC date', wccStatus: 'WCC status', invoiceNo: 'Invoice no.', invoiceStatus: 'Invoice status',
};

export function WrDetailView({ wr }: { wr: WrDetail }) {
  const { user } = useSession();
  const meta = useMeta();
  const [assignOpen, setAssignOpen] = React.useState(false);
  const role = user?.role ?? '';
  const canAssign = ['supervisor', 'coordinator', 'manager', 'contractor_admin'].includes(role);
  const canRfe = ['supervisor', 'purchasing', 'coordinator', 'manager', 'contractor_admin'].includes(role);
  const c = wr.computed;
  const shareText = `WR ${wr.wrCode}${wr.buildingName ? ` — ${wr.buildingName}` : ''}\n${wr.description ?? ''}\n${window.location.origin}/work-requests/${wr.wrCode}`;

  async function copy() {
    try { await navigator.clipboard.writeText(wr.wrCode); toast.success(`Copied ${wr.wrCode}`); } catch { toast.error('Could not copy. Select the code and copy it.'); }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-bold">{wr.wrCode}</h1>
            <Button size="sm" variant="outline" onClick={() => void copy()} aria-label={`Copy work request code ${wr.wrCode}`}><Copy className="size-4" aria-hidden /> Copy</Button>
            {wr.descriptiveStatus && <Badge variant="info">{wr.descriptiveStatus}</Badge>}
            {wr.goneAt && <StatusBadge tone="neutral">No longer in Marafiq lists</StatusBadge>}
          </div>
          <p className="text-base">{wr.description || <span className="text-muted-foreground">No description</span>}</p>
          <Facts items={[
            ['Building', [wr.buildingName ?? wr.buildingCode, wr.floorCode && `floor ${wr.floorCode}`, wr.roomCode && `room ${wr.roomCode}`].filter(Boolean).join(', ') || null],
            ['Problem type', wr.problemType], ['Priority', wr.priority], ['Target date', fmtDate(wr.targetDate)],
            ['Marafiq status', wr.wrStatus], ['Work team', wr.workTeamCode], ['Requested', fmtDate(wr.dateRequested)],
          ]} />
          <div className="flex flex-wrap items-center gap-2" aria-label="Computed values">
            <StatusBadge tone={tdTone(c.tdStatus)}>Target date: {c.tdStatus}{c.daysToBreach !== null ? ` (${c.daysToBreach} days)` : ''}</StatusBadge>
            <StatusBadge tone={kpiTone(c.kpi)}>{c.kpi}</StatusBadge>
            <StatusBadge tone={rfeTone(c.rfeTimeFrameKind)}>{c.rfeTimeFrame}</StatusBadge>
            {wr.deadline && <DayCounter day={wr.deadline.dayNumber} of={wr.deadline.limit} />}
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <div className="grid gap-1">
              <Button asChild><a href={wr.marafiqUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" aria-hidden /> Open in Marafiq</a></Button>
              <span className="text-xs text-muted-foreground">You must be signed in to Marafiq in this browser.</span>
            </div>
            {canAssign && <Button variant="outline" onClick={() => setAssignOpen(true)}><UserPlus className="size-4" aria-hidden /> Assign technician</Button>}
            <ShareWhatsApp text={shareText} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardContent>
              {wr.timeline.length === 0 ? <p className="text-sm text-muted-foreground">No events yet.</p> : <Timeline items={toTimelineItems(wr.timeline)} />}
            </CardContent>
          </Card>

          {user && <LocalPurchasesCard wr={wr} role={role} userId={user.id} />}

          <MaterialRequestsCard wr={wr} role={role} />

          <RfeLpoCard wr={wr} role={role} />

          {wr.assignments.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Jobs</CardTitle></CardHeader>
              <CardContent>
                <ul className="grid gap-2">
                  {wr.assignments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <strong>{a.assigneeName}</strong><Badge variant="neutral">{a.status}</Badge>
                      {a.plannedDate && <span className="text-muted-foreground">planned {a.plannedDate}</span>}
                      {a.note && <span className="text-muted-foreground">— {a.note}</span>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {wr.attachments.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Files and photos</CardTitle></CardHeader>
              <CardContent>
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {wr.attachments.map((a) => (
                    <li key={a.id} className="grid gap-1">
                      <a href={OPS.attachment(a.id)} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border bg-muted">
                        {a.mime.startsWith('image/')
                          ? <img src={OPS.attachment(a.id)} alt={a.fileName} loading="lazy" className="aspect-square w-full object-cover" />
                          : <span className="flex aspect-square items-center justify-center"><FileText className="size-8 text-muted-foreground" aria-hidden /></span>}
                      </a>
                      <span className="truncate text-xs text-muted-foreground">{a.fileName}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {(wr.rfe || wr.rfeComments.length > 0) && (
            <Card>
              <CardHeader><CardTitle>RFE status and comments</CardTitle></CardHeader>
              <CardContent className="grid gap-3">
                {wr.rfe && <Facts items={[['Submitted on', fmtDate(wr.rfe.submittedOn)], ['Approved on', fmtDate(wr.rfe.approvedOn)], ['Pending with', wr.rfe.pendingWith], ...(wr.rfe.rfeAmount != null ? [['Amount', wr.rfe.rfeAmount.toLocaleString()] as [string, React.ReactNode]] : []), ['BPA release', wr.rfe.bpaReleaseRef]]} />}
                {wr.rfeComments.length > 0 && (
                  <ul className="grid gap-2">
                    {wr.rfeComments.map((cm) => (
                      <li key={cm.id} className="rounded-lg border p-3 text-sm">
                        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{cm.createdBy ?? 'QF'}</span><span>{fmtDate(cm.createdOn)}</span>
                          {cm.isDone || cm.answeredInSonuAt ? <StatusBadge tone="success">Answered</StatusBadge> : <StatusBadge tone="warning">Needs an answer</StatusBadge>}
                        </p>
                        <p className="mt-1">{cm.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {wr.permit && (
            <Card>
              <CardHeader><CardTitle>Permit {wr.permit.ptwCode}</CardTitle></CardHeader>
              <CardContent><Facts items={[['Status', wr.permit.status], ['From', fmtDate(wr.permit.dateStart)], ['Valid until', fmtDate(wr.permit.dateUpto)], ['Issued', fmtDate(wr.permit.dateIssued)], ['Applicant', wr.permit.applicant], ['Controller', wr.permit.controller]]} /></CardContent>
            </Card>
          )}

          {wr.moneyTrail && (
            <Card>
              <CardHeader><CardTitle>Money trail</CardTitle></CardHeader>
              <CardContent><Facts items={Object.entries(MONEY_LABELS).filter(([k]) => wr.moneyTrail![k] != null).map(([k, label]) => [label, String(wr.moneyTrail![k])])} /></CardContent>
            </Card>
          )}

          {canRfe && <RfeEditor code={wr.wrCode} />}
        </div>

        <div className="content-start lg:sticky lg:top-20 lg:self-start">
          {user && <SonuPanel wr={wr} meta={meta.data} role={role} userId={user.id} />}
        </div>
      </div>

      {canAssign && <AssignSheet open={assignOpen} onOpenChange={setAssignOpen} code={wr.wrCode} people={meta.data?.people ?? []} />}
    </div>
  );
}

export default function WorkRequestDetailPage() {
  const { code = '' } = useParams();
  const q = useQuery({ queryKey: ['wr', code], queryFn: () => apiGet<WrDetail>(OPS.workRequest(code)) });
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/work-requests"><ArrowLeft className="size-4" aria-hidden /> Work requests</Link></Button>
      {q.isPending ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <WrDetailView wr={q.data} />
      )}
    </>
  );
}
