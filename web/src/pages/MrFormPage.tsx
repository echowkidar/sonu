import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState } from '@/components/admin/kit';
import { MrFormView } from '@/components/ops/MrForm';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import type { MrDetail, WrDetail } from '@/lib/types';

const Loading = () => <div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;

/** /procurement/mr/new?wr=<code> (header prefilled from the work request) or /procurement/mr/:id/edit. */
export default function MrFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const wrCode = params.get('wr') ?? '';
  const editing = Boolean(id);
  const mr = useQuery({ queryKey: ['mr', id], queryFn: () => apiGet<MrDetail>(OPS.mr(id!)), enabled: editing });
  const wr = useQuery({ queryKey: ['wr', wrCode], queryFn: () => apiGet<WrDetail>(OPS.workRequest(wrCode)), enabled: !editing && Boolean(wrCode) });
  const back = editing ? `/procurement/mr/${id}` : wrCode ? `/work-requests/${encodeURIComponent(wrCode)}` : '/procurement/mr';
  const active = editing ? mr : wr;
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to={back}><ArrowLeft className="size-4" aria-hidden /> Back</Link></Button>
      <PageHeader title={editing ? 'Edit material request' : 'New material request'} description={wrCode ? `For work request ${wrCode}` : undefined} />
      {(editing || wrCode) && active.isPending ? (
        <Loading />
      ) : (editing || wrCode) && active.isError ? (
        <ErrorState error={active.error} onRetry={() => void active.refetch()} />
      ) : editing ? (
        mr.data!.can.edit
          ? <MrFormView wr={null} initial={mr.data!} />
          : <p className="rounded-lg border p-4 text-sm">This request is no longer New, so it cannot be edited. <Link className="underline" to={`/procurement/mr/${id}`}>Open it</Link></p>
      ) : (
        <MrFormView wr={wr.data ?? null} />
      )}
    </>
  );
}
