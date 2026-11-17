import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/PageHeader';
import { DayCounter } from '@/components/DayCounter';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { QueryBoundary } from '@/components/admin/kit';
import { apiGet, apiPatch } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import type { MyWorkData, WorkCard, WorkGroupKey } from '@/lib/types';

const GROUPS: { key: WorkGroupKey; title: string; button: string }[] = [
  { key: 'returned', title: 'Returned by QF', button: 'Fix and resubmit' },
  { key: 'answer_qf', title: 'Answer QF comments', button: 'Answer' },
  { key: 'take_ownership', title: 'Take ownership', button: 'Take ownership' },
  { key: 'classify', title: 'Classify (criterion)', button: 'Classify' },
  { key: 'estimate_due', title: 'Estimate due', button: 'Prepare RFE' },
  { key: 'assign_technician', title: 'Assign a technician', button: 'Assign technician' },
  { key: 'other', title: 'Other work', button: 'Open' },
];

export function WorkCardView({ card, group }: { card: WorkCard; group: (typeof GROUPS)[number] }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const take = useMutation({
    mutationFn: () => apiPatch(OPS.workRequest(card.wrCode), { takeOwnership: true }),
    onSuccess: () => { toast.success(`You now own ${card.wrCode}.`); void qc.invalidateQueries({ queryKey: ['my-work'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const open = () => nav(`/work-requests/${card.wrCode}${group.key === 'estimate_due' ? '#rfe' : ''}`);
  return (
    <Card className="grid gap-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => nav(`/work-requests/${card.wrCode}`)} className="font-mono text-base font-semibold hover:underline">{card.wrCode}</button>
        {card.dayCounter && <DayCounter day={card.dayCounter.day} of={card.dayCounter.limit} />}
      </div>
      <p className="text-sm text-muted-foreground">{[card.buildingName, card.roomCode].filter(Boolean).join(' · ')}</p>
      <p className="line-clamp-3 text-sm">{card.description}</p>
      <div className="flex flex-wrap gap-2">
        {card.contractorStatus && <StatusBadge tone="info">{card.contractorStatus}</StatusBadge>}
        {card.rfeTimeFrame && <StatusBadge tone="neutral">{card.rfeTimeFrame}</StatusBadge>}
      </div>
      <Button size="lg" className="mt-1 w-full" disabled={take.isPending} onClick={group.key === 'take_ownership' ? () => take.mutate() : open}>{group.button}</Button>
    </Card>
  );
}

export default function MyWorkPage() {
  const q = useQuery({ queryKey: ['my-work'], queryFn: () => apiGet<MyWorkData>(OPS.myWork) });
  return (
    <>
      <PageHeader title="My work" description={q.data ? `${q.data.owned} work requests you own` : undefined} />
      <QueryBoundary
        query={q}
        isEmpty={(d) => GROUPS.every((g) => (d.groups[g.key] ?? []).length === 0)}
        empty={<EmptyState illustration="done" title="Nothing waiting for you" description="New work requests in your zone will appear here." />}
      >
        {(d) => (
          <div className="grid gap-6">
            {GROUPS.filter((g) => (d.groups[g.key] ?? []).length > 0).map((g) => (
              <section key={g.key} aria-labelledby={`g-${g.key}`}>
                <h2 id={`g-${g.key}`} className="mb-2 text-lg font-semibold">{g.title} <span className="text-muted-foreground">({d.groups[g.key].length})</span></h2>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {d.groups[g.key].map((c) => <WorkCardView key={c.wrCode} card={c} group={g} />)}
                </div>
              </section>
            ))}
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
