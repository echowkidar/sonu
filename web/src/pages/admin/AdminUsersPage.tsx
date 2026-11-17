import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailPlus, Pencil, Plus, Power, RotateCcw, Send } from 'lucide-react';
import { z } from 'zod';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable } from '@/components/DataTable';
import { StatusBadge, type Tone } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { toast } from '@/components/ui/sonner';
import { CheckRow, FormError, FormSheet, NativeSelect, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { api, apiGet, apiPatch, apiPost } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, errorMessage, formatDateTime, useForm } from '@/lib/forms';
import { ROLES, ROLE_LABELS, type Role } from '@/lib/roles';
import type { Paged, UserCreated, UserStatus, UserView, WorkTeam } from '@/lib/types';

/** The roles the API accepts for a user of a contractor (platform admin accounts are not created here). */
export const INVITE_ROLES = ROLES.filter((r) => r !== 'platform_admin');
export const LANGUAGES = ['English', 'Arabic', 'Hindi'] as const;

export const userFormSchema = z.object({
  email: z.string().trim().min(1, 'Enter the e-mail address.').regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid e-mail address.'),
  fullName: z.string().trim().min(2, 'Enter the full name.').max(120),
  role: z.string().refine((r) => (INVITE_ROLES as readonly string[]).includes(r), 'Choose a role.'),
  discipline: z.string().trim().max(60),
  mobile: z.string().trim().refine((v) => v === '' || /^\+\d{8,15}$/.test(v), 'Mobile with country code, no spaces, e.g. +97455550100.'),
  language: z.string(),
  notifyEmail: z.boolean(),
  notifyPush: z.boolean(),
  notifyWhatsapp: z.boolean(),
  reportsTo: z.string(),
  workTeamIds: z.array(z.string()),
});
type UserFormValues = z.input<typeof userFormSchema>;

const blankUser: UserFormValues = {
  email: '', fullName: '', role: '', discipline: '', mobile: '', language: 'English', notifyEmail: true, notifyPush: true, notifyWhatsapp: false,
  reportsTo: '', workTeamIds: [],
};

const fromUser = (u: UserView): UserFormValues => ({
  email: u.email, fullName: u.fullName, role: u.role, discipline: u.discipline ?? '', mobile: u.mobile ?? '', language: u.language,
  notifyEmail: u.notifyEmail, notifyPush: u.notifyPush, notifyWhatsapp: u.notifyWhatsapp, reportsTo: u.reportsTo ?? '',
  workTeamIds: u.workTeams.map((t) => t.id),
});

