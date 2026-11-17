import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FormError, FormSheet, NativeSelect } from '@/components/admin/kit';
import { apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { ROLE_LABELS, isRole } from '@/lib/roles';
import type { Person } from '@/lib/types';

/** Assign a technician or foreman to a work request (creates a job). */
export function AssignSheet({ open, onOpenChange, code, people }: { open: boolean; onOpenChange: (o: boolean) => void; code: string; people: Person[] }) {
  const qc = useQueryClient();
  const field = people.filter((p) => p.role === 'technician' || p.role === 'foreman');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [plannedDate, setPlannedDate] = React.useState('');
  const [note, setNote] = React.useState('');
  const m = useMutation({
    mutationFn: () => apiPost(OPS.assignments(code), { assigneeId, ...(plannedDate ? { plannedDate } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      toast.success('Job assigned. The person has been told.');
      void qc.invalidateQueries({ queryKey: ['wr', code] });
      void qc.invalidateQueries({ queryKey: ['team-jobs'] });
      setAssigneeId(''); setPlannedDate(''); setNote('');
      onOpenChange(false);
    },
  });
  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Assign technician" description={`Work request ${code}`}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (assigneeId) m.mutate(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="as-who">Technician or foreman</Label>
          <NativeSelect id="as-who" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
            <option value="">Choose a person…</option>
            {field.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({isRole(p.role) ? ROLE_LABELS[p.role] : p.role}{p.workTeams.length ? `, ${p.workTeams.join('/')}` : ''})</option>)}
          </NativeSelect>
          {field.length === 0 && <p className="text-sm text-muted-foreground">No active technicians or foremen found for your company.</p>}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="as-date">Planned date</Label>
          <Input id="as-date" type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="as-note">Note</Label>
          <Textarea id="as-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </div>
        <FormError message={m.isError ? errorMessage(m.error) : null} />
        <Button type="submit" disabled={!assigneeId || m.isPending}>Assign</Button>
      </form>
    </FormSheet>
  );
}
