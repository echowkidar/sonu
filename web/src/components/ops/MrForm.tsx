import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PhotoPicker, type PickedPhoto } from '@/components/PhotoPicker';
import { CheckRow, FormError, NativeSelect } from '@/components/admin/kit';
import { api, apiPatch, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { DOC_KIND_LABELS, DOC_KINDS } from '@/lib/mr';
import type { MrDetail, MrDocKind, MrFile, WrDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

interface LineState {
  key: string;
  id?: string;
  description: string;
  quantity: string;
  uom: string;
  brand: string;
  storeSlNo: string;
  clientMatRef: string;
  kind: '' | 'material' | 'service';
  vendorOrigin: '' | 'local' | 'foreign';
  claimable: '' | 'yes' | 'no';
  targetDate: string;
  remarks: string;
  photos: PickedPhoto[];
  existingPhotos: MrFile[];
}

let seq = 0;
const newLine = (): LineState => ({
  key: `l${++seq}`, description: '', quantity: '1', uom: '', brand: '', storeSlNo: '', clientMatRef: '', kind: '', vendorOrigin: '', claimable: '', targetDate: '', remarks: '', photos: [], existingPhotos: [],
});

const lineFrom = (l: MrDetail['lines'][number]): LineState => ({
  key: `l${++seq}`, id: l.id, description: l.description, quantity: String(l.quantity), uom: l.uom ?? '', brand: l.brand ?? '', storeSlNo: l.storeSlNo ?? '', clientMatRef: l.clientMatRef ?? '',
  kind: l.kind, vendorOrigin: l.vendorOrigin ?? '', claimable: l.claimable === null ? '' : l.claimable ? 'yes' : 'no', targetDate: l.targetDate ?? '', remarks: l.remarks ?? '', photos: [], existingPhotos: l.photos,
});

const Field = ({ id, label, className, children }: { id: string; label: string; className?: string; children: React.ReactNode }) => (
  <div className={cn('grid gap-1.5', className)}><Label htmlFor={id}>{label}</Label>{children}</div>
);

function Choice<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-5">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="size-5 accent-[var(--primary)]" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The MR form (new, or edit while the request is still New). Photos picked per line are uploaded after the request is saved. */
export function MrFormView({ wr, initial }: { wr: WrDetail | null; initial?: MrDetail }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const c = wr?.computed;
  const known = (v: string | null | undefined) => (v && v !== 'Unmapped' ? v : '');
  const [wrCode, setWrCode] = React.useState(initial?.wrCode ?? wr?.wrCode ?? '');
  const [dateRequested, setDateRequested] = React.useState(initial?.dateRequested ?? wr?.today ?? '');
  const [projectName, setProjectName] = React.useState(initial?.projectName ?? '');
  const [contractNo, setContractNo] = React.useState(initial?.contractNo ?? '');
  const [discipline, setDiscipline] = React.useState(initial?.itemDiscipline ?? known(c?.discipline));
  const [facility, setFacility] = React.useState(initial?.facility ?? known(c?.facility));
  const [zone, setZone] = React.useState(initial?.zone ?? known(c?.zone));
  const [building, setBuilding] = React.useState(initial?.buildingName ?? wr?.buildingName ?? '');
  const [purchaseType, setPurchaseType] = React.useState<'materials' | 'services'>(initial?.purchaseType ?? 'materials');
  const [purpose, setPurpose] = React.useState<'stock' | 'new'>(initial?.purpose ?? 'new');
  const [extra, setExtra] = React.useState(initial?.additionalRequirements ?? '');
  const [docs, setDocs] = React.useState<MrDocKind[]>(initial?.docsRequired ?? []);
  const [lines, setLines] = React.useState<LineState[]>(() => (initial?.lines.length ? initial.lines.map(lineFrom) : [newLine()]));
  const [error, setError] = React.useState<string | null>(null);
  const wrLocked = Boolean(initial || wr);

  const patchLine = (key: string, p: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const removeLine = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  const toggleDoc = (k: MrDocKind, on: boolean) => setDocs((d) => (on ? [...new Set([...d, k])] : d.filter((x) => x !== k)));

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...(initial ? {} : wrCode.trim() ? { wrCode: wrCode.trim() } : {}),
        ...(dateRequested ? { dateRequested } : {}),
        projectName, contractNo, itemDiscipline: discipline, facility, zone, buildingName: building,
        purchaseType, purpose, additionalRequirements: extra, docsRequired: docs,
        lines: lines.map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          description: l.description.trim(), quantity: Number(l.quantity), uom: l.uom, brand: l.brand, storeSlNo: l.storeSlNo, clientMatRef: l.clientMatRef,
          kind: l.kind || (purchaseType === 'services' ? 'service' : 'material'),
          vendorOrigin: l.vendorOrigin || null, claimable: l.claimable === '' ? null : l.claimable === 'yes', targetDate: l.targetDate || null, remarks: l.remarks,
        })),
      };
      const saved = initial ? await apiPatch<MrDetail>(OPS.mr(initial.id), body) : await apiPost<MrDetail>(OPS.mrs, body);
      let failed = 0;
      for (const [i, l] of lines.entries()) {
        const lineId = saved.lines[i]?.id;
        if (!lineId) continue;
        for (const p of l.photos) {
          const f = new FormData();
          f.append('kind', 'line');
          f.append('lineId', lineId);
          f.append('file', p.file, p.file.name);
          try { await api(OPS.mrAttachments(saved.id), { method: 'POST', form: f }); } catch { failed++; }
        }
      }
      return { saved, failed };
    },
    onSuccess: ({ saved, failed }) => {
      for (const k of ['mr', 'mrs', 'procurement-summary', 'work-requests']) void qc.invalidateQueries({ queryKey: [k] });
      if (saved.wrCode) void qc.invalidateQueries({ queryKey: ['wr', saved.wrCode] });
      toast.success(initial ? 'Changes saved.' : `${saved.mrCode} submitted.`);
      if (failed) toast.error(`${failed} photo${failed === 1 ? '' : 's'} could not be uploaded. Add them on the request page.`);
      nav(`/procurement/mr/${saved.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit() {
    for (const [i, l] of lines.entries()) {
      if (!l.description.trim()) { setError(`Line ${i + 1}: describe the item.`); return; }
      const q = Number(l.quantity);
      if (!Number.isFinite(q) || q <= 0) { setError(`Line ${i + 1}: enter a quantity more than 0.`); return; }
    }
    setError(null);
    save.mutate();
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Material request form">
      <Card>
        <CardHeader><CardTitle>Materials / service request</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="mr-project" label="Project name"><Input id="mr-project" value={projectName} maxLength={200} onChange={(e) => setProjectName(e.target.value)} className="text-base" /></Field>
            <Field id="mr-contract" label="Project contract no."><Input id="mr-contract" value={contractNo} maxLength={100} onChange={(e) => setContractNo(e.target.value)} className="text-base" /></Field>
            <Field id="mr-discipline" label="Item discipline"><Input id="mr-discipline" value={discipline} maxLength={100} onChange={(e) => setDiscipline(e.target.value)} className="text-base" /></Field>
            <Field id="mr-date" label="Date requested"><Input id="mr-date" type="date" value={dateRequested} onChange={(e) => setDateRequested(e.target.value)} className="text-base" /></Field>
            <Field id="mr-wr" label="Work request (WR number)">
              <Input id="mr-wr" value={wrCode} readOnly={wrLocked} maxLength={40} onChange={(e) => setWrCode(e.target.value)} className="font-mono text-base" />
            </Field>
            <Field id="mr-facility" label="Facility"><Input id="mr-facility" value={facility} maxLength={200} onChange={(e) => setFacility(e.target.value)} className="text-base" /></Field>
            <Field id="mr-zone" label="Zone"><Input id="mr-zone" value={zone} maxLength={200} onChange={(e) => setZone(e.target.value)} className="text-base" /></Field>
            <Field id="mr-building" label="Building"><Input id="mr-building" value={building} maxLength={200} onChange={(e) => setBuilding(e.target.value)} className="text-base" /></Field>
          </div>
          <p className="text-sm text-muted-foreground">MR reference no.: <strong className="text-foreground">{initial ? initial.mrCode : 'given when you submit'}</strong></p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice name="purchaseType" legend="Purchase of" value={purchaseType} onChange={setPurchaseType} options={[{ value: 'materials', label: 'Materials' }, { value: 'services', label: 'Services' }]} />
            <Choice name="purpose" legend="Purpose of purchase" value={purpose} onChange={setPurpose} options={[{ value: 'stock', label: 'Stock' }, { value: 'new', label: 'New' }]} />
          </div>
          <Field id="mr-extra" label="Any additional requirements">
            <Textarea id="mr-extra" rows={2} maxLength={2000} value={extra} onChange={(e) => setExtra(e.target.value)} className="text-base" />
          </Field>
          <fieldset className="grid gap-0.5">
            <legend className="text-sm font-medium">Required documents attached</legend>
            <div className="flex flex-wrap gap-x-5">
              {DOC_KINDS.map((k) => <CheckRow key={k} id={`mr-doc-${k}`} label={DOC_KIND_LABELS[k]} checked={docs.includes(k)} onChange={(v) => toggleDoc(k, v)} />)}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <section aria-label="Items" className="grid gap-3">
        <h2 className="text-lg font-semibold">Items</h2>
        <ul className="grid gap-3">
          {lines.map((l, i) => (
            <li key={l.key}>
              <Card>
                <CardContent className="grid gap-3 p-4" data-testid="mr-line">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold">Line {i + 1}</h3>
                    <Button type="button" size="sm" variant="ghost" disabled={lines.length === 1} aria-label={`Remove line ${i + 1}`} onClick={() => removeLine(l.key)}><Trash2 className="size-4" aria-hidden /> Remove</Button>
                  </div>
                  <Field id={`${l.key}-desc`} label={`Material / service description (line ${i + 1})`}>
                    <Textarea id={`${l.key}-desc`} rows={2} maxLength={500} value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} className="text-base" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field id={`${l.key}-qty`} label="Qty"><Input id={`${l.key}-qty`} type="number" inputMode="decimal" min="0" step="any" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-uom`} label="UoM"><Input id={`${l.key}-uom`} value={l.uom} maxLength={30} onChange={(e) => patchLine(l.key, { uom: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-brand`} label="Brand / make"><Input id={`${l.key}-brand`} value={l.brand} maxLength={100} onChange={(e) => patchLine(l.key, { brand: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-kind`} label="Material / service">
                      <NativeSelect id={`${l.key}-kind`} value={l.kind || (purchaseType === 'services' ? 'service' : 'material')} onChange={(e) => patchLine(l.key, { kind: e.target.value as LineState['kind'] })}>
                        <option value="material">Material</option><option value="service">Service</option>
                      </NativeSelect>
                    </Field>
                    <Field id={`${l.key}-store`} label="Store Sl. no."><Input id={`${l.key}-store`} value={l.storeSlNo} maxLength={100} onChange={(e) => patchLine(l.key, { storeSlNo: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-cref`} label="Client mat's ref."><Input id={`${l.key}-cref`} value={l.clientMatRef} maxLength={100} onChange={(e) => patchLine(l.key, { clientMatRef: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-vendor`} label="Suggested vendor">
                      <NativeSelect id={`${l.key}-vendor`} value={l.vendorOrigin} onChange={(e) => patchLine(l.key, { vendorOrigin: e.target.value as LineState['vendorOrigin'] })}>
                        <option value="">Not set</option><option value="local">Local</option><option value="foreign">Foreign</option>
                      </NativeSelect>
                    </Field>
                    <Field id={`${l.key}-claim`} label="Claimable">
                      <NativeSelect id={`${l.key}-claim`} value={l.claimable} onChange={(e) => patchLine(l.key, { claimable: e.target.value as LineState['claimable'] })}>
                        <option value="">Not set</option><option value="yes">Yes</option><option value="no">No</option>
                      </NativeSelect>
                    </Field>
                    <Field id={`${l.key}-target`} label="Target date"><Input id={`${l.key}-target`} type="date" value={l.targetDate} onChange={(e) => patchLine(l.key, { targetDate: e.target.value })} className="text-base" /></Field>
                    <Field id={`${l.key}-remarks`} label="Remarks" className="col-span-2 md:col-span-3"><Input id={`${l.key}-remarks`} value={l.remarks} maxLength={1000} onChange={(e) => patchLine(l.key, { remarks: e.target.value })} className="text-base" /></Field>
                  </div>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">Photos</span>
                    {l.existingPhotos.length > 0 && (
                      <ul className="flex flex-wrap gap-2" aria-label="Saved photos">
                        {l.existingPhotos.map((p) => <li key={p.id}><img src={OPS.attachment(p.id)} alt={p.fileName} loading="lazy" className="size-16 rounded-lg border object-cover" /></li>)}
                      </ul>
                    )}
                    <PhotoPicker value={l.photos} onChange={(photos) => patchLine(l.key, { photos })} max={Math.max(0, 6 - l.existingPhotos.length)} label="Take photo" />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
        {lines.length < 50 && (
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus className="size-4" aria-hidden /> Add line</Button>
        )}
      </section>

      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={save.isPending}>{initial ? 'Save changes' : 'Submit request'}</Button>
        <Button type="button" size="lg" variant="outline" onClick={() => nav(-1)}>Cancel</Button>
      </div>
    </form>
  );
}
