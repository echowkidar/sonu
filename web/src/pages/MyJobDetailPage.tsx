import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/StatusBadge';
import { ShareWhatsApp } from '@/components/ShareWhatsApp';
import { ErrorState } from '@/components/admin/kit';
import { JobActions } from '@/components/ops/JobActions';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { formatDateTime } from '@/lib/forms';
import { JOB_STATUS, jobLocation, jobPermit } from '@/lib/ops';
import type { JobDetail } from '@/lib/types';

export function JobView({ job }: { job: JobDetail }) {
  const permit = jobPermit(job);
  const text = `Job WR ${job.wr.code}: ${job.wr.description ?? ''}\n${jobLocation(job)}\n${window.location.origin}/my-jobs/${job.id}`;
  return (
    <div className="mx-auto grid max-w-xl gap-4">
      <Card>
        <CardContent className="grid gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-base font-semibold text-muted-foreground">WR {job.wr.code}</span>
            <StatusBadge tone={JOB_STATUS[job.status].tone}>{JOB_STATUS[job.status].label}</StatusBadge>
          </div>
          <h1 className="text-xl font-bold leading-snug">{job.wr.description || 'No description'}</h1>
          <p className="flex items-start gap-1.5 text-base text-muted-foreground"><MapPin className="mt-0.5 size-5 shrink-0" aria-hidden />{jobLocation(job) || 'No location'}</p>
          <dl className="grid grid-cols-2 gap-3 text-base">
            <div><dt className="text-xs text-muted-foreground">Problem</dt><dd>{job.wr.problemType ?? '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Priority</dt><dd>{job.wr.priority ?? '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Planned</dt><dd>{job.plannedDate ?? '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Permit</dt><dd>{permit ?? 'No permit'}</dd></div>
          </dl>
          {job.note && <p className="rounded-lg bg-muted p-3 text-base">{job.note}</p>}
          {job.assignedBy && <p className="text-sm text-muted-foreground">Assigned by {job.assignedBy.fullName}</p>}
        </CardContent>
      </Card>

      {job.canAct && job.status !== 'done' && <div className="grid gap-3"><JobActions jobId={job.id} status={job.status} canAct={job.canAct} /></div>}
      {!job.canAct && job.status !== 'done' && <p className="text-sm text-muted-foreground">You can look at this job but only the assigned person or his foreman can update it.</p>}

      <ShareWhatsApp text={text} size="lg" />

      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>
          {job.updates.length === 0 ? <p className="text-sm text-muted-foreground">No updates yet.</p> : (
            <ol className="grid gap-4">
              {[...job.updates].reverse().map((u) => (
                <li key={u.id} className="grid gap-2 border-s-2 ps-3">
                  <p className="text-sm font-semibold">{u.statusTo ? JOB_STATUS[u.statusTo as keyof typeof JOB_STATUS]?.label ?? u.statusTo : 'Update'} <span className="font-normal text-muted-foreground">· {u.userName ?? 'Someone'} · {formatDateTime(u.at)}</span></p>
                  {u.note && <p className="text-base">{u.note}</p>}
                  {u.attachments.length > 0 && (
                    <ul className="grid grid-cols-3 gap-2">
                      {u.attachments.map((a) => (
                        <li key={a.id}>
                          <a href={OPS.attachment(a.id)} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-lg border bg-muted">
                            <img src={OPS.attachment(a.id)} alt={`Photo from ${u.userName ?? 'update'}`} loading="lazy" className="aspect-square w-full object-cover" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MyJobDetailPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['job', id], queryFn: () => apiGet<JobDetail>(OPS.job(id)) });
  return (
    <div className="mx-auto max-w-xl">
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/my-jobs"><ArrowLeft className="size-4" aria-hidden /> My jobs</Link></Button>
      {q.isPending ? <div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-48" /><Skeleton className="h-14" /></div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : <JobView job={q.data} />}
    </div>
  );
}
