import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Pencil, X } from 'lucide-react';
import { z } from 'zod';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/sonner';
import { FormError, NativeSelect, QueryBoundary, useContractorScope } from '@/components/admin/kit';
import { api, apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { serverErrors, validate, type Errors } from '@/lib/forms';
import type { DeadlineRule } from '@/lib/types';

export const UNIT_LABELS: Record<DeadlineRule['limitUnit'], string> = {
  days: 'Calendar days', working_days: 'Working days', hours: 'Hours', same_day: 'Same day', date_field: 'Date in the record',
};
const NEEDS_VALUE: DeadlineRule['limitUnit'][] = ['days', 'working_days', 'hours'];

type Warning = Record<string, unknown>;
const isEvery = (w: Warning[]) => w.length > 0 && w.every((x) => 'every' in x);

export function warningsToText(w: Warning[]): string {
  if (isEvery(w)) return w.map((x) => String(x.every)).join(', ');
  return w.map((x) => String(x.value ?? '')).filter((s) => s !== '').join(', ');
}
export function describeWarnings(w: Warning[]): string {
  if (w.length === 0) return 'None';
  if (isEvery(w)) return `Every ${w.map((x) => `${x.every} ${x.unit ?? 'days'}`).join(', ')}`;
  return w.map((x) => `${x.value} ${x.unit ?? 'days'}`).join(', ');
}
/** Rebuild the warnings array from the text while keeping each warning's shape and unit. */
export function textToWarnings(text: string, old: Warning[]): Warning[] {
  const nums = text.split(/[,;\s]+/).filter(Boolean).map(Number);
  const unit = (old[0]?.unit as string | undefined) ?? 'days';
  if (isEvery(old)) return nums.slice(0, 1).map((n) => ({ ...old[0], every: n, unit }));
  return nums.map((n, i) => ({ ...(old[i] ?? {}), value: n, unit: (old[i]?.unit as string | undefined) ?? unit }));
}

export const ruleRowSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name.').max(200),
  limitUnit: z.enum(['hours', 'days', 'working_days', 'same_day', 'date_field']),
  limitValue: z.string().trim(),
  warnings: z.string().trim().refine((v) => v.split(/[,;\s]+/).filter(Boolean).every((n) => /^-?\d+$/.test(n) && Math.abs(+n) <= 3650), 'Use whole numbers separated by commas.'),
  onBreach: z.string().trim().min(1, 'Say what happens when it is late.').max(300),
  active: z.boolean(),
}).superRefine((v, ctx) => {
  if (NEEDS_VALUE.includes(v.limitUnit) && !/^\d+$/.test(v.limitValue)) ctx.addIssue({ code: 'custom', path: ['limitValue'], message: 'Enter a whole number.' });
  else if (v.limitValue && +v.limitValue > 3650) ctx.addIssue({ code: 'custom', path: ['limitValue'], message: 'At most 3650.' });
});

