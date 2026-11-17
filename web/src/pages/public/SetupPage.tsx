import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Field, isEmail } from '@/components/ui/form';
import { apiPost } from '@/lib/api';
import { ENDPOINTS } from '@/lib/endpoints';
import { SESSION_KEY } from '@/lib/session';
import { AuthLayout, FormError, SubmitButton, passwordError } from './AuthLayout';

export default function SetupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = React.useState({ code: '', fullName: '', email: '', password: '' });
  const [errors, setErrors] = React.useState<Partial<Record<keyof typeof f, string>>>({});
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const setup = useMutation({
    mutationFn: () => apiPost(ENDPOINTS.setup, { code: f.code.trim(), fullName: f.fullName.trim(), email: f.email.trim(), password: f.password }, { redirectOn401: false }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: SESSION_KEY });
      navigate('/', { replace: true });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = {
      code: f.code.trim() ? undefined : 'Enter the setup code from the server log.',
      fullName: f.fullName.trim() ? undefined : 'Enter your full name.',
      email: isEmail(f.email) ? undefined : 'Enter a valid e-mail address.',
      password: passwordError(f.password),
    };
    setErrors(next);
    if (!Object.values(next).some(Boolean)) setup.mutate();
  }

  return (
    <AuthLayout title="First-time setup" subtitle="Create the platform administrator. The one-time setup code is printed in the server log at first start.">
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Field label="Setup code" error={errors.code}>{(p) => <Input {...p} autoComplete="off" autoCapitalize="characters" value={f.code} onChange={set('code')} />}</Field>
        <Field label="Full name" error={errors.fullName}>{(p) => <Input {...p} autoComplete="name" value={f.fullName} onChange={set('fullName')} />}</Field>
        <Field label="E-mail" error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="username" value={f.email} onChange={set('email')} />}</Field>
        <Field label="Password" error={errors.password} hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />}</Field>
        <FormError error={setup.error} />
        <SubmitButton pending={setup.isPending}>Create administrator</SubmitButton>
      </form>
    </AuthLayout>
  );
}
