import * as React from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiGet } from '@/lib/api';
import { ADMIN } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { useSession } from '@/lib/session';
import type { Contractor } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Field } from '@/components/ui/form';

/** Native select styled like Input (works on every phone, no portal). */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn('flex min-h-11 w-full rounded-lg border border-input bg-card px-3 py-2 text-base shadow-sm disabled:opacity-50 aria-invalid:border-danger', className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="danger" role="alert" className="my-4">
      <AlertTriangle className="size-4" aria-hidden />
      <AlertTitle>Could not load this</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{errorMessage(error)}</span>
        {onRetry && <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="size-4" aria-hidden /> Try again</Button>}
      </AlertDescription>
    </Alert>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="grid gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  );
}

/** Loading skeleton / error with retry / empty state / content, in one place. */
export function QueryBoundary<T>({
  query, isEmpty, empty, skeleton, children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  skeleton?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <ListSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{message}</p>;
}

/** Write-only secret: never shows or prefills a value. "A password is saved" + Replace, or an empty input. */
export function SecretField({
  label, hasValue, value, onChange, error, hint, id, clearable, onClear,
}: {
  label: string; hasValue: boolean; value: string; onChange: (v: string) => void; error?: string; hint?: string; id?: string;
  clearable?: boolean; onClear?: () => void;
}) {
  const [replacing, setReplacing] = React.useState(false);
  const showInput = !hasValue || replacing;
  const autoId = React.useId();
  const inputId = id ?? autoId;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      {showInput ? (
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
            placeholder={hasValue ? 'Type the new value' : ''}
          />
          {hasValue && <Button type="button" variant="outline" onClick={() => { setReplacing(false); onChange(''); }}>Cancel</Button>}
        </div>
      ) : (
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          <span className="flex-1">A {label.toLowerCase()} is saved</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setReplacing(true)} aria-label={`Replace ${label.toLowerCase()}`}>Replace</Button>
          {clearable && onClear && <Button type="button" size="sm" variant="ghost" onClick={onClear}>Remove</Button>}
        </div>
      )}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Side panel on desktop, bottom sheet on a phone. */
export function FormSheet({
  open, onOpenChange, title, description, children,
}: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="responsive" className="overflow-y-auto p-4 md:p-6">
        <SheetTitle className="pe-8 text-xl font-bold">{title}</SheetTitle>
        <SheetDescription className={description ? 'mb-3 text-sm text-muted-foreground' : 'sr-only'}>{description ?? title}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** Comma-separated list input (work teams, disciplines). */
export function ListInput({
  label, value, onChange, error, hint,
}: { label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string }) {
  return (
    <Field label={label} error={error} hint={hint ?? 'Separate with commas.'}>
      {(p) => <Input {...p} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

export function CheckRow({ id, label, checked, onChange, hint }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-[var(--primary)]" />
      <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
    </label>
  );
}

// ───── Contractor scope (platform admin picks a contractor; contractor admin is fixed) ─────
const SCOPE_KEY = 'sonu.admin.scope';
const readScope = () => { try { return sessionStorage.getItem(SCOPE_KEY) ?? ''; } catch { return ''; } };

export function useContractorScope(opts: { allowPlatform?: boolean } = {}) {
  const { user } = useSession();
  const isPlatform = user?.role === 'platform_admin';
  const [picked, setPicked] = React.useState<string>(readScope);
  const list = useQuery({
    queryKey: ['admin', 'contractors', 'picker'],
    queryFn: () => apiGet<{ items: Contractor[] }>(ADMIN.contractors),
    enabled: isPlatform,
  });
  const choose = (id: string) => {
    setPicked(id);
    try { sessionStorage.setItem(SCOPE_KEY, id); } catch { /* ignore */ }
  };
  const scopeId = isPlatform && picked ? picked : undefined;
  const ready = !isPlatform || !!picked || !!opts.allowPlatform;
  const picker = isPlatform ? (
    <div className="mb-4 flex max-w-md flex-wrap items-center gap-2">
      <Label htmlFor="scope-picker" className="shrink-0">Contractor</Label>
      <NativeSelect id="scope-picker" value={picked} onChange={(e) => choose(e.target.value)} className="min-w-0 flex-1" disabled={list.isPending}>
        <option value="">{opts.allowPlatform ? 'Platform default' : 'Choose a contractor…'}</option>
        {list.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
      </NativeSelect>
    </div>
  ) : null;
  return { isPlatform, scopeId, ready, picker, query: scopeId ? { contractorId: scopeId } : undefined, key: scopeId ?? 'own' };
}