export function UserForm({
  editing, teams, people, contractorId, onDone,
}: { editing: UserView | null; teams: WorkTeam[]; people: UserView[]; contractorId?: string; onDone: (message: string) => void }) {
  const qc = useQueryClient();
  const form = useForm<UserFormValues, z.output<typeof userFormSchema>>({
    initial: editing ? fromUser(editing) : blankUser,
    schema: userFormSchema,
    submit: async (d) => {
      const common = {
        fullName: d.fullName, role: d.role, discipline: blankToNull(d.discipline), mobile: blankToNull(d.mobile), language: d.language,
        notifyEmail: d.notifyEmail, notifyPush: d.notifyPush, notifyWhatsapp: d.notifyWhatsapp, reportsTo: d.reportsTo || null,
        workTeamIds: d.workTeamIds,
      };
      if (editing) {
        await apiPatch<UserView>(ADMIN.user(editing.id), common);
        onDone('User saved.');
      } else {
        const res = await apiPost<UserCreated>(ADMIN.users, { ...common, email: d.email.toLowerCase(), sendInvite: true, ...(contractorId ? { contractorId } : {}) });
        const inv = res.invitation as { error?: string } | null;
        onDone(inv?.error ? `User added. ${inv.error}` : `Invitation sent to ${d.email}.`);
      }
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      await qc.invalidateQueries({ queryKey: ['admin', 'work-teams'] });
    },
  });
  const { values: v, set, errors: e } = form;
  const toggleTeam = (id: string, on: boolean) => set('workTeamIds', on ? [...v.workTeamIds, id] : v.workTeamIds.filter((x) => x !== id));

  return (
    <form onSubmit={form.handleSubmit} className="grid gap-4" noValidate aria-label={editing ? 'Edit user' : 'Invite user'}>
      <FormError message={form.formError} />
      <Field label="E-mail" error={e.email} hint={editing ? 'The e-mail cannot be changed.' : 'The invitation is sent here.'}>
        {(p) => <Input {...p} type="email" autoComplete="off" value={v.email} disabled={!!editing} onChange={(x) => set('email', x.target.value)} />}
      </Field>
      <Field label="Full name" error={e.fullName}>{(p) => <Input {...p} value={v.fullName} onChange={(x) => set('fullName', x.target.value)} />}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" error={e.role}>
          {(p) => (
            <NativeSelect {...p} value={v.role} onChange={(x) => set('role', x.target.value)}>
              <option value="">Choose a role…</option>
              {INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label="Discipline (optional)" error={e.discipline}>{(p) => <Input {...p} value={v.discipline} onChange={(x) => set('discipline', x.target.value)} />}</Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile (optional)" error={e.mobile} hint="With country code, e.g. +97455550100.">{(p) => <Input {...p} type="tel" inputMode="tel" value={v.mobile} onChange={(x) => set('mobile', x.target.value)} />}</Field>
        <Field label="Language" error={e.language}>
          {(p) => (
            <NativeSelect {...p} value={v.language} onChange={(x) => set('language', x.target.value)}>
              {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
            </NativeSelect>
          )}
        </Field>
      </div>
      <fieldset className="grid gap-1 rounded-xl border p-3">
        <legend className="px-1 text-sm font-semibold">Notify by</legend>
        <CheckRow id="n-email" label="E-mail" checked={v.notifyEmail} onChange={(c) => set('notifyEmail', c)} />
        <CheckRow id="n-push" label="Push on the phone" checked={v.notifyPush} onChange={(c) => set('notifyPush', c)} />
        <CheckRow id="n-wa" label="WhatsApp" checked={v.notifyWhatsapp} onChange={(c) => set('notifyWhatsapp', c)} />
      </fieldset>
      <fieldset className="grid gap-1 rounded-xl border p-3">
        <legend className="px-1 text-sm font-semibold">Work teams</legend>
        {teams.length === 0 ? <p className="text-sm text-muted-foreground">No work teams yet. Add them under Work teams.</p> : teams.filter((t) => t.active || v.workTeamIds.includes(t.id)).map((t) => (
          <CheckRow key={t.id} id={`team-${t.id}`} label={t.name ? `${t.code} · ${t.name}` : t.code} checked={v.workTeamIds.includes(t.id)} onChange={(c) => toggleTeam(t.id, c)} />
        ))}
      </fieldset>
      <Field label="Reports to (optional)" error={e.reportsTo}>
        {(p) => (
          <NativeSelect {...p} value={v.reportsTo} onChange={(x) => set('reportsTo', x.target.value)}>
            <option value="">Nobody</option>
            {people.filter((u) => u.id !== editing?.id && u.status !== 'inactive').map((u) => <option key={u.id} value={u.id}>{u.fullName} ({ROLE_LABELS[u.role]})</option>)}
          </NativeSelect>
        )}
      </Field>
      <Button type="submit" disabled={form.submitting}>
        {editing ? 'Save changes' : <><MailPlus className="size-4" aria-hidden /> {form.submitting ? 'Sending…' : 'Send invitation'}</>}
      </Button>
    </form>
  );
}

const STATUS_TONE: Record<UserStatus, Tone> = { active: 'success', invited: 'warning', inactive: 'neutral' };
const STATUS_LABEL: Record<UserStatus, string> = { active: 'Active', invited: 'Invited', inactive: 'Inactive' };

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const scope = useContractorScope();
  const [search, setSearch] = React.useState('');
  const [role, setRole] = React.useState('');
  const [status, setStatus] = React.useState('');
  const q = useDebounced(search);
  const [sheet, setSheet] = React.useState<{ editing: UserView | null } | null>(null);
  const [toggle, setToggle] = React.useState<UserView | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users', scope.key, q, role, status],
    queryFn: () => apiGet<Paged<UserView>>(ADMIN.users, { query: { ...scope.query, q: q || undefined, role: role || undefined, status: status || undefined, pageSize: 500 } }),
    enabled: scope.ready,
  });
  const teams = useQuery({
    queryKey: ['admin', 'work-teams', scope.key],
    queryFn: () => apiGet<{ items: WorkTeam[] }>(ADMIN.workTeams, { query: scope.query }),
    enabled: scope.ready,
  });
  const everyone = useQuery({
    queryKey: ['admin', 'users', scope.key, '', '', ''],
    queryFn: () => apiGet<Paged<UserView>>(ADMIN.users, { query: { ...scope.query, pageSize: 500 } }),
    enabled: scope.ready && !!sheet,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  const toggleActive = useMutation({
    mutationFn: (u: UserView) => api<UserView>(u.status === 'inactive' ? ADMIN.userActivate(u.id) : ADMIN.userDeactivate(u.id), { method: 'POST' }),
    onSuccess: (u) => { toast.success(u.status === 'inactive' ? 'User deactivated and signed out.' : 'User reactivated.'); void refresh(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resend = useMutation({
    mutationFn: (u: UserView) => apiPost(ADMIN.userResendInvite(u.id)),
    onSuccess: (_r, u) => toast.success(`Invitation sent again to ${u.email}.`),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns = React.useMemo<ColumnDef<UserView>[]>(() => [
    { accessorKey: 'fullName', header: 'Name', size: 190 },
    { accessorKey: 'email', header: 'E-mail', size: 240 },
    { accessorKey: 'role', header: 'Role', size: 140, cell: (c) => ROLE_LABELS[c.getValue<Role>()] ?? c.getValue<string>() },
    { id: 'teams', header: 'Work teams', size: 170, accessorFn: (u) => u.workTeams.map((t) => t.code).join(', ') },
    { accessorKey: 'status', header: 'Status', size: 130, cell: (c) => <StatusBadge tone={STATUS_TONE[c.getValue<UserStatus>()]}>{STATUS_LABEL[c.getValue<UserStatus>()]}</StatusBadge> },
    { accessorKey: 'lastLoginAt', header: 'Last sign-in', size: 170, cell: (c) => formatDateTime(c.getValue<string | null>()) || 'Never' },
    {
      id: 'invitation', header: 'Invitation', size: 150,
      accessorFn: (u) => (u.status === 'invited' ? 'Waiting for the user' : u.status === 'active' ? 'Accepted' : ''),
    },
    {
      id: 'actions', header: 'Actions', size: 170, enableSorting: false,
      cell: ({ row }) => {
        const u = row.original;
        return (
          <span className="flex gap-1" onClick={(ev) => ev.stopPropagation()}>
            <Button size="sm" variant="outline" aria-label={`Edit ${u.fullName}`} onClick={() => setSheet({ editing: u })}><Pencil className="size-4" /></Button>
            {u.status === 'invited' && <Button size="sm" variant="outline" aria-label={`Resend invitation to ${u.email}`} onClick={() => resend.mutate(u)}><Send className="size-4" /></Button>}
            <Button size="sm" variant="outline" aria-label={`${u.status === 'inactive' ? 'Reactivate' : 'Deactivate'} ${u.fullName}`} onClick={() => setToggle(u)}>
              {u.status === 'inactive' ? <RotateCcw className="size-4" /> : <Power className="size-4" />}
            </Button>
          </span>
        );
      },
    },
  ], [resend]);

  const invite = <Button onClick={() => setSheet({ editing: null })} disabled={!scope.ready}><Plus className="size-4" aria-hidden /> Invite user</Button>;
  const filtered = !!(q || role || status);

  return (
    <>
      <PageHeader title="Users" description="People who sign in to SONU for this contractor." actions={invite} />
      {scope.picker}
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to see and manage its users." />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input aria-label="Search users" placeholder="Search name or e-mail…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-48 flex-1 sm:max-w-xs" />
            <NativeSelect aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)} className="w-auto">
              <option value="">All roles</option>
              {INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </NativeSelect>
            <NativeSelect aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="inactive">Inactive</option>
            </NativeSelect>
          </div>
          <QueryBoundary
            query={users}
            isEmpty={(d) => d.items.length === 0}
            empty={filtered
              ? <EmptyState illustration="search" title="No users match" description="Change or clear the filters." />
              : <EmptyState title="No users yet" description="Invite the first user. They get an e-mail to set a password." action={invite} />}
          >
            {(d) => <DataTable columns={columns} data={d.items} getRowId={(u) => u.id} pinStart={['fullName']} searchable={false} height={Math.min(600, 120 + d.items.length * 44)} aria-label="Users" />}
          </QueryBoundary>
        </>
      )}

      <FormSheet
        open={!!sheet}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet?.editing ? `Edit ${sheet.editing.fullName}` : 'Invite user'}
        description={sheet?.editing ? undefined : 'The user gets an e-mail to set their own password.'}
      >
        {sheet && (
          <UserForm
            key={sheet.editing?.id ?? 'new'}
            editing={sheet.editing}
            teams={teams.data?.items ?? []}
            people={everyone.data?.items ?? []}
            contractorId={scope.scopeId}
            onDone={(m) => { toast.success(m); setSheet(null); }}
          />
        )}
      </FormSheet>

      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.status === 'inactive' ? `Reactivate ${toggle?.fullName}?` : `Deactivate ${toggle?.fullName}?`}
        description={toggle?.status === 'inactive' ? 'They can sign in again.' : 'They are signed out now and cannot sign in. Their work history is kept.'}
        confirmLabel={toggle?.status === 'inactive' ? 'Reactivate' : 'Deactivate'}
        destructive={toggle?.status !== 'inactive'}
        onConfirm={async () => { if (toggle) await toggleActive.mutateAsync(toggle).catch(() => undefined); }}
      />
    </>
  );
}
