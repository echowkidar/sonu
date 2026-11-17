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

const time = z.string().refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Use HH:MM, e.g. 21:00.');
export const messagingSchema = z.object({
  whatsappMode: z.enum(['click_to_chat', 'linked_session']),
  whatsappNumber: z.string().trim().refine((v) => v === '' || /^\+\d{8,15}$/.test(v), 'Number with country code, no spaces, e.g. +97455550100.'),
  pushEnabled: z.boolean(),
  rateLimitPerMinute: z.string().trim().refine((v) => /^\d+$/.test(v) && +v >= 1 && +v <= 120, 'A number from 1 to 120.'),
  quietHoursStart: time,
  quietHoursEnd: time,
});
type MsgValues = z.input<typeof messagingSchema>;

/** WhatsApp / push settings card. The later task adds the QR linking panel next to it. */
export function MessagingSettingsCard({ settings, query }: { settings: MessagingSettings; query?: Record<string, string> }) {
  const qc = useQueryClient();
  const form = useForm<MsgValues, z.output<typeof messagingSchema>>({
    initial: {
      whatsappMode: settings.whatsappMode ?? 'click_to_chat', whatsappNumber: settings.whatsappNumber ?? '', pushEnabled: settings.pushEnabled ?? true,
      rateLimitPerMinute: String(settings.rateLimitPerMinute ?? 20), quietHoursStart: settings.quietHoursStart ?? '', quietHoursEnd: settings.quietHoursEnd ?? '',
    },
    schema: messagingSchema,
    submit: async (d) => {
      await api(ADMIN.messaging, {
        method: 'PUT', query,
        body: {
          whatsappMode: d.whatsappMode, whatsappNumber: blankToNull(d.whatsappNumber), pushEnabled: d.pushEnabled,
          rateLimitPerMinute: Number(d.rateLimitPerMinute), quietHoursStart: blankToNull(d.quietHoursStart), quietHoursEnd: blankToNull(d.quietHoursEnd),
        },
      });
      toast.success('Messaging settings saved.');
      await qc.invalidateQueries({ queryKey: ['admin', 'messaging'] });
    },
  });
  const { values: v, set, errors: e } = form;
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
            <Alert variant="warning" role="alert"><AlertTriangle className="size-4" aria-hidden /><AlertDescription>{settings.linkedSessionWarning}</AlertDescription></Alert>
          )}
          <Field label="WhatsApp number (optional)" error={e.whatsappNumber} hint="The number messages are sent from, with country code.">{(p) => <Input {...p} type="tel" value={v.whatsappNumber} onChange={(x) => set('whatsappNumber', x.target.value)} />}</Field>
          <CheckRow id="push-enabled" label="Push notifications on phones" checked={v.pushEnabled} onChange={(c) => set('pushEnabled', c)} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Messages per minute" error={e.rateLimitPerMinute}>{(p) => <Input {...p} inputMode="numeric" value={v.rateLimitPerMinute} onChange={(x) => set('rateLimitPerMinute', x.target.value)} />}</Field>
            <Field label="Quiet from" error={e.quietHoursStart}>{(p) => <Input {...p} type="time" value={v.quietHoursStart} onChange={(x) => set('quietHoursStart', x.target.value)} />}</Field>
            <Field label="Quiet until" error={e.quietHoursEnd}>{(p) => <Input {...p} type="time" value={v.quietHoursEnd} onChange={(x) => set('quietHoursEnd', x.target.value)} />}</Field>
          </div>
          <div><Button type="submit" disabled={form.submitting}>{form.submitting ? 'Saving…' : 'Save settings'}</Button></div>
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
