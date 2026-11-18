import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt, Trash2, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PhotoPicker, type PickedPhoto } from '@/components/PhotoPicker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { FormError } from '@/components/admin/kit';
import { api, apiDelete, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { canConvertZeroRfe, COORD_ROLES, PURCHASE_ROLES } from '@/lib/ops';
import { canViewClaims, PC_STATUS } from '@/lib/pettyCash';
import type { WrDetail } from '@/lib/types';

export const ZERO_RFE_LIMIT = 100;
const qr = (n: number) => `QR ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function useRefreshWr(code: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of ['work-requests', 'my-work', 'dashboard', 'zero-rfe']) void qc.invalidateQueries({ queryKey: [k] });
    void qc.invalidateQueries({ queryKey: ['wr', code] });
  };
}

/** Whether the WR can still be converted: open in Marafiq and no approved RFE. */
export function canStillConvert(wr: WrDetail): boolean {
  if (wr.goneAt) return false;
  if (/complet|closed|cancel/i.test(wr.wrStatus ?? '')) return false;
  return !wr.rfe?.approvedOn;
}

/** In the SONU panel: the "Convert to 0 RFE" button (with its dialog), or the badge once converted (with Undo for coordinators). */
export function ZeroRfeBlock({ wr, role, userId }: { wr: WrDetail; role: string; userId: string }) {
  const refresh = useRefreshWr(wr.wrCode);
  const [open, setOpen] = React.useState(false);
  const [undoOpen, setUndoOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const z = wr.internal.zeroRfe;
  const isCoord = (COORD_ROLES as readonly string[]).includes(role);

  const convert = useMutation({
    mutationFn: (b: { amount: number; note?: string }) => apiPost(OPS.zeroRfe(wr.wrCode), b),
    onSuccess: () => { toast.success('Converted to 0 RFE.'); setOpen(false); setAmount(''); setNote(''); refresh(); },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit() {
    const n = Number(amount);
    if (!amount.trim() || !Number.isFinite(n) || n <= 0) { setError('Enter the expected amount in QR.'); return; }
    if (n >= ZERO_RFE_LIMIT) { setError(`0 RFE is only for material under QR ${ZERO_RFE_LIMIT}.`); return; }
    setError(null);
    convert.mutate({ amount: n, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  if (z) {
    return (
      <div className="grid gap-2 rounded-lg border border-success/40 bg-success-soft p-3 text-sm" data-testid="zero-rfe-badge">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="success"><Receipt className="size-3.5" aria-hidden /> 0 RFE — local purchase</Badge>
        </p>
        <p className="text-muted-foreground">
          {z.byName ? `${z.byName}, ` : ''}{formatDateTime(z.at)}{z.amount != null ? ` · expected ${qr(z.amount)}` : ''}
        </p>
        {z.note && <p>{z.note}</p>}
        {isCoord && (
          <>
            <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setUndoOpen(true)}><Undo2 className="size-4" aria-hidden /> Undo</Button>
            <ConfirmDialog
              open={undoOpen} onOpenChange={setUndoOpen} title="Undo 0 RFE?" destructive confirmLabel="Undo 0 RFE"
              description="The criterion and contractor status go back to what they were. This is refused while local purchases exist."
              onConfirm={async () => {
                try { await apiDelete(OPS.zeroRfe(wr.wrCode)); toast.success('0 RFE undone.'); refresh(); } catch (e) { toast.error(errorMessage(e)); }
              }}
            />
          </>
        )}
      </div>
    );
  }

  if (!canConvertZeroRfe(role, wr.internal.ownerId, userId) || !canStillConvert(wr)) return null;
  return (
    <div className="grid gap-1.5">
      <Button variant="outline" className="justify-self-start" onClick={() => { setError(null); setOpen(true); }}><Receipt className="size-4" aria-hidden /> Convert to 0 RFE</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert to 0 RFE</DialogTitle>
            <DialogDescription>
              Material under QR 100 is bought locally with petty cash. No RFE goes to QF and the job moves to In Progress. Remember to issue it in Marafiq without cost.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="zr-amount">Expected amount (QR)</Label>
              <Input id="zr-amount" type="number" inputMode="decimal" min="0.01" max="99.99" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="zr-note">Note (optional)</Label>
              <Textarea id="zr-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <FormError message={error} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={convert.isPending}>Convert to 0 RFE</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Detail page section: the petty-cash purchases of a converted WR, with receipts and an add form. */
export function LocalPurchasesCard({ wr, role, userId }: { wr: WrDetail; role: string; userId: string }) {
  const refresh = useRefreshWr(wr.wrCode);
  const [adding, setAdding] = React.useState(false);
  const [item, setItem] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(wr.today);
  const [ref, setRef] = React.useState('');
  const [photos, setPhotos] = React.useState<PickedPhoto[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [delId, setDelId] = React.useState<string | null>(null);
  const list = wr.localPurchases ?? [];
  const showClaims = canViewClaims(role) && list.some((p) => p.claim !== undefined);
  const canAdd = (PURCHASE_ROLES as readonly string[]).includes(role);
  const isCoord = (COORD_ROLES as readonly string[]).includes(role);
  const spent = list.every((p) => p.amount != null) ? list.reduce((t, p) => t + (p.amount ?? 0), 0) : null;

  const add = useMutation({
    mutationFn: () => {
      const f = new FormData();
      f.append('item', item.trim());
      f.append('amount', amount);
      f.append('purchasedOn', date);
      if (ref.trim()) f.append('pettyCashRef', ref.trim());
      for (const p of photos) f.append('photo', p.file, p.file.name);
      return api(OPS.purchases(wr.wrCode), { method: 'POST', form: f });
    },
    onSuccess: () => {
      toast.success('Purchase saved.');
      setItem(''); setAmount(''); setRef(''); setPhotos([]); setAdding(false); setError(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit() {
    const n = Number(amount);
    if (!item.trim()) { setError('Say what was bought.'); return; }
    if (!Number.isFinite(n) || n <= 0) { setError('Enter the amount paid in QR.'); return; }
    if (!date) { setError('Pick the date of the purchase.'); return; }
    setError(null);
    add.mutate();
  }

  if (!wr.internal.zeroRfe) return null;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Local purchases</CardTitle>
        {spent != null && <span className="text-sm text-muted-foreground" data-testid="purchases-total">Spent {qr(spent)}{wr.internal.zeroRfe.amount != null ? ` of ${qr(wr.internal.zeroRfe.amount)} expected` : ''}</span>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No purchases yet. Keep the petty-cash receipt and add its photo here.</p>
        ) : (
          <ul className="grid gap-3">
            {list.map((p) => (
              <li key={p.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{p.item}</p>
                    <p className="text-xs text-muted-foreground">
                      {[p.amount != null ? qr(p.amount) : null, p.purchasedOn, p.pettyCashRef ? `Petty cash ${p.pettyCashRef}` : null, p.createdByName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {(isCoord || p.createdById === userId) && (
                    <Button size="sm" variant="ghost" aria-label={`Delete purchase ${p.item}`} onClick={() => setDelId(p.id)}><Trash2 className="size-4" aria-hidden /></Button>
                  )}
                </div>
                {showClaims && (
                  <p className="text-xs" data-testid={`purchase-claim-${p.id}`}>
                    {p.claim
                      ? <>On petty cash claim <Link to={`/petty-cash/${p.claim.id}`} className="font-mono underline">{p.claim.code}</Link> ({PC_STATUS[p.claim.status].label})</>
                      : <span className="text-muted-foreground">Not claimed yet</span>}
                  </p>
                )}
                {p.attachments.length === 0 ? (
                  <p className="text-xs font-semibold text-warning">No receipt photo yet</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {p.attachments.map((a) => (
                      <li key={a.id}>
                        <a href={OPS.attachment(a.id)} target="_blank" rel="noopener noreferrer" className="block size-20 overflow-hidden rounded-lg border bg-muted" aria-label={`Receipt ${a.fileName}`}>
                          <img src={OPS.attachment(a.id)} alt={`Receipt for ${p.item}`} loading="lazy" className="size-full object-cover" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {canAdd && !adding && <Button className="justify-self-start" onClick={() => { setError(null); setAdding(true); }}><Plus className="size-4" aria-hidden /> Add purchase</Button>}
        {canAdd && adding && (
          <form className="grid gap-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Add purchase">
            <div className="grid gap-1.5">
              <Label htmlFor="lp-item">What was bought</Label>
              <Input id="lp-item" value={item} maxLength={200} onChange={(e) => setItem(e.target.value)} className="text-base" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lp-amount">Amount (QR)</Label>
                <Input id="lp-amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-base" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lp-date">Date</Label>
                <Input id="lp-date" type="date" max={wr.today} value={date} onChange={(e) => setDate(e.target.value)} className="text-base" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lp-ref">Petty cash reference (optional)</Label>
              <Input id="lp-ref" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} className="text-base" />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Receipt photos</span>
              <PhotoPicker value={photos} onChange={setPhotos} max={3} label="Photograph receipt" />
            </div>
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={add.isPending}>Save purchase</Button>
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        )}
        <ConfirmDialog
          open={delId !== null} onOpenChange={(o) => { if (!o) setDelId(null); }} title="Delete this purchase?" destructive confirmLabel="Delete"
          description="The purchase and its receipt photos are removed."
          onConfirm={async () => {
            try { await apiDelete(OPS.purchase(wr.wrCode, delId!)); toast.success('Purchase deleted.'); setDelId(null); refresh(); } catch (e) { toast.error(errorMessage(e)); }
          }}
        />
      </CardContent>
    </Card>
  );
}
