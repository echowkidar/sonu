import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { JobCard } from '@/components/JobCard';
import { EmptyState } from '@/components/EmptyState';
import { QueryBoundary } from '@/components/admin/kit';
import { JobActions } from '@/components/ops/JobActions';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { JOB_STATUS, jobLocation, jobPermit } from '@/lib/ops';
import type { Job, MyJobsData } from '@/lib/types';

export function JobCardFor({ job, canAct = true }: { job: Job; canAct?: boolean }) {
  const nav = useNavigate();
  return (
    <JobCard
      code={job.wr.code}
      title={job.wr.description || 'No description'}
      location={jobLocation(job)}
      status={JOB_STATUS[job.status]}
      permit={jobPermit(job)}
      onOpen={() => nav(`/my-jobs/${job.id}`)}
      footer={canAct && job.status !== 'done' ? <JobActions jobId={job.id} status={job.status} /> : undefined}
    >
      {job.plannedDate && <p className="text-sm text-muted-foreground">Planned: {job.plannedDate}</p>}
    </JobCard>
  );
}

function Section({ title, jobs }: { title: string; jobs: Job[] }) {
  if (jobs.length === 0) return null;
  return (
    <section className="grid gap-3" aria-label={title}>
      <h2 className="text-lg font-semibold">{title} <span className="text-muted-foreground">({jobs.length})</span></h2>
      {jobs.map((j) => <JobCardFor key={j.id} job={j} />)}
    </section>
  );
}

export default function MyJobsPage() {
  const q = useQuery({ queryKey: ['my-jobs'], queryFn: () => apiGet<MyJobsData>(OPS.myJobs), refetchInterval: 60_000 });
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="My jobs" description={q.data ? `Today, ${q.data.today}` : undefined} />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.todayJobs.length + d.open.length + d.doneRecently.length === 0}
        empty={<EmptyState illustration="done" title="No jobs for you" description="When a supervisor assigns you a job it appears here." />}
      >
        {(d) => {
          const todayIds = new Set(d.todayJobs.map((j) => j.id));
          return (
            <div className="grid gap-6">
              {d.todayJobs.length === 0 && <EmptyState illustration="done" title="Nothing planned for today" description="Open jobs are listed below." className="py-6" />}
              <Section title="Today" jobs={d.todayJobs} />
              <Section title="Later" jobs={d.open.filter((j) => !todayIds.has(j.id))} />
              <Section title="Done in the last 7 days" jobs={d.doneRecently} />
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
