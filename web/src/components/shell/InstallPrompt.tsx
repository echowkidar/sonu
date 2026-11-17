import * as React from 'react';
import { Download, Share, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useInstallPrompt } from '@/lib/push';

const KEY = 'sonu.installDismissed';

/** Small dismissible banner: native install prompt where available, "Add to Home Screen" hint on iOS. */
export function InstallPrompt() {
  const { canPrompt, showIosHint, install } = useInstallPrompt();
  const [dismissed, setDismissed] = React.useState(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  if (dismissed || (!canPrompt && !showIosHint)) return null;
  const close = () => { setDismissed(true); try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
  return (
    <div className="flex items-center gap-3 border-b bg-primary-soft px-4 py-2 text-sm">
      {canPrompt ? <Download className="size-5 shrink-0 text-primary" aria-hidden /> : <Share className="size-5 shrink-0 text-primary" aria-hidden />}
      <p className="min-w-0 flex-1">
        {canPrompt ? 'Install SONU on this device for faster access.' : 'To install: tap Share, then "Add to Home Screen".'}
      </p>
      {canPrompt && <Button size="sm" onClick={() => void install()}>Install</Button>}
      <button type="button" aria-label="Dismiss" onClick={close} className="tap inline-flex items-center justify-center"><X className="size-4" /></button>
    </div>
  );
}