function RuleRow({ rule, scopeQuery, onClose }: { rule: DeadlineRule; scopeQuery?: Record<string, string>; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = React.useState({
    name: rule.name, limitUnit: rule.limitUnit, limitValue: rule.limitValue === null ? '' : String(rule.limitValue),
    warnings: warningsToText(rule.warnings), onBreach: rule.onBreach, active: rule.active,
  });
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => { setV((s) => ({ ...s, [k]: val })); setErrors((s) => ({ ...s, [k]: '' })); };

  async function save() {
    const { data, errors: errs } = validate(ruleRowSchema, v);
    if (!data) { setErrors(errs); return; }
    setBusy(true); setFormError(null);
    try {
      await api(ADMIN.deadlineRule(rule.id), {
        method: 'PATCH',
        query: scopeQuery,
        body: {
          name: data.name, limitUnit: data.limitUnit,
          limitValue: NEEDS_VALUE.includes(data.limitUnit) ? Number(data.limitValue) : data.limitUnit === 'same_day' ? 0 : null,
          warnings: textToWarnings(data.warnings, rule.warnings), onBreach: data.onBreach, active: data.active,
        },
      });
      toast.success('Rule saved.');
      await qc.invalidateQueries({ queryKey: ['admin', 'deadline-rules'] });
      onClose();
    } catch (e) {
      const s = serverErrors(e);
      setErrors(s.fields); setFormError(s.message);
    } finally { setBusy(false); }
  }

  const err = (k: string) => errors[k] ? <p className="text-xs text-danger" role="alert">{errors[k]}</p> : null;
  return (
    <TableRow data-testid="rule-edit-row" className="bg-primary-soft/40 align-top">
      <TableCell className="min-w-56">
        <Input aria-label="Rule name" value={v.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!errors.name} />{err('name')}
        <p className="mt-1 text-xs text-muted-foreground">{rule.appliesTo}</p>
      </TableCell>
      <TableCell className="min-w-44">
        <div className="flex gap-1">
          <Input aria-label="Limit" className="w-20" inputMode="numeric" value={v.limitValue} disabled={!NEEDS_VALUE.includes(v.limitUnit)} onChange={(e) => set('limitValue', e.target.value)} aria-invalid={!!errors.limitValue} />
          <NativeSelect aria-label="Unit" value={v.limitUnit} onChange={(e) => set('limitUnit', e.target.value as DeadlineRule['limitUnit'])}>
            {(Object.keys(UNIT_LABELS) as DeadlineRule['limitUnit'][]).map((u) => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
          </NativeSelect>
        </div>{err('limitValue')}
      </TableCell>
      <TableCell className="min-w-32">
        <Input aria-label={isEvery(rule.warnings) ? 'Warn every (days)' : 'Warning days'} value={v.warnings} onChange={(e) => set('warnings', e.target.value)} aria-invalid={!!errors.warnings} />{err('warnings')}
        <p className="mt-1 text-xs text-muted-foreground">{isEvery(rule.warnings) ? 'Remind every N days.' : 'Days, e.g. 8, 11.'}</p>
      </TableCell>
      <TableCell className="min-w-56"><Input aria-label="On breach" value={v.onBreach} onChange={(e) => set('onBreach', e.target.value)} aria-invalid={!!errors.onBreach} />{err('onBreach')}</TableCell>
      <TableCell>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-[var(--primary)]" checked={v.active} onChange={(e) => set('active', e.target.checked)} /> Active</label>
      </TableCell>
      <TableCell className="min-w-28">
        <div className="flex gap-1">
          <Button size="sm" onClick={() => void save()} disabled={busy} aria-label={`Save ${rule.name}`}><Check className="size-4" /></Button>
          <Button size="sm" variant="outline" onClick={onClose} disabled={busy} aria-label="Cancel editing"><X className="size-4" /></Button>
        </div>
        <FormError message={formError} />
      </TableCell>
    </TableRow>
  );
}

export function limitText(r: Pick<DeadlineRule, 'limitValue' | 'limitUnit' | 'limitField'>): string {
  if (r.limitUnit === 'same_day') return 'Same day';
  if (r.limitUnit === 'date_field') return r.limitField ? `Date in ${r.limitField}` : 'Date in the record';
  const unit = r.limitUnit === 'working_days' ? 'working days' : r.limitUnit === 'hours' ? 'hours' : 'calendar days';
  return `${r.limitValue ?? ''} ${unit}`.trim();
}

export default function AdminRulesPage() {
  const scope = useContractorScope();
  const [editing, setEditing] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: ['admin', 'deadline-rules', scope.key],
    queryFn: () => apiGet<{ items: DeadlineRule[] }>(ADMIN.deadlineRules, { query: scope.query }),
    enabled: scope.ready,
  });
  const rfe = query.data?.items.find((r) => r.key === 'rfe_submit_14d');

  return (
    <>
      <PageHeader title="Deadline rules" description="How long each step may take, when to warn, and who is told when it is late." />
      {scope.picker}
      {rfe && (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 text-sm" data-testid="rfe-limit">
          <Clock className="size-4 text-primary" aria-hidden />
          <span><strong>RFE limit: {rfe.limitValue} {rfe.limitUnit === 'working_days' ? 'working days' : 'days'} from Date Trade Assigned</strong></span>
          <span className="text-muted-foreground">(rule "{rfe.name}")</span>
          {!rfe.active && <StatusBadge tone="warning">Switched off</StatusBadge>}
        </p>
      )}
      {!scope.ready ? (
        <EmptyState illustration="search" title="Choose a contractor" description="Pick a contractor above to see its rules." />
      ) : (
        <QueryBoundary query={query} isEmpty={(d) => d.items.length === 0} empty={<EmptyState illustration="build" title="No rules yet" description="Rules are created when a contractor is added." />}>
          {(d) => (
            <div className="overflow-auto rounded-xl border bg-card">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Rule</TableHead><TableHead>Limit</TableHead><TableHead>Warn</TableHead><TableHead>When late</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Edit</span></TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {d.items.map((r) => editing === r.id ? (
                    <RuleRow key={r.id} rule={r} scopeQuery={scope.query} onClose={() => setEditing(null)} />
                  ) : (
                    <TableRow key={r.id} data-testid="rule-row">
                      <TableCell className="min-w-56 whitespace-normal"><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.appliesTo}</div></TableCell>
                      <TableCell className="whitespace-nowrap">{limitText(r)}</TableCell>
                      <TableCell className="whitespace-nowrap">{describeWarnings(r.warnings)}</TableCell>
                      <TableCell className="min-w-48 whitespace-normal">{r.onBreach}</TableCell>
                      <TableCell><StatusBadge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'On' : 'Off'}</StatusBadge></TableCell>
                      <TableCell><Button size="sm" variant="outline" aria-label={`Edit ${r.name} (${r.appliesTo})`} disabled={!!editing} onClick={() => setEditing(r.id)}><Pencil className="size-4" /></Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </QueryBoundary>
      )}
    </>
  );
}
