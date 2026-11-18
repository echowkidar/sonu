import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { FormError } from '@/components/admin/kit';
import { apiPatch, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { lineTotal, qar } from '@/lib/pettyCash';
import type { PettyCashDetail, PettyCashLine, PettyCashLineInput } from '@/lib/types';

interface FormState {
  wrCode: string; grnCode: string; glCode: string; wbs: string; workDescription: string; location: string; rfe: string; claimable: boolean;
  supplier: string; materialUsed: string; billDate: string; billNo: string; qty: string; unit: string; unitCost: string; discount: string;
}

const blank = (): FormState => ({
  wrCode: '', grnCode: '', glCode: '', wbs: '', workDescription: '', location: '', rfe: '', claimable: true, supplier: '', materialUsed: '', billDate: '', billNo: '',
  qty: '1', unit: '', unitCost: '', discount: '',
});
const from = (l: PettyCashLine): FormState => ({
  wrCode: l.wrCode ?? '', grnCode: l.grnCode ?? '', glCode: l.glCode ?? '', wbs: l.wbs ?? '', workDescription: l.workDescription ?? '', location: l.location ?? '',
  rfe: String(l.rfeApprovedAmount), claimable: l.claimable, supplier: l.supplier ?? '', materialUsed: l.materialUsed ?? '', billDate: l.billDate ?? '', billNo: l.billNo ?? '',
  qty: String(l.qty), unit: l.unit ?? '', unitCost: String(l.unitCost), discount: String(l.discount),
});

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

/** Validates the form and builds the request body; returns the first problem otherwise. */
export function buildLineBody(f: FormState): { body: PettyCashLineInput } | { error: string } {
  const qty = num(f.qty);
  const unitCost = f.unitCost.trim() === '' ? 0 : num(f.unitCost);
  const discount = f.discount.trim() === '' ? 0 : num(f.discount);
  if (!Number.isFinite(qty) || qty <= 0) return { error: 'The quantity must be more than 0.' };
  if (!Number.isFinite(unitCost) || unitCost < 0) return { error: 'Enter the unit cost (0 or more).' };
  if (!Number.isFinite(discount) || discount < 0) return { error: 'The discount cannot be negative.' };
  if (lineTotal(qty, unitCost, discount) < 0) return { error: 'The discount cannot be more than quantity times unit cost.' };
  const rfe = f.rfe.trim() === '' ? undefined : num(f.rfe);
  if (rfe !== undefined && (!Number.isFinite(rfe) || rfe < 0)) return { error: 'The RFE approved amount cannot be negative.' };
  const t = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    body: {
      wrCode: t(f.wrCode), grnCode: t(f.grnCode), glCode: t(f.glCode), wbs: t(f.wbs), workDescription: t(f.workDescription), location: t(f.location),
      ...(rfe !== undefined ? { rfeApprovedAmount: rfe } : {}), claimable: f.claimable, supplier: t(f.supplier), materialUsed: t(f.materialUsed), billDate: t(f.billDate),
      billNo: t(f.billNo), qty, unit: t(f.unit), unitCost, discount,
    },
  };
}

/** Add or edit one claim line. The total shown is qty x unit cost - discount; the server computes the same. */
export function PettyCashLineDialog({
  claimId, line, open, onOpenChange, onSaved,
}: { claimId: string; line?: PettyCashLine; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (d: PettyCashDetail) => void }) {
  const [f, setF] = React.useState<FormState>(() => (line ? from(line) : blank()));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setF(line ? from(line) : blank()); setError(null); } }, [open, line]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const total = lineTotal(Number.isFinite(num(f.qty)) ? num(f.qty) : 0, Number.isFinite(num(f.unitCost)) ? num(f.unitCost) : 0, Number.isFinite(num(f.discount)) ? num(f.discount) : 0);

  const save = useMutation({
    mutationFn: (body: PettyCashLineInput) => (line ? apiPatch<PettyCashDetail>(OPS.pettyCashLine(claimId, line.id), body) : apiPost<PettyCashDetail>(OPS.pettyCashLines(claimId), body)),
    onSuccess: (d) => { toast.success(line ? 'Line saved.' : 'Line added.'); onSaved(d); onOpenChange(false); },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit() {
    const r = buildLineBody(f);
    if ('error' in r) { setError(r.error); return; }
    setError(null);
    save.mutate(r.body);
  }

  const field = (id: string, label: string, el: React.ReactNode, wide = false) => (
    <div className={wide ? 'grid gap-1.5 sm:col-span-2' : 'grid gap-1.5'}><Label htmlFor={`pcl-${id}`}>{label}</Label>{el}</div>
  );
  const text = (id: keyof FormState, label: string, max = 200, wide = false) =>
    field(id, label, <Input id={`pcl-${id}`} value={f[id] as string} maxLength={max} onChange={(e) => set(id, e.target.value as never)} className="text-base" />, wide);
  const numeric = (id: keyof FormState, label: string, step = '0.01') =>
    field(id, label, <Input id={`pcl-${id}`} type="number" inputMode="decimal" min="0" step={step} value={f[id] as string} onChange={(e) => set(id, e.target.value as never)} className="text-base" />);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{line ? `Edit line ${line.lineNo}` : 'Add a line'}</DialogTitle>
          <DialogDescription>Fill in what is on the bill. A work request number fills the status, description and location when they are empty.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Claim line">
          <div className="grid gap-3 sm:grid-cols-2">
            {text('wrCode', 'Work order no (WR number)', 40)}
            {text('grnCode', 'GRN code', 100)}
            {text('glCode', 'GL code', 100)}
            {text('wbs', 'WBS', 100)}
            {text('workDescription', 'Work description', 500, true)}
            {text('location', 'Location')}
            {numeric('rfe', 'RFE approved (QR, 0 when none)')}
            {text('supplier', 'Supplier')}
            {text('materialUsed', 'Material used', 300)}
            {field('billDate', 'Bill date', <Input id="pcl-billDate" type="date" value={f.billDate} onChange={(e) => set('billDate', e.target.value)} className="text-base" />)}
            {text('billNo', 'Bill #', 100)}
            {numeric('qty', 'Qty', '0.001')}
            {text('unit', 'Unit', 30)}
            {numeric('unitCost', 'Unit cost (QR)')}
            {numeric('discount', 'Discount (QR)')}
            <div className="flex min-h-11 items-center gap-2 sm:col-span-2">
              <Switch id="pcl-claimable" checked={f.claimable} onCheckedChange={(v) => set('claimable', v)} />
              <Label htmlFor="pcl-claimable">{f.claimable ? 'Claimable' : 'Non-claimable'}</Label>
            </div>
          </div>
          <p className="text-sm font-semibold tabular-nums" data-testid="line-total">Total {qar(total)}</p>
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>{line ? 'Save line' : 'Add line'}</Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
