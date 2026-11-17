import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, isEmail } from '@/components/ui/form';
import { apiPost } from '@/lib/api';
import { ENDPOINTS } from '@/lib/endpoints';
import { AuthLayout, BackToLogin, FormError, SubmitButton } from './AuthLayout';

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('');
  const [error, setError] = React.useState<string>();
  const m = useMutation({ mutationFn: () => apiPost(ENDPOINTS.forgotPassword, { email: email.trim() }, { redirectOn401: false }) });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const err = isEmail(email) ? undefined : 'Enter a valid e-mail address.';
    setError(err);
    if (!err) m.mutate();
  }

  return (
    <AuthLayout title="Forgot your password?" subtitle="We will e-mail you a link to choose a new one." footer={<BackToLogin />}>
      {m.isSuccess ? (
        <Alert variant="success">
          <MailCheck />
          <AlertDescription>If that address has an account, a reset link is on its way. The link works once and expires soon.</AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-4">
          <Field label="E-mail" error={error}>{(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <FormError error={m.error} />
          <SubmitButton pending={m.isPending}>Send reset link</SubmitButton>
        </form>
      )}
    </AuthLayout>
  );
}
