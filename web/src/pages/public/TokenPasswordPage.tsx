import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field } from '@/components/ui/form';
import { apiPost } from '@/lib/api';
import { ENDPOINTS } from '@/lib/endpoints';
import { AuthLayout, BackToLogin, FormError, SubmitButton, passwordError } from './AuthLayout';

/** Shared by /accept-invite and /reset-password: both take ?token=... and a new password. */
function TokenPasswordPage({ endpoint, title, subtitle, cta }: { endpoint: string; title: string; subtitle: string; cta: string }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<{ password?: string; confirm?: string }>({});

  const m = useMutation({
    mutationFn: () => apiPost(endpoint, { token, password }, { redirectOn401: false }),
    onSuccess: () => navigate('/login', { replace: true }),
  });

  if (!token) {
    return (
      <AuthLayout title={title} footer={<BackToLogin />}>
        <Alert variant="danger"><AlertDescription>This link is incomplete. Open the link from your e-mail again, or ask for a new one.</AlertDescription></Alert>
      </AuthLayout>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = { password: passwordError(password), confirm: confirm === password ? undefined : 'The passwords do not match.' };
    setErrors(next);
    if (!next.password && !next.confirm) m.mutate();
  }

  return (
    <AuthLayout title={title} subtitle={subtitle} footer={<Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <Field label="New password" error={errors.password} hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Field label="Repeat password" error={errors.confirm}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        <FormError error={m.error} />
        <SubmitButton pending={m.isPending}>{cta}</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  return <TokenPasswordPage endpoint={ENDPOINTS.acceptInvite} title="Welcome to SONU" subtitle="Choose a password to activate your account." cta="Activate account" />;
}

export function ResetPasswordPage() {
  return <TokenPasswordPage endpoint={ENDPOINTS.resetPassword} title="Choose a new password" subtitle="Your old password stops working once you save." cta="Save password" />;
}
