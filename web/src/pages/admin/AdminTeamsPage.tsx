import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UserMinus, Users } from 'lucide-react';
import { z } from 'zod';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { toast } from '@/components/ui/sonner';
import { CheckRow, FormError, FormSheet, NativeSelect, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, errorMessage, useForm } from '@/lib/forms';
import { ROLE_LABELS } from '@/lib/roles';
import type { Paged, UserView, WorkTeam } from '@/lib/types';

const teamSchema = z.object({
  code: z.string().trim().min(1, 'Enter a team code.').max(60),
  name: z.string().trim().max(120),
  zone: z.string().trim().max(60),
  active: z.boolean(),
});
type TeamValues = z.input<typeof teamSchema>;

function TeamForm({ editing, contractorId, onDone }: { editing: WorkTeam | null; contractorId?: string; onDone: (m: string) => void }) {
  const qc = useQueryClient();
  const form = useForm<TeamValues, z.output<typeof teamSchema>>({
    initial: editing ? { code: editing.code, name: editing.name ?? '', zone: editing.zone ?? '', active: editing.active } : { code: '', name: '', zone: '', active: true },
    schema: teamSchema,
    submit: async (d) => {
      const body = { code: d.code, name: blankToNull(d.name), zone: blankToNull(d.zone), active: d.active };
      if (editing) await api(ADMIN.workTeam(editing.id), { method: 'PATCH', body });
      else await api(ADMIN.workTeams, { method: 'POST', body: { ...body, ...(contractorId ? { contractorId } : {}) } });
      await qc.invalidateQueries({ queryKey: ['admin', 'work-teams'] });
      onDone(editing ? 'Work team saved.' : 'Work team added.');
    },
  });
  const { values: v, set, errors: e } = form;
  return (
    <form onSubmit={form.handleSubmit} className="grid gap-4" noValidate>
      <FormError message={form.formError} />
      <Field label="Team code" error={e.code}>{(p) => <Input {...p} value={v.code} onChange={(x) => set('code', x.target.value)} />}</Field>
      <Field label="Name (optional)" error={e.name}>{(p) => <Input {...p} value={v.name} onChange={(x) => set('name', x.target.value)} />}</Field>
      <Field label="Zone (optional)" error={e.zone}>{(p) => <Input {...p} value={v.zone} onChange={(x) => set('zone', x.target.value)} />}</Field>
      <CheckRow id="team-active" label="Active" checked={v.active} onChange={(c) => set('active', c)} hint="Inactive teams are kept for history but are not offered for new work." />
      <Button type="submit" disabled={form.submitting}>{form.submitting ? 'Saving…' : editing ? 'Save changes' : 'Add work team'}</Button>
    </form>
  );
}

