import * as React from 'react';
import type { z } from 'zod';
import { ApiError } from './api';

export type Errors = Record<string, string>;

/** Validate with zod; errors are keyed by the dotted path of the first failing issue per field. */
export function validate<T>(schema: z.ZodType<T>, values: unknown): { data: T | null; errors: Errors } {
  const r = schema.safeParse(values);
  if (r.success) return { data: r.data, errors: {} };
  const errors: Errors = {};
  for (const i of r.error.issues) {
    const k = i.path.join('.') || '_';
    if (!errors[k]) errors[k] = i.message;
  }
  return { data: null, errors };
}

/** Map a server `validation_error` ({path, message}[]) to field errors. `pathMap` renames e.g. admin.email -> adminEmail. */
export function serverErrors(e: unknown, pathMap: Record<string, string> = {}): { fields: Errors; message: string | null } {
  if (!(e instanceof ApiError)) return { fields: {}, message: 'Something went wrong. Try again.' };
  const fields: Errors = {};
  if (e.code === 'validation_error' && Array.isArray(e.details)) {
    for (const d of e.details as { path?: string; message?: string }[]) {
      const p = d.path ?? '';
      const key = pathMap[p] ?? p;
      if (key && !fields[key]) fields[key] = d.message ?? 'Not valid.';
    }
    if (Object.keys(fields).length) return { fields, message: null };
  }
  return { fields, message: e.message };
}

export interface UseFormOptions<V, D> {
  initial: V;
  schema: z.ZodType<D>;
  submit: (data: D, values: V) => Promise<unknown>;
  /** Server path -> form key. */
  pathMap?: Record<string, string>;
}

export function useForm<V extends Record<string, unknown>, D>(o: UseFormOptions<V, D>) {
  const [values, setValues] = React.useState<V>(o.initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const set = React.useCallback(<K extends keyof V>(k: K, v: V[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((s) => { if (!s[k as string]) return s; const n = { ...s }; delete n[k as string]; return n; });
  }, []);

  const reset = React.useCallback((v: V) => { setValues(v); setErrors({}); setFormError(null); }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    setFormError(null);
    const { data, errors: errs } = validate(o.schema, values);
    if (!data) { setErrors(errs); return; }
    setErrors({});
    setSubmitting(true);
    try {
      await o.submit(data, values);
    } catch (err) {
      const s = serverErrors(err, o.pathMap);
      setErrors(s.fields);
      setFormError(s.message);
    } finally {
      setSubmitting(false);
    }
  };

  return { values, set, reset, errors, formError, setFormError, submitting, handleSubmit };
}

export const splitList = (s: string): string[] => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
export const blankToNull = (s: string | undefined | null): string | null => { const t = (s ?? '').trim(); return t ? t : null; };

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
}

export function formatDateTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
