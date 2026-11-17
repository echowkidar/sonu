import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, Send } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/sonner';
import { CheckRow, FormError, NativeSelect, QueryBoundary, SecretField, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, errorMessage, useForm } from '@/lib/forms';
import type { MailSettings, MailTestResult } from '@/lib/types';

const optEmail = z.string().trim().refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid e-mail address.');

export const mailFormSchema = z.object({
  driver: z.enum(['log', 'smtp', 'oauth2']),
  fromAddress: optEmail,
  fromName: z.string().trim().max(500),
  replyTo: optEmail,
  signature: z.string().max(5000),
  smtpHost: z.string().trim().max(500),
  smtpPort: z.string().trim().refine((v) => v === '' || (/^\d+$/.test(v) && +v >= 1 && +v <= 65535), 'A port is a number from 1 to 65535.'),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(500),
  password: z.string().max(1000),
  oauthProvider: z.string(),
  oauthUser: optEmail,
  oauthClientId: z.string().trim().max(500),
  oauthTenant: z.string().trim().max(500),
  oauthClientSecret: z.string().max(4000),
  oauthRefreshToken: z.string().max(8000),
}).superRefine((v, ctx) => {
  const need = (key: keyof typeof v, msg: string) => { if (!String(v[key]).trim()) ctx.addIssue({ code: 'custom', path: [key], message: msg }); };
  if (v.driver !== 'log') need('fromAddress', 'Enter the sender address.');
  if (v.driver === 'smtp') { need('smtpHost', 'Enter the mail server address.'); need('smtpPort', 'Enter the port.'); }
  if (v.driver === 'oauth2') { need('oauthProvider', 'Choose Microsoft 365 or Google Workspace.'); need('oauthClientId', 'Enter the client id.'); }
});
type MailValues = z.input<typeof mailFormSchema>;

const fromSettings = (s: MailSettings): MailValues => ({
  driver: s.driver, fromAddress: s.fromAddress ?? '', fromName: s.fromName ?? '', replyTo: s.replyTo ?? '', signature: s.signature ?? '',
  smtpHost: s.smtpHost ?? '', smtpPort: s.smtpPort ? String(s.smtpPort) : '587', smtpSecure: s.smtpSecure, smtpUser: s.smtpUser ?? '',
  password: '', oauthProvider: s.oauthProvider ?? '', oauthUser: s.oauthUser ?? '', oauthClientId: s.oauthClientId ?? '', oauthTenant: s.oauthTenant ?? '',
  oauthClientSecret: '', oauthRefreshToken: '',
});