function Members({ team, users, onChanged }: { team: WorkTeam; users: UserView[]; onChanged: () => void }) {
  const [adding, setAdding] = React.useState('');
  const members = users.filter((u) => u.workTeams.some((t) => t.id === team.id));
  const others = users.filter((u) => u.status !== 'inactive' && !u.workTeams.some((t) => t.id === team.id));
  const save = useMutation({
    mutationFn: ({ user, ids }: { user: UserView; ids: string[] }) => api(ADMIN.userWorkTeams(user.id), { method: 'PUT', body: { workTeamIds: ids } }),
    onSuccess: () => { onChanged(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ids = (u: UserView) => u.workTeams.map((t) => t.id);
  return (
    <section className="mt-6 grid gap-3" aria-label="Members">
      <h3 className="flex items-center gap-2 text-base font-semibold"><Users className="size-4" aria-hidden /> Members ({members.length})</h3>
      {members.length === 0 ? <p className="text-sm text-muted-foreground">Nobody is in this team yet.</p> : (
        <ul className="grid gap-1.5">
          {members.map((u) => (
            <li key={u.id} className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{u.fullName} <span className="text-muted-foreground">· {ROLE_LABELS[u.role]}</span></span>
              <Button size="sm" variant="ghost" aria-label={`Remove ${u.fullName} from ${team.code}`} disabled={save.isPending} onClick={() => save.mutate({ user: u, ids: ids(u).filter((x) => x !== team.id) })}><UserMinus className="size-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <NativeSelect aria-label="Add a member" value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add a member…</option>
          {others.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({ROLE_LABELS[u.role]})</option>)}
        </NativeSelect>
        <Button variant="outline" disabled={!adding || save.isPending} onClick={() => {
          const u = users.find((x) => x.id === adding);
          if (u) save.mutate({ user: u, ids: [...ids(u), team.id] }, { onSuccess: () => setAdding('') });
        }}>Add</Button>
      </div>
    </section>
  );
}

export default function AdminTeamsPage() {
  const qc = useQueryClient();
  const scope = useContractorScope();
  const [sheet, setSheet] = React.useState<{ editing: WorkTeam | null } | null>(null);
  const [del, setDel] = React.useState<WorkTeam | null>(null);

  const teams = useQuery({
    queryKey: ['admin', 'work-teams', scope.key],
    queryFn: () => apiGet<{ items: WorkTeam[] }>(ADMIN.workTeams, { query: scope.query }),
    enabled: scope.ready,
  });
  const users = useQuery({
    queryKey: ['admin', 'users', scope.key, '', '', ''],
    queryFn: () => apiGet<Paged<UserView>>(ADMIN.users, { query: { ...scope.query, pageSize: 500 } }),
    enabled: scope.ready && !!sheet?.editing,
  });
  const remove = useMutation({
    mutationFn: (t: WorkTeam) => api(ADMIN.workTeam(t.id), { method: 'DELETE' }),
    onSuccess: () => { toast.success('Work team deleted.'); void qc.invalidateQueries({ queryKey: ['admin', 'work-teams'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns = React.useMemo<ColumnDef<WorkTeam>[]>(() => [
    { accessorKey: 'code', header: 'Code', size: 140 },
    { accessorKey: 'name', header: 'Name', size: 200, cell: (c) => c.getValue<string | null>() ?? '' },
    { accessorKey: 'zone', header: 'Zone', size: 120, cell: (c) => c.getValue<string | null>() ?? '' },
    { accessorKey: 'memberCount', header: 'Members', size: 100 },
    { accessorKey: 'active', header: 'Status', size: 120, cell: (c) => <StatusBadge tone={c.getValue() ? 'success' : 'neutral'}>{c.getValue() ? 'Active' : 'Inactive'}</StatusBadge> },
    {
      id: 'actions', header: 'Actions', size: 110, enableSorting: false,
      cell: ({ row }) => (
        <span className="flex gap-1" onClick={(ev) => ev.stopPropagation()}>
          <Button size="sm" variant="outline" aria-label={`Edit ${row.original.code}`} onClick={() => setSheet({ editing: row.original })}><Pencil className="size-4" /></Button>
          <Button size="sm" variant="outline" aria-label={`Delete ${row.original.code}`} onClick={() => setDel(row.original)}><Trash2 className="size-4" /></Button>
        </span>
      ),
    },
  ], []);

  const add = <Button onClick={() => setSheet({ editing: null })} disabled={!scope.ready}><Plus className="size-4" aria-hidden /> Add work team</Button>;

  return (
    <>
      <PageHeader title="Work teams" description="Groups of people who work together. Tap a team to change its members." actions={add} />
      {scope.picker}
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to manage its work teams." />
      ) : (
        <QueryBoundary
          query={teams}
          isEmpty={(d) => d.items.length === 0}
          empty={<EmptyState illustration="build" title="No work teams yet" description="Add a team, then put users in it." action={add} />}
        >
          {(d) => <DataTable columns={columns} data={d.items} getRowId={(t) => t.id} pinStart={['code']} onRowClick={(t) => setSheet({ editing: t })} height={Math.min(560, 120 + d.items.length * 44)} aria-label="Work teams" />}
        </QueryBoundary>
      )}

      <FormSheet open={!!sheet} onOpenChange={(o) => !o && setSheet(null)} title={sheet?.editing ? `Team ${sheet.editing.code}` : 'Add work team'}>
        {sheet && (
          <>
            <TeamForm key={sheet.editing?.id ?? 'new'} editing={sheet.editing} contractorId={scope.scopeId} onDone={(m) => { toast.success(m); setSheet(null); }} />
            {sheet.editing && (
              users.isPending ? <p className="mt-6 text-sm text-muted-foreground">Loading members…</p>
                : users.isError ? <p className="mt-6 text-sm text-danger" role="alert">{errorMessage(users.error)}</p>
                : <Members team={sheet.editing} users={users.data.items} onChanged={() => { void qc.invalidateQueries({ queryKey: ['admin', 'users'] }); void qc.invalidateQueries({ queryKey: ['admin', 'work-teams'] }); }} />
            )}
          </>
        )}
      </FormSheet>

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete team ${del?.code}?`}
        description={del && del.memberCount > 0 ? `${del.memberCount} user(s) are in this team. They stay, but lose this team. This cannot be undone.` : 'This cannot be undone.'}
        confirmLabel="Delete team"
        destructive
        onConfirm={async () => { if (del) await remove.mutateAsync(del).catch(() => undefined); }}
      />
    </>
  );
}
