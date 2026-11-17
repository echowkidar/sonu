import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/sonner';
import { CheckRow, FormError, NativeSelect, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { blankToNull, useForm } from '@/lib/forms';
import type { MessagingSettings } from '@/lib/types';

/** Server hard caps (server/src/comm/whatsapp WA_HARD_CAPS). */
const CAPS = { minIntervalSecondsMin: 10, minIntervalSecondsMax: 3600, dailyLimitMin: 1, dailyLimitMax: 500 };
const intIn = (min: number, max: number) =>
  z.string().trim().refine((v) => /^\d+$/.test(v) && +v >= min && +v <= max, `A number from ${min} to ${max}.`);
const time = z.string().refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Use HH:MM, e.g. 21:00.');
export const messagingSchema = z.object({
  whatsappMode: z.enum(['click_to_chat', 'linked_session']),
  pushEnabled: z.boolean(),
  minIntervalSeconds: intIn(CAPS.minIntervalSecondsMin, CAPS.minIntervalSecondsMax),
  dailyLimit: intIn(CAPS.dailyLimitMin, CAPS.dailyLimitMax),
  quietHoursStart: time,
  quietHoursEnd: time,
  acknowledgeRisk: z.boolean(),
});
type MsgValues = z.input<typeof messagingSchema>;

/** WhatsApp / push settings card. The later task adds the QR linking panel next to it. */
export function MessagingSettingsCard({ settings, query }: { settings: MessagingSettings; query?: Record<string, string> }) {
  const qc = useQueryClient();
  const form = useForm<MsgValues, z.output<typeof messagingSchema>>({
    initial: {
      whatsappMode: settings.whatsappMode ?? 'click_to_chat', pushEnabled: settings.pushEnabled ?? true,
      minIntervalSeconds: String(settings.rateLimit?.minIntervalSeconds ?? 20), dailyLimit: String(settings.rateLimit?.dailyLimit ?? 200),
      quietHoursStart: settings.quietHoursStart ?? '', quietHoursEnd: settings.quietHoursEnd ?? '', acknowledgeRisk: false,
    },
    schema: messagingSchema,
    submit: async (d) => {
      const switchingToLinked = d.whatsappMode === 'linked_session' && settings.whatsappMode !== 'linked_session';
      await api(ADMIN.messaging, {
        method: 'PUT', query,
        body: {
          whatsappMode: d.whatsappMode, pushEnabled: d.pushEnabled,
          ...(switchingToLinked ? { acknowledgeRisk: d.acknowledgeRisk } : {}),
          rateLimit: { minIntervalSeconds: Number(d.minIntervalSeconds), dailyLimit: Number(d.dailyLimit) },
          quietHoursStart: blankToNull(d.quietHoursStart), quietHoursEnd: blankToNull(d.quietHoursEnd),
        },
      });
      toast.success('Messaging settings saved.');
      await qc.invalidateQueries({ queryKey: ['admin', 'messaging'] });
    },
  });
  const { values: v, set, errors: e } = form;
  const needsAck = v.whatsappMode === 'linked_session' && settings.whatsappMode !== 'linked_session';
  return (
    <Card>
      <CardHeader><CardTitle>Settings</CardTitle><CardDescription>How SONU reaches people besides e-mail.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit} className="grid max-w-xl gap-4" noValidate aria-label="Messaging settings">
          <FormError message={form.formError} />
          <Field label="WhatsApp mode" error={e.whatsappMode} hint="Click to chat opens WhatsApp on the sender's own phone with the message ready. Nothing is sent automatically.">
            {(p) => (
              <NativeSelect {...p} value={v.whatsappMode} onChange={(x) => set('whatsappMode', x.target.value as MsgValues['whatsappMode'])}>
                <option value="click_to_chat">Click to chat (recommended)</option>
                <option value="linked_session">Linked session (QR scan, unofficial)</option>
              </NativeSelect>
            )}
          </Field>
          {v.whatsappMode === 'linked_session' && (
            <Alert variant="warning" role="alert"><AlertTriangle className="size-4" aria-hidden /><AlertDescription>{settings.riskWarning}</AlertDescription></Alert>
          )}
          {needsAck && (
            <CheckRow id="ack-risk" label="I understand the risk and want to use a linked session." checked={v.acknowledgeRisk} onChange={(c) => set('acknowledgeRisk', c)} />
          )}
          <CheckRow id="push-enabled" label="Push notifications on phones" checked={v.pushEnabled} onChange={(c) => set('pushEnabled', c)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Seconds between WhatsApp messages" error={e.minIntervalSeconds} hint={`${CAPS.minIntervalSecondsMin}–${CAPS.minIntervalSecondsMax}. Linked session only.`}>{(p) => <Input {...p} inputMode="numeric" value={v.minIntervalSeconds} onChange={(x) => set('minIntervalSeconds', x.target.value)} />}</Field>
            <Field label="WhatsApp messages per day" error={e.dailyLimit} hint={`${CAPS.dailyLimitMin}–${CAPS.dailyLimitMax}. Linked session only.`}>{(p) => <Input {...p} inputMode="numeric" value={v.dailyLimit} onChange={(x) => set('dailyLimit', x.target.value)} />}</Field>
            <Field label="Quiet from" error={e.quietHoursStart}>{(p) => <Input {...p} type="time" value={v.quietHoursStart} onChange={(x) => set('quietHoursStart', x.target.value)} />}</Field>
            <Field label="Quiet until" error={e.quietHoursEnd}>{(p) => <Input {...p} type="time" value={v.quietHoursEnd} onChange={(x) => set('quietHoursEnd', x.target.value)} />}</Field>
          </div>
          <div><Button type="submit" disabled={form.submitting || (needsAck && !v.acknowledgeRisk)}>{form.submitting ? 'Saving…' : 'Save settings'}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function AdminMessagingPage() {
  const scope = useContractorScope();
  const query = useQuery({
    queryKey: ['admin', 'messaging', scope.key],
    queryFn: () => apiGet<MessagingSettings>(ADMIN.messaging, { query: scope.query }),
    enabled: scope.ready,
  });
  return (
    <>
      <PageHeader title="Messaging" description="WhatsApp, push and quiet hours." />
      {scope.picker}
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to see its messaging settings." />
      ) : (
        <div className="grid gap-4">
          {/* Later task: WhatsApp QR linking panel and risk warning card. */}
          <QueryBoundary query={query}>
            {(s) => <MessagingSettingsCard key={`${scope.key}-${s.updatedAt}`} settings={s} query={scope.query as Record<string, string> | undefined} />}
          </QueryBoundary>
        </div>
      )}
    </>
  );
}