export function MailForm({ settings, query }: { settings: MailSettings; query?: Record<string, string> }) {
  const qc = useQueryClient();
  const [test, setTest] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [clearPassword, setClearPassword] = React.useState(false);

  const form = useForm<MailValues, z.output<typeof mailFormSchema>>({
    initial: fromSettings(settings),
    schema: mailFormSchema,
    submit: async (d) => {
      const body: Record<string, unknown> = {
        driver: d.driver, fromAddress: d.fromAddress, fromName: blankToNull(d.fromName), replyTo: d.replyTo, signature: blankToNull(d.signature),
        smtpHost: blankToNull(d.smtpHost), smtpPort: d.smtpPort ? Number(d.smtpPort) : null, smtpSecure: d.smtpSecure, smtpUser: blankToNull(d.smtpUser),
        oauthProvider: d.oauthProvider || null, oauthUser: d.oauthUser, oauthClientId: blankToNull(d.oauthClientId), oauthTenant: blankToNull(d.oauthTenant),
      };
      // Secrets are write-only: sent only when the user typed a replacement.
      if (d.password) body.password = d.password;
      else if (clearPassword) body.clearPassword = true;
      if (d.oauthClientSecret) body.oauthClientSecret = d.oauthClientSecret;
      if (d.oauthRefreshToken) body.oauthRefreshToken = d.oauthRefreshToken;
      const saved = await api<MailSettings>(ADMIN.mail, { method: 'PUT', body, query });
      toast.success('E-mail settings saved.');
      setClearPassword(false);
      form.reset(fromSettings(saved));
      await qc.invalidateQueries({ queryKey: ['admin', 'mail'] });
    },
  });
  const { values: v, set, errors: e } = form;

  async function sendTest() {
    setTesting(true); setTest(null);
    try {
      const r = await api<MailTestResult>(ADMIN.mailTest, { method: 'POST', query });
      setTest({ ok: true, text: `Test e-mail sent to ${r.to} using ${r.driver === 'log' ? 'the server log' : r.driver}.` });
    } catch (err) {
      setTest({ ok: false, text: errorMessage(err) });
    } finally { setTesting(false); }
  }

  return (
    <form onSubmit={form.handleSubmit} className="grid max-w-2xl gap-5" noValidate aria-label="E-mail settings">
      <FormError message={form.formError} />

      <Card>
        <CardHeader><CardTitle>Sender</CardTitle><CardDescription>How messages from SONU appear in the inbox.</CardDescription></CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sender address" error={e.fromAddress}>{(p) => <Input {...p} type="email" value={v.fromAddress} onChange={(x) => set('fromAddress', x.target.value)} />}</Field>
            <Field label="Display name" error={e.fromName}>{(p) => <Input {...p} value={v.fromName} onChange={(x) => set('fromName', x.target.value)} />}</Field>
          </div>
          <Field label="Reply-to (optional)" error={e.replyTo}>{(p) => <Input {...p} type="email" value={v.replyTo} onChange={(x) => set('replyTo', x.target.value)} />}</Field>
          <Field label="Signature (optional)" error={e.signature} hint="Added at the end of every message.">{(p) => <Textarea {...p} rows={3} value={v.signature} onChange={(x) => set('signature', x.target.value)} />}</Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Connection type" error={e.driver}>
            {(p) => (
              <NativeSelect {...p} value={v.driver} onChange={(x) => set('driver', x.target.value as MailValues['driver'])}>
                <option value="log">No sending (write to the server log)</option>
                <option value="smtp">SMTP (mail server)</option>
                <option value="oauth2">Mail service sign-in (Microsoft 365 / Google Workspace)</option>
              </NativeSelect>
            )}
          </Field>

          {v.driver === 'log' && (
            <Alert variant="info"><Info className="size-4" aria-hidden /><AlertDescription>Without settings, messages are written to the server log instead of being sent. This is meant for local runs and testing.</AlertDescription></Alert>
          )}

          {v.driver === 'smtp' && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Server address" error={e.smtpHost} className="sm:col-span-2">{(p) => <Input {...p} value={v.smtpHost} onChange={(x) => set('smtpHost', x.target.value)} placeholder="smtp.example.com" />}</Field>
                <Field label="Port" error={e.smtpPort}>{(p) => <Input {...p} inputMode="numeric" value={v.smtpPort} onChange={(x) => set('smtpPort', x.target.value)} />}</Field>
              </div>
              <CheckRow id="smtp-secure" label="Secure connection (SSL/TLS from the start)" checked={v.smtpSecure} onChange={(c) => set('smtpSecure', c)} hint="Usually on for port 465, off for port 587 (which upgrades to TLS by itself)." />
              <Field label="User name" error={e.smtpUser}>{(p) => <Input {...p} autoComplete="off" value={v.smtpUser} onChange={(x) => set('smtpUser', x.target.value)} />}</Field>
              <SecretField
                label="App password" hasValue={settings.hasPassword && !clearPassword} value={v.password} onChange={(x) => set('password', x)} error={e.password}
                clearable onClear={() => setClearPassword(true)} hint="Use an app password, not the mailbox's normal password."
              />
            </>
          )}

          {v.driver === 'oauth2' && (
            <>
              <Alert variant="warning">
                <Info className="size-4" aria-hidden />
                <AlertDescription>The mailbox must be authorised by the contractor's IT department first. They register an app in Microsoft 365 or Google Workspace and give you the client id, client secret and refresh token below.</AlertDescription>
              </Alert>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Provider" error={e.oauthProvider}>
                  {(p) => (
                    <NativeSelect {...p} value={v.oauthProvider} onChange={(x) => set('oauthProvider', x.target.value)}>
                      <option value="">Choose…</option>
                      <option value="microsoft">Microsoft 365</option>
                      <option value="google">Google Workspace</option>
                    </NativeSelect>
                  )}
                </Field>
                <Field label="Mailbox (user)" error={e.oauthUser}>{(p) => <Input {...p} type="email" value={v.oauthUser} onChange={(x) => set('oauthUser', x.target.value)} />}</Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client id" error={e.oauthClientId}>{(p) => <Input {...p} autoComplete="off" value={v.oauthClientId} onChange={(x) => set('oauthClientId', x.target.value)} />}</Field>
                {v.oauthProvider === 'microsoft' && <Field label="Tenant" error={e.oauthTenant}>{(p) => <Input {...p} value={v.oauthTenant} onChange={(x) => set('oauthTenant', x.target.value)} />}</Field>}
              </div>
              <SecretField label="Client secret" hasValue={settings.hasClientSecret} value={v.oauthClientSecret} onChange={(x) => set('oauthClientSecret', x)} error={e.oauthClientSecret} />
              <SecretField label="Refresh token" hasValue={settings.hasRefreshToken} value={v.oauthRefreshToken} onChange={(x) => set('oauthRefreshToken', x)} error={e.oauthRefreshToken} />
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={form.submitting}>{form.submitting ? 'Saving…' : 'Save settings'}</Button>
        <Button type="button" variant="outline" onClick={() => void sendTest()} disabled={testing}><Send className="size-4" aria-hidden /> {testing ? 'Sending…' : 'Send test e-mail'}</Button>
      </div>
      <p className="-mt-3 text-sm text-muted-foreground">The test e-mail goes to your own address. Save first if you changed anything.</p>
      {test && (
        <Alert variant={test.ok ? 'success' : 'danger'} role="status">
          {test.ok && <CheckCircle2 className="size-4" aria-hidden />}
          <div><AlertTitle>{test.ok ? 'Test e-mail sent' : 'Test e-mail failed'}</AlertTitle><AlertDescription>{test.text}</AlertDescription></div>
        </Alert>
      )}
    </form>
  );
}

export default function AdminEmailPage() {
  const scope = useContractorScope({ allowPlatform: true });
  const query = useQuery({
    queryKey: ['admin', 'mail', scope.key],
    queryFn: () => apiGet<MailSettings>(ADMIN.mail, { query: scope.query }),
    enabled: scope.ready,
  });
  return (
    <>
      <PageHeader title="E-mail" description="Where invitations, reminders and notices are sent from." />
      {scope.picker}
      {scope.isPlatform && !scope.scopeId && <p className="mb-4 text-sm text-muted-foreground">Editing the platform default, used when a contractor has no settings of its own.</p>}
      <QueryBoundary query={query} empty={<EmptyState title="No settings" />}>
        {(s) => <MailForm key={`${scope.key}-${s.updatedAt ?? 'new'}`} settings={s} query={scope.query as Record<string, string> | undefined} />}
      </QueryBoundary>
    </>
  );
}
