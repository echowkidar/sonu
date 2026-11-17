import * as React from 'react';
import { Label } from './label';
import { cn } from '@/lib/utils';

/**
 * Minimal form helper: label + control + hint + error with correct aria wiring.
 * Usage: <Field label="Email" error={errors.email}>{(p) => <Input {...p} />}</Field>
 */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  className?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = React.useId();
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': descId })}
      {error ? (
        <p id={descId} className="text-sm text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p id={descId} className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export type FieldErrors<T extends string> = Partial<Record<T, string>>;

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
