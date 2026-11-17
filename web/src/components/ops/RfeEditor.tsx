import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/admin/kit';
import { ApiError, apiBlob, saveBlob } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import type { RfeLineInput } from '@/lib/types';

const blank = (): RfeLineInput => ({ lineType: 'Item', vendorItemName: '', uom: '', lineNumber: '', poNumber: '', bpaItem: '', accountCode: '', estQty: 0, unitPrice: 0, markUp: 0 });

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
/** Same rule as the server: quantity x unit price; a Discount line is negative. */
export function lineAmount(l: Pick<RfeLineInput, 'lineType' | 'estQty' | 'unitPrice'>): number {
  const gross = round4((l.estQty || 0) * (l.unitPrice || 0));
  return l.lineType === 'Discount' ? -Math.abs(gross) : gross;
}

interface Problem { line?: number; field: string; message: string }

const FIELD_LABELS: Record<string, string> = {
  lineType: 'Line type', vendorItemName: 'Item name', uom: 'UOM', lineNumber: 'BPA line number', poNumber: 'PO number', bpaItem: 'BPA line', accountCode: 'Account code',
  estQty: 'Quantity', unitPrice: 'Rate', markUp: 'Mark up', lines: 'Lines', wrCode: 'WR number',
};

/** Small editor for the 13 columns of the Marafiq RFE template. Amount is computed. */
export function RfeEditor({ code }: { code: string }) {
  const [lines, setLines] = React.useState<RfeLineInput[]>([blank()]);
  const [problems, setProblems] = React.useState<Problem[]>([]);
  const set = (i: number, patch: Partial<RfeLineInput>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const total = lines.reduce((s, l) => s + lineAmount(l), 0);

  const m = useMutation({
    mutationFn: () => apiBlob(OPS.rfeFile(code), { method: 'POST', body: { lines } }),
    onSuccess: ({ blob, fileName }) => { setProblems([]); saveBlob(blob, fileName ?? `rfe-${code}.xlsx`); toast.success(`rfe-${code}.xlsx is ready.`); },
    onError: (e) => {
      const d = e instanceof ApiError && e.code === 'rfe_invalid' ? (e.details as { problems?: Problem[] } | undefined)?.problems : undefined;
      if (d?.length) setProblems(d);
      else { setProblems([]); toast.error(errorMessage(e)); }
    },
  });

  return (
    <Card id="rfe">
      <CardHeader><CardTitle>RFE file</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">Fill the lines, then download the Marafiq import file. Upload it in Marafiq yourself.</p>
        {lines.map((l, i) => (
          <fieldset key={i} className="grid gap-3 rounded-xl border p-3">
            <legend className="px-1 text-sm font-semibold">Line {i + 1} <span className="font-normal text-muted-foreground">· WR {code}</span></legend>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="grid gap-1"><Label htmlFor={`l${i}-type`}>Line type</Label>
                <NativeSelect id={`l${i}-type`} value={l.lineType} onChange={(e) => set(i, { lineType: e.target.value as RfeLineInput['lineType'] })}>
                  <option>Item</option><option>Discount</option><option>Margin</option>
                </NativeSelect></div>
              <div className="col-span-2 grid gap-1"><Label htmlFor={`l${i}-name`}>Vendor item name</Label><Input id={`l${i}-name`} value={l.vendorItemName} onChange={(e) => set(i, { vendorItemName: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-uom`}>UOM</Label><Input id={`l${i}-uom`} value={l.uom} onChange={(e) => set(i, { uom: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-ln`}>BPA line number</Label><Input id={`l${i}-ln`} value={l.lineNumber} onChange={(e) => set(i, { lineNumber: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-po`}>PO number</Label><Input id={`l${i}-po`} value={l.poNumber} onChange={(e) => set(i, { poNumber: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-bpa`}>BPA item</Label><Input id={`l${i}-bpa`} value={l.bpaItem} onChange={(e) => set(i, { bpaItem: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-acc`}>Account code</Label><Input id={`l${i}-acc`} value={l.accountCode} onChange={(e) => set(i, { accountCode: e.target.value })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-qty`}>Est. quantity</Label><Input id={`l${i}-qty`} type="number" inputMode="decimal" min="0" step="any" value={l.estQty || ''} onChange={(e) => set(i, { estQty: num(e.target.value) })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-price`}>Unit price</Label><Input id={`l${i}-price`} type="number" inputMode="decimal" min="0" step="any" value={l.unitPrice || ''} onChange={(e) => set(i, { unitPrice: num(e.target.value) })} /></div>
              <div className="grid gap-1"><Label htmlFor={`l${i}-mu`}>Mark up</Label><Input id={`l${i}-mu`} type="number" inputMode="decimal" min="0" step="any" value={l.markUp || ''} onChange={(e) => set(i, { markUp: num(e.target.value) })} /></div>
              <div className="grid gap-1"><span className="text-sm font-medium">Amount (computed)</span><output data-testid={`amount-${i}`} className="flex min-h-11 items-center rounded-lg border bg-muted px-3 tabular-nums">{lineAmount(l).toLocaleString(undefined, { maximumFractionDigits: 4 })}</output></div>
            </div>
            {lines.length > 1 && <Button type="button" size="sm" variant="ghost" className="justify-self-end" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /> Remove line {i + 1}</Button>}
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="size-4" aria-hidden /> Add line</Button>
          <p className="text-sm">Total: <strong className="tabular-nums" data-testid="rfe-total">{total.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong></p>
        </div>
        {problems.length > 0 && (
          <div role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
            <p className="font-semibold">The file was not made. Fix these first:</p>
            <ul className="mt-1 list-disc ps-5">
              {problems.map((p, i) => <li key={i}>{p.line ? `Line ${p.line} · ` : ''}{FIELD_LABELS[p.field] ?? p.field}: {p.message}</li>)}
            </ul>
          </div>
        )}
        <Button onClick={() => m.mutate()} disabled={m.isPending} className="justify-self-start">
          {m.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />} Make RFE file
        </Button>
      </CardContent>
    </Card>
  );
}
