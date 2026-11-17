import * as React from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Card } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SceneBackdrop } from '@/scene/SceneBackdrop';
import { ApiError } from '@/lib/api';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="relative grid min-h-dvh place-items-center px-4 py-10">
      <SceneBackdrop />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center"><Logo /></div>
        <Card className="bg-card/95 p-5 shadow-lg backdrop-blur sm:p-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-sm">{footer}</div>}
      </div>
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return <Alert variant="danger"><AlertDescription>{msg}</AlertDescription></Alert>;
}

export function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full">
      {pending && <Loader2 className="size-5 animate-spin" aria-hidden />}
      {children}
    </Button>
  );
}

export const BackToLogin = () => <Link to="/login" className="font-medium text-primary hover:underline">Back to sign in</Link>;

/** Password rule shared by setup, invite and reset. The server enforces its own policy as well. */
export const MIN_PASSWORD = 10;
export function passwordError(p: string): string | undefined {
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  return undefined;
}
