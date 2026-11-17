import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Pencil, Plus, Power } from 'lucide-react';
import { z } from 'zod';
import type { ColumnDef } from '@tanstack/react-table';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/form';
import { toast } from '@/components/ui/sonner';
import { FormError, FormSheet, ListInput, QueryBoundary } from '@/components/admin/kit';
import { api, apiGet, apiPatch, apiPost } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, errorMessage, splitList, useForm } from '@/lib/forms';
import type { Contractor, ContractorCreated } from '@/lib/types';

const mobileRe = /^\+\d{8,15}$/;
const optEmail = z.string().trim().refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid e-mail address.');

export const contractorFormSchema = z.object({
  code: z.string().trim().min(2, 'At least 2 characters.').max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash or underscore.'),
  name: z.string().trim().min(2, 'Enter the company name.').max(200),
  nameAr: z.string().trim().max(200),
  marafiqTradeCode: z.string().trim().max(60),
  workTeams: z.string(),
  disciplines: z.string(),
  senderEmail: optEmail,
  timeZone: z.string().trim().min(1, 'Choose a time zone.').refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone.'),
  notes: z.string().max(5000),
  adminName: z.string().trim(),
  adminEmail: z.string().trim(),
  adminMobile: z.string().trim(),
  creating: z.boolean(),
}).superRefine((v, ctx) => {
  if (!v.creating) return;
  if (v.adminName.length < 2) ctx.addIssue({ code: 'custom', path: ['adminName'], message: 'Enter the admin name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.adminEmail)) ctx.addIssue({ code: 'custom', path: ['adminEmail'], message: 'Enter a valid e-mail address.' });
  if (v.adminMobile && !mobileRe.test(v.adminMobile)) ctx.addIssue({ code: 'custom', path: ['adminMobile'], message: 'Mobile with country code, no spaces, e.g. +97455550100.' });
});

type FormValues = z.input<typeof contractorFormSchema>;

const emptyForm: FormValues = {
  code: '', name: '', nameAr: '', marafiqTradeCode: '', workTeams: '', disciplines: '', senderEmail: '', timeZone: 'Asia/Qatar',
  notes: '', adminName: '', adminEmail: '', adminMobile: '', creating: true,
};

const fromContractor = (c: Contractor): FormValues => ({
  code: c.code, name: c.name, nameAr: c.nameAr ?? '', marafiqTradeCode: c.marafiqTradeCode ?? '', workTeams: c.marafiqWorkTeams.join(', '),
  disciplines: c.disciplines.join(', '), senderEmail: c.senderEmail ?? '', timeZone: c.timeZone, notes: c.notes ?? '',
  adminName: '', adminEmail: '', adminMobile: '', creating: false,
});

const PATHS = { 'admin.fullName': 'adminName', 'admin.email': 'adminEmail', 'admin.mobile': 'adminMobile', marafiqWorkTeams: 'workTeams' };

function timeZones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['Asia/Qatar', 'UTC']; }
}

