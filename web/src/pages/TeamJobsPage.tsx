import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { QueryBoundary } from '@/components/admin/kit';
import { Button } from '@/components/ui/button';
import { JobCardFor } from '@/pages/MyJobsPage';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { JOB_STATUS } from '@/lib/ops';
import { useSession } from '@/lib/session';
import type { Job, JobStatus } from '@/lib/types';

const FILTERS: { id: 'open' | JobStatus; label: string }[] = [
  { id: 'open', label: 'Open' }, { id: 'assigned', label: 'Assigned' }, { id: 'started', label: 'In progress' }, { id: 'done', label: 'Done' },
];
const STATES: JobStatus[] = ['started', 'assigned', 'done'];

export function groupJobs(items: Job[]): { person: string; byState: Record<JobStatus, Job[]> }[] {
  const m = new Map<string, Record<JobStatus, Job[]>>();
  for (const j of items) {
    const g = m.get(j.assignee.fullName) ?? { assigned: [], started: [], done: [] };
    g[j.status].push(j);
    m.set(j.assignee.fullName, g);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([person, byState]) => ({ person, byState }));
}

export default function TeamJobsPage() {
  const { user } = useSession();
  const canAct = user?.role === 'foreman';
  const [status, setStatus] = React.useState<'open' | JobStatus>('open');
  const q = useQuery({ queryKey: ['team-jobs', status], queryFn: () => apiGet<{ items: Job[] }>(OPS.teamJobs, { query: { status } }), refetchInterval: 60_000 });
  return (
    <>
      <PageHeader title="Team jobs" description="Jobs grouped by technician and state." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter jobs">
        {FILTERS.map((f) => <Button key={f.id} size="sm" variant={status === f.id ? 'default' : 'outline'} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>{f.label}</Button>)}
      </div>
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState illustration="done" title="No jobs here" description="Jobs assigned to your team show up in this list." />}
      >
        {(d) => (
          <div className="grid gap-6">
            {groupJobs(d.items).map((g) => (
              <section key={g.person} aria-label={g.person} className="grid gap-3">
                <h2 className="text-lg font-semibold">{g.person}</h2>
                {STATES.filter((s) => g.byState[s].length > 0).map((s) => (
                  <div key={s} className="grid gap-3">
                    <h3 className="text-sm font-semibold text-muted-foreground">{JOB_STATUS[s].label} ({g.byState[s].length})</h3>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{g.byState[s].map((j) => <JobCardFor key={j.id} job={j} canAct={canAct} />)}</div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
