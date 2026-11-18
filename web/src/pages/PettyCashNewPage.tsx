import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageHeader';
import { FormError, NativeSelect } from '@/components/admin/kit';
import { apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { canPrepareClaim } from '@/lib/pettyCash';
import { useSession } from '@/lib/session';
import type { PettyCashDetail } from '@/lib/types';

/** /petty-cash/new: the header of a new claim; lines are added on the claim page. */
export default function PettyCashNewPage() {
  const { user } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [project, setProject] = React.useState('');
  const [month, setMonth] = React.useState(() => new Date().toISOString().slice(0, 7));
  const [type, setType] = React.useState<'materials' | 'services'>('materials');
  const [error, setError] = React.useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => apiPost<PettyCashDetail>(OPS.pettyCashClaims, { projectName: project.trim() || undefined, month, purchaseType: type }),
    onSuccess: (d) => { toast.success(`${d.code} created.`); void qc.invalidateQueries({ queryKey: ['petty-cash-list'] }); void qc.invalidateQueries({ queryKey: ['procurement-summary'] }); nav(`/petty-cash/${d.id}`); },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/petty-cash"><ArrowLeft className="size-4" aria-hidden /> Petty cash claims</Link></Button>
      <PageHeader title="New petty cash claim" description="Start the claim here, then add the local purchases of 0 RFE jobs and any other bills." />
      {user && !canPrepareClaim(user.role) ? (
        <p className="rounded-lg border p-4 text-sm">Only a supervisor, coordinator or manager prepares a claim.</p>
      ) : (
        <Card>
          <CardContent className="p-4">
            <form className="grid gap-3 sm:max-w-xl" onSubmit={(e) => { e.preventDefault(); if (!month) { setError('Pick the month.'); return; } setError(null); create.mutate(); }} aria-label="New claim">
              <div className="grid gap-1.5"><Label htmlFor="pcn-project">Project name</Label><Input id="pcn-project" value={project} maxLength={200} placeholder="Same as the last claim" onChange={(e) => setProject(e.target.value)} className="text-base" /></div>
              <div className="grid gap-1.5"><Label htmlFor="pcn-month">Month</Label><Input id="pcn-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="text-base" /></div>
              <div className="grid gap-1.5">
                <Label htmlFor="pcn-type">Type</Label>
                <NativeSelect id="pcn-type" value={type} onChange={(e) => setType(e.target.value as 'materials' | 'services')}><option value="materials">Materials</option><option value="services">Services</option></NativeSelect>
              </div>
              <FormError message={error} />
              <Button type="submit" className="justify-self-start" disabled={create.isPending}>Create claim</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </>
  );
}
