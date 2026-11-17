import * as React from 'react';
import { Loader2, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { useIsDesktop } from '@/lib/hooks';
import { errorMessage } from '@/lib/forms';

export const waFallbackUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

interface WaLink { url: string; qrSvg?: string }

/**
 * "Share on WhatsApp". Phone: opens the link. Desktop: dialog with the QR code and an "Open WhatsApp Web" link.
 * Uses GET /api/whatsapp/link; when the route is missing (404) or refuses an empty recipient (400) the wa.me link is built here.
 */
export function ShareWhatsApp({ text, to = '', size = 'default', variant = 'outline' }: { text: string; to?: string; size?: 'default' | 'sm' | 'lg'; variant?: 'outline' | 'secondary' | 'default' }) {
  const desktop = useIsDesktop();
  const [busy, setBusy] = React.useState(false);
  const [link, setLink] = React.useState<WaLink | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function share() {
    setBusy(true);
    setError(null);
    let result: WaLink;
    try {
      result = await apiGet<WaLink>(OPS.whatsappLink, { query: { to, text } });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) result = { url: waFallbackUrl(text) };
      else { setError(errorMessage(e)); setBusy(false); return; }
    }
    setBusy(false);
    if (desktop) setLink(result);
    else window.open(result.url, '_blank', 'noopener');
  }

  return (
    <div className="grid gap-1">
      <Button type="button" variant={variant} size={size} onClick={() => void share()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageCircle className="size-4" aria-hidden />}
        Share on WhatsApp
      </Button>
      {!to && <span className="text-xs text-muted-foreground">WhatsApp will ask who to send to. Pick a contact or group, then tap Send.</span>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Dialog open={!!link} onOpenChange={(o) => { if (!o) setLink(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share on WhatsApp</DialogTitle>
            <DialogDescription>Scan the code with your phone, or open WhatsApp Web on this computer.</DialogDescription>
          </DialogHeader>
          {link?.qrSvg && (
            <img alt="WhatsApp QR code" className="mx-auto size-56 rounded-lg border bg-white p-2" src={`data:image/svg+xml;utf8,${encodeURIComponent(link.qrSvg)}`} />
          )}
          <Button asChild>
            <a href={link?.url} target="_blank" rel="noopener noreferrer">Open WhatsApp Web</a>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
