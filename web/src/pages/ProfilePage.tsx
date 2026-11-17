import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, KeyRound, Languages, Palette, UserRound } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/form';
import { toast } from '@/components/ui/sonner';
import { CheckRow, FormError, NativeSelect, QueryBoundary } from '@/components/admin/kit';
import { useThemeContext } from '@/components/shell/ThemeContext';
import { api, apiGet } from '@/lib/api';
import { ME } from '@/lib/endpoints';
import { blankToNull, useForm } from '@/lib/forms';
import { useSession } from '@/lib/session';
import { ROLE_LABELS } from '@/lib/roles';
import type { UserView } from '@/lib/types';
import type { ThemeMode } from '@/lib/theme';
import { disablePush, enablePush, isPushEnabled, pushSupported } from '@/lib/push';

const time = z.string().refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Use HH:MM, e.g. 21:00.');

const detailsSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name.').max(120),
  mobile: z.string().trim().refine((v) => v === '' || /^\+\d{8,15}$/.test(v), 'Mobile with country code, no spaces, e.g. +97455550100.'),
});

export const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string().min(10, 'Use at least 10 characters.').max(200).refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letters and at least one digit.'),
  confirm: z.string(),
}).refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The two passwords are not the same.' });

const prefsSchema = z.object({ notifyEmail: z.boolean(), notifyPush: z.boolean(), notifyWhatsapp: z.boolean(), quietHoursStart: time, quietHoursEnd: time });

function useSave() {
  const qc = useQueryClient();
  return async (patch: Record<string, unknown>) => {
    await api<UserView>(ME.profile, { method: 'PATCH', body: patch });
    await qc.invalidateQueries({ queryKey: ['me-profile'] });
    await qc.invalidateQueries({ queryKey: ['session'] });
  };
}

