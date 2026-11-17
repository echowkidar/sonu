import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Field, isEmail } from '@/components/ui/form';
import { apiPost } from '@/lib/api';
import { ENDPOINTS } from '@/lib/endpoints';
import { SESSION_KEY } from '@/lib/session';
import { AuthLayout, FormError, SubmitButton } from './AuthLayout';

/** Only same-site relative paths are allowed as the post-login target. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export default function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<{ email?: string; password?: string }>({});

  const login = useMutation({
    mutationFn: () => apiPost(ENDPOINTS.login, { email: email.trim(), password }, { redirectOn401: false }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: SESSION_KEY });
      navigate(safeNext(params.get('next')) ?? '/', { replace: true });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = {
      email: isEmail(email) ? undefined : 'Enter your e-mail address.',
      password: password ? undefined : 'Enter your password.',
    };
    setErrors(next);
    if (!next.email && !next.password) login.mutate();
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Use the e-mail address your account was created with."
      footer={<Link to="/forgot-password" className="font-medium text-primary hover:underline">Forgot your password?</Link>}
    >
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Field label="E-mail" error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password" error={errors.password}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <FormError error={login.error} />
        <SubmitButton pending={login.isPending}>Sign in</SubmitButton>
      </form>
    </AuthLayout>
  );
}
