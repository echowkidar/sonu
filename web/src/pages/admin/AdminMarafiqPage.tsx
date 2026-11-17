import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/sonner';
import { FormError, NativeSelect, QueryBoundary, SecretField, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, useForm } from '@/lib/forms';
import type { MarafiqConnection } from '@/lib/types';

export const connectionSchema = z.object({
  baseUrl: z.string().trim().refine((v) => v === '' || /^https:\/\/\S+$/i.test(v), 'Use an https:// address.'),
  project: z.string().trim().min(1, 'Enter the project.').max(40),
  username: z.string().trim().max(120),
  password: z.string().max(500),
  mode: z.enum(['off', 'read_only']),
});
type ConnValues = z.input<typeof connectionSchema>;

/** Settings card: address, project, user name, write-only password, mode. */
export function MarafiqSettingsCard({ connection, query }: { connection: MarafiqConnection; query?: Record<string, string> }) {
  const qc = useQueryClient();
  const [clearPassword, setClearPassword] = React.useState(false);
  const form = useForm<ConnValues, z.output<typeof connectionSchema>>({
    initial: { baseUrl: connection.baseUrl ?? '', project: connection.project ?? '', username: connection.username ?? '', password: '', mode: connection.mode },
    schema: connectionSchema,
    submit: async (d) => {
      const body: Record<string, unknown> = { baseUrl: blankToNull(d.baseUrl), project: d.project, username: blankToNull(d.username), mode: d.mode };
      if (d.password) body.password = d.password; // write-only: only when replaced
      else if (clearPassword) body.clearPassword = true;
      await api(ADMIN.marafiqConnection, { method: 'PUT', body, query });
      toast.success('Connection settings saved.');
      setClearPassword(false);
      form.set('password', '');
      await qc.invalidateQueries({ queryKey: ['admin', 'marafiq-connection'] });
    },
  });
  const { values: v, set, errors: e } = form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection settings</CardTitle>
        <CardDescription>Optional, off by default; manual import always works.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit} className="grid max-w-xl gap-4" noValidate aria-label="Marafiq connection">
          <FormError message={form.formError} />
          <Field label="Marafiq address" error={e.baseUrl} hint="The sign-in address of your Marafiq site, starting with https://">{(p) => <Input {...p} type="url" value={v.baseUrl} onChange={(x) => set('baseUrl', x.target.value)} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project" error={e.project}>{(p) => <Input {...p} value={v.project} onChange={(x) => set('project', x.target.value)} />}</Field>
            <Field label="User name" error={e.username}>{(p) => <Input {...p} autoComplete="off" value={v.username} onChange={(x) => set('username', x.target.value)} />}</Field>
          </div>
          <SecretField
            label="Password" hasValue={connection.hasPassword && !clearPassword} value={v.password} onChange={(x) => set('password', x)} error={e.password}
            clearable onClear={() => setClearPassword(true)} hint="Stored encrypted. It is never shown again."
          />
          <Field label="Mode" error={e.mode} hint="Read only: SONU may read data from Marafiq. It never writes to it.">
            {(p) => (
              <NativeSelect {...p} value={v.mode} onChange={(x) => set('mode', x.target.value as ConnValues['mode'])}>
                <option value="off">Off (manual import only)</option>
                <option value="read_only">Read only</option>
              </NativeSelect>
            )}
          </Field>
          <Alert variant="info"><Info className="size-4" aria-hidden /><AlertDescription>Optional, off by default; manual import always works.</AlertDescription></Alert>
          <div><Button type="submit" disabled={form.submitting}>{form.submitting ? 'Saving…' : 'Save settings'}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function AdminMarafiqPage() {
  const scope = useContractorScope();
  const query = useQuery({
    queryKey: ['admin', 'marafiq-connection', scope.key],
    queryFn: () => apiGet<MarafiqConnection>(ADMIN.marafiqConnection, { query: scope.query }),
    enabled: scope.ready,
  });
  return (
    <>
      <PageHeader title="Marafiq connection" description="Lets SONU read your Marafiq lists in the background, so you do not have to import them by hand." />
      {scope.picker}
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to see its connection." />
      ) : (
        <div className="grid gap-4">
          {/* Later task: health panel, Test connection, Pause. */}
          <QueryBoundary query={query}>
            {(c) => <MarafiqSettingsCard key={`${scope.key}-${c.updatedAt}`} connection={c} query={scope.query as Record<string, string> | undefined} />}
          </QueryBoundary>
        </div>
      )}
    </>
  );
}