export function ContractorForm({ editing, onDone }: { editing: Contractor | null; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const form = useForm<FormValues, z.output<typeof contractorFormSchema>>({
    initial: editing ? fromContractor(editing) : emptyForm,
    schema: contractorFormSchema,
    pathMap: PATHS,
    submit: async (d) => {
      const common = {
        code: d.code, name: d.name, nameAr: blankToNull(d.nameAr), marafiqTradeCode: blankToNull(d.marafiqTradeCode),
        marafiqWorkTeams: splitList(d.workTeams), disciplines: splitList(d.disciplines), senderEmail: d.senderEmail, timeZone: d.timeZone,
        notes: blankToNull(d.notes),
      };
      if (editing) {
        await apiPatch<Contractor>(ADMIN.contractor(editing.id), common);
        onDone('Contractor saved.');
      } else {
        const res = await apiPost<ContractorCreated>(ADMIN.contractors, {
          ...common, admin: { fullName: d.adminName, email: d.adminEmail.toLowerCase(), mobile: blankToNull(d.adminMobile) },
        });
        onDone('error' in res.invitation ? `Contractor created. ${res.invitation.error}` : `Contractor created. Invitation sent to ${d.adminEmail}.`);
      }
      await qc.invalidateQueries({ queryKey: ['admin', 'contractors'] });
    },
  });
  const { values: v, set, errors: e } = form;
  const zones = React.useMemo(timeZones, []);

  return (
    <form onSubmit={form.handleSubmit} className="grid gap-4" noValidate>
      <FormError message={form.formError} />
      <Field label="Company name" error={e.name}>{(p) => <Input {...p} value={v.name} onChange={(x) => set('name', x.target.value)} />}</Field>
      <Field label="Company name (Arabic)" error={e.nameAr}>{(p) => <Input {...p} dir="rtl" value={v.nameAr} onChange={(x) => set('nameAr', x.target.value)} />}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contractor code" error={e.code} hint="Short and unique, e.g. ACME.">{(p) => <Input {...p} value={v.code} onChange={(x) => set('code', x.target.value)} />}</Field>
        <Field label="Marafiq trade code" error={e.marafiqTradeCode}>{(p) => <Input {...p} value={v.marafiqTradeCode} onChange={(x) => set('marafiqTradeCode', x.target.value)} />}</Field>
      </div>
      <ListInput label="Work teams" value={v.workTeams} onChange={(x) => set('workTeams', x)} error={e.workTeams} hint="Marafiq work team codes, separated by commas." />
      <ListInput label="Disciplines" value={v.disciplines} onChange={(x) => set('disciplines', x)} error={e.disciplines} hint="For example HVAC, Electrical, Plumbing." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" error={e.timeZone}>
          {(p) => (<>
            <Input {...p} list="tz-list" value={v.timeZone} onChange={(x) => set('timeZone', x.target.value)} />
            <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </>)}
        </Field>
        <Field label="Sender e-mail (optional)" error={e.senderEmail}>{(p) => <Input {...p} type="email" value={v.senderEmail} onChange={(x) => set('senderEmail', x.target.value)} />}</Field>
      </div>
      {!editing && (
        <fieldset className="grid gap-4 rounded-xl border p-4">
          <legend className="px-1 text-sm font-semibold">Contractor admin</legend>
          <p className="text-sm text-muted-foreground">This person receives the invitation e-mail and sets their own password.</p>
          <Field label="Admin name" error={e.adminName}>{(p) => <Input {...p} value={v.adminName} onChange={(x) => set('adminName', x.target.value)} />}</Field>
          <Field label="Admin e-mail" error={e.adminEmail}>{(p) => <Input {...p} type="email" value={v.adminEmail} onChange={(x) => set('adminEmail', x.target.value)} />}</Field>
          <Field label="Admin mobile (optional)" error={e.adminMobile} hint="With country code, e.g. +97455550100.">{(p) => <Input {...p} type="tel" value={v.adminMobile} onChange={(x) => set('adminMobile', x.target.value)} />}</Field>
        </fieldset>
      )}
      <Field label="Notes (optional)" error={e.notes}>{(p) => <Textarea {...p} rows={3} value={v.notes} onChange={(x) => set('notes', x.target.value)} />}</Field>
      <Button type="submit" disabled={form.submitting}>{form.submitting ? 'Saving…' : editing ? 'Save changes' : 'Add contractor and send invitation'}</Button>
    </form>
  );
}

export default function AdminContractorsPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'contractors'], queryFn: () => apiGet<{ items: Contractor[] }>(ADMIN.contractors) });
  const [sheet, setSheet] = React.useState<{ editing: Contractor | null } | null>(null);
  const [toggle, setToggle] = React.useState<Contractor | null>(null);

  const setStatus = useMutation({
    mutationFn: (c: Contractor) => api<Contractor>(ADMIN.contractor(c.id), { method: 'PATCH', body: { status: c.status === 'active' ? 'inactive' : 'active' } }),
    onSuccess: (c) => { toast.success(c.status === 'active' ? 'Contractor activated.' : 'Contractor deactivated. Its users can no longer sign in.'); void qc.invalidateQueries({ queryKey: ['admin', 'contractors'] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns = React.useMemo<ColumnDef<Contractor>[]>(() => [
    { accessorKey: 'name', header: 'Company', size: 220 },
    { accessorKey: 'code', header: 'Code', size: 110 },
    { accessorKey: 'marafiqTradeCode', header: 'Trade code', size: 120, cell: (c) => c.getValue<string | null>() ?? '' },
    { id: 'teams', header: 'Work teams', size: 180, accessorFn: (c) => c.marafiqWorkTeams.join(', ') },
    { id: 'disc', header: 'Disciplines', size: 180, accessorFn: (c) => c.disciplines.join(', ') },
    { accessorKey: 'timeZone', header: 'Time zone', size: 140 },
    { accessorKey: 'userCount', header: 'Users', size: 80 },
    { accessorKey: 'status', header: 'Status', size: 130, cell: (c) => <StatusBadge tone={c.getValue() === 'active' ? 'success' : 'neutral'}>{c.getValue() === 'active' ? 'Active' : 'Inactive'}</StatusBadge> },
    {
      id: 'actions', header: 'Actions', size: 130, enableSorting: false,
      cell: ({ row }) => (
        <span className="flex gap-1">
          <Button size="sm" variant="outline" aria-label={`Edit ${row.original.name}`} onClick={(ev) => { ev.stopPropagation(); setSheet({ editing: row.original }); }}><Pencil className="size-4" /></Button>
          <Button size="sm" variant="outline" aria-label={`${row.original.status === 'active' ? 'Deactivate' : 'Activate'} ${row.original.name}`} onClick={(ev) => { ev.stopPropagation(); setToggle(row.original); }}><Power className="size-4" /></Button>
        </span>
      ),
    },
  ], []);

  return (
    <>
      <PageHeader
        title="Contractors"
        description="Each contractor company and the admin who runs it."
        actions={<Button onClick={() => setSheet({ editing: null })}><Plus className="size-4" aria-hidden /> Add contractor</Button>}
      />
      <QueryBoundary
        query={query}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState illustration="build" title="No contractors yet" description="Add the first contractor. Its admin gets an invitation e-mail." action={<Button onClick={() => setSheet({ editing: null })}><Plus className="size-4" aria-hidden /> Add contractor</Button>} />}
      >
        {(d) => <DataTable columns={columns} data={d.items} getRowId={(c) => c.id} pinStart={['name']} height={Math.min(560, 120 + d.items.length * 44)} aria-label="Contractors" />}
      </QueryBoundary>

      <FormSheet
        open={!!sheet}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet?.editing ? `Edit ${sheet.editing.name}` : 'Add contractor'}
        description={sheet?.editing ? undefined : 'Creates the company and its first admin. An invitation e-mail goes to the admin.'}
      >
        {sheet && <ContractorForm key={sheet.editing?.id ?? 'new'} editing={sheet.editing} onDone={(m) => { toast.success(m, { icon: <Mail className="size-4" /> }); setSheet(null); }} />}
      </FormSheet>

      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.status === 'active' ? `Deactivate ${toggle?.name}?` : `Activate ${toggle?.name}?`}
        description={toggle?.status === 'active' ? 'All its users are signed out and cannot sign in. Work data and history are kept.' : 'Its users can sign in again.'}
        confirmLabel={toggle?.status === 'active' ? 'Deactivate' : 'Activate'}
        destructive={toggle?.status === 'active'}
        onConfirm={async () => { if (toggle) await setStatus.mutateAsync(toggle).catch(() => undefined); }}
      />
    </>
  );
}
