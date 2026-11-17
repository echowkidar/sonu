import * as React from 'react';
import { BellRing } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { useSession } from '@/lib/session';
import { ROLE_LABELS } from '@/lib/roles';
import { disablePush, enablePush, isPushEnabled, pushSupported } from '@/lib/push';

export default function ProfilePage() {
  const { user } = useSession();
  const [push, setPush] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { void isPushEnabled().then(setPush).catch(() => undefined); }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      if (on) {
        const r = await enablePush();
        if (r === 'denied') toast.error('Notifications are blocked in your browser settings.');
        else if (r === 'unsupported') toast.error('This browser does not support push notifications.');
        setPush(r === 'enabled');
      } else {
        await disablePush();
        setPush(false);
      }
    } catch {
      toast.error('Could not change notifications. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Profile" />
      <div className="grid max-w-xl gap-4">
        <Card>
          <CardHeader><CardTitle>{user?.fullName}</CardTitle><CardDescription>{user?.email}</CardDescription></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {user ? ROLE_LABELS[user.role] : ''}{user?.contractorName ? ` · ${user.contractorName}` : ''}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><BellRing className="size-5" aria-hidden /> Notifications on this device</CardTitle></CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <Label htmlFor="push" className="text-base">Push notifications</Label>
            <Switch id="push" checked={push} disabled={busy || !pushSupported()} onCheckedChange={(v) => void toggle(v)} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