function DetailsCard({ me }: { me: UserView }) {
  const save = useSave();
  const form = useForm({
    initial: { fullName: me.fullName, mobile: me.mobile ?? '' }, schema: detailsSchema,
    submit: async (d) => {
      // Send the mobile only when it changed: the server clears the "verified" mark on every mobile write.
      const mobile = blankToNull(d.mobile);
      await save({ fullName: d.fullName, ...(mobile !== (me.mobile ?? null) ? { mobile } : {}) });
      toast.success('Details saved.');
    },
  });
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><UserRound className="size-5" aria-hidden /> Your details</CardTitle><CardDescription>{me.email} · {ROLE_LABELS[me.role]}</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit} className="grid gap-4" noValidate aria-label="Your details">
          <FormError message={form.formError} />
          <Field label="Full name" error={form.errors.fullName}>{(p) => <Input {...p} value={form.values.fullName} onChange={(e) => form.set('fullName', e.target.value)} />}</Field>
          <Field label="Mobile" error={form.errors.mobile} hint="With country code, e.g. +97455550100.">{(p) => <Input {...p} type="tel" value={form.values.mobile} onChange={(e) => form.set('mobile', e.target.value)} />}</Field>
          <div><Button type="submit" disabled={form.submitting}>Save details</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const form = useForm({
    initial: { currentPassword: '', newPassword: '', confirm: '' }, schema: passwordSchema,
    submit: async (d) => {
      await api(ME.password, { method: 'POST', body: { currentPassword: d.currentPassword, newPassword: d.newPassword } });
      toast.success('Password changed. Other devices are signed out.');
      form.reset({ currentPassword: '', newPassword: '', confirm: '' });
    },
    pathMap: { currentPassword: 'currentPassword', newPassword: 'newPassword' },
  });
  const { values: v, errors: e, set } = form;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-5" aria-hidden /> Password</CardTitle><CardDescription>At least 10 characters, with letters and a digit.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit} className="grid gap-4" noValidate aria-label="Change password">
          <FormError message={form.formError} />
          <Field label="Current password" error={e.currentPassword}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={v.currentPassword} onChange={(x) => set('currentPassword', x.target.value)} />}</Field>
          <Field label="New password" error={e.newPassword}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={v.newPassword} onChange={(x) => set('newPassword', x.target.value)} />}</Field>
          <Field label="New password again" error={e.confirm}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={v.confirm} onChange={(x) => set('confirm', x.target.value)} />}</Field>
          <div><Button type="submit" disabled={form.submitting}>Change password</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function PreferencesCard({ me }: { me: UserView }) {
  const save = useSave();
  const form = useForm({
    initial: { notifyEmail: me.notifyEmail, notifyPush: me.notifyPush, notifyWhatsapp: me.notifyWhatsapp, quietHoursStart: me.quietHoursStart ?? '', quietHoursEnd: me.quietHoursEnd ?? '' },
    schema: prefsSchema,
    submit: async (d) => { await save({ ...d, quietHoursStart: blankToNull(d.quietHoursStart), quietHoursEnd: blankToNull(d.quietHoursEnd) }); toast.success('Preferences saved.'); },
  });
  const { values: v, errors: e, set } = form;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><BellRing className="size-5" aria-hidden /> How we notify you</CardTitle><CardDescription>Choose where reminders and assignments reach you.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit} className="grid gap-3" noValidate aria-label="Notification preferences">
          <FormError message={form.formError} />
          <CheckRow id="p-email" label="E-mail" checked={v.notifyEmail} onChange={(c) => set('notifyEmail', c)} />
          <CheckRow id="p-push" label="Push on my phone" checked={v.notifyPush} onChange={(c) => set('notifyPush', c)} />
          <CheckRow id="p-wa" label="WhatsApp" checked={v.notifyWhatsapp} onChange={(c) => set('notifyWhatsapp', c)} hint={me.mobile ? undefined : 'Add your mobile above first.'} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quiet hours from" error={e.quietHoursStart} hint="No push or WhatsApp in this period.">{(p) => <Input {...p} type="time" value={v.quietHoursStart} onChange={(x) => set('quietHoursStart', x.target.value)} />}</Field>
            <Field label="Quiet hours until" error={e.quietHoursEnd}>{(p) => <Input {...p} type="time" value={v.quietHoursEnd} onChange={(x) => set('quietHoursEnd', x.target.value)} />}</Field>
          </div>
          <div><Button type="submit" disabled={form.submitting}>Save preferences</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function PushCard() {
  const [push, setPush] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void isPushEnabled().then(setPush).catch(() => undefined); }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      if (on) {
        const r = await enablePush();
        if (r === 'denied') toast.error('Notifications are blocked in your browser settings.');
        else if (r === 'unsupported') toast.error('This browser does not support push notifications.');
        setPush(r === 'enabled');
      } else {
        await disablePush();
        setPush(false);
      }
    } catch {
      toast.error('Could not change notifications. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><BellRing className="size-5" aria-hidden /> Notifications on this device</CardTitle></CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <Label htmlFor="push" className="text-base">Push notifications</Label>
        <Switch id="push" checked={push} disabled={busy || !pushSupported()} onCheckedChange={(v) => void toggle(v)} />
      </CardContent>
    </Card>
  );
}

function LooksCard({ me }: { me: UserView }) {
  const theme = useThemeContext();
  const save = useSave();
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Palette className="size-5" aria-hidden /> Look and language</CardTitle></CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="theme">Theme</Label>
          <NativeSelect id="theme" value={theme.mode} onChange={(e) => theme.setMode(e.target.value as ThemeMode)}>
            <option value="system">Same as my device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="language" className="flex items-center gap-1"><Languages className="size-4" aria-hidden /> Language</Label>
          <NativeSelect id="language" defaultValue={me.language} onChange={(e) => void save({ language: e.target.value }).then(() => toast.success('Language saved.')).catch(() => toast.error('Could not save the language.'))}>
            <option>English</option><option>Arabic</option><option>Hindi</option>
          </NativeSelect>
          <p className="text-sm text-muted-foreground">Saved for e-mails and messages to you. Screens are in English for now.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProfilePage() {
  const { user } = useSession();
  const query = useQuery({ queryKey: ['me-profile'], queryFn: () => apiGet<UserView>(ME.profile) });
  return (
    <>
      <PageHeader title="Profile" description={user?.contractorName ?? undefined} />
      <div className="grid max-w-xl gap-4">
        <QueryBoundary query={query}>
          {(me) => (
            <>
              {/* No remount keys: saving one card must not wipe unsaved edits in the other. */}
              <DetailsCard me={me} />
              <PreferencesCard me={me} />
              <LooksCard me={me} />
            </>
          )}
        </QueryBoundary>
        <PushCard />
        <PasswordCard />
      </div>
    </>
  );
}
