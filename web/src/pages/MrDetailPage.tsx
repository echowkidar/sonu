import * as React from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, FileText, Pencil, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { Timeline } from '@/components/Timeline';
import { ErrorState, FormError, NativeSelect } from '@/components/admin/kit';
import { MrStatusBadge } from '@/components/ops/MrStatusBadge';
import { MrLpoCard } from '@/components/ops/LpoCard';
import { api, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { compressImage } from '@/lib/image';
import { COORD_LEVEL, DOC_KIND_LABELS, DOC_KINDS, MR_FLOW, MR_STATUS, qr } from '@/lib/mr';
import { fmtDate, useMeta } from '@/lib/ops';
import { useSession } from '@/lib/session';
import type { MrDetail, MrDocKind, MrFile, MrLine, MrStatus, Person } from '@/lib/types';
import { cn } from '@/lib/utils';

const PROC_PEOPLE_ROLES = ['purchasing', 'coordinator', 'manager', 'contractor_admin'];

function useRefreshMr(id: string) {
  const qc = useQueryClient();
  return (data?: MrDetail) => {
    if (data) qc.setQueryData(['mr', id], data);
    else void qc.invalidateQueries({ queryKey: ['mr', id] });
    for (const k of ['mrs', 'procurement-summary', 'work-requests', 'wr']) void qc.invalidateQueries({ queryKey: [k] });
  };
}

const Tick = ({ on, label }: { on: boolean; label: string }) => (
  <span className="inline-flex items-center gap-1" aria-label={`${label}: ${on ? 'yes' : 'no'}`}><span aria-hidden>{on ? '☒' : '☐'}</span> {label}</span>
);

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 border-b border-r p-2', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

/** Where the request is on its way: done / current / not yet, plus the way it stopped when rejected or cancelled. */
export function MrStepper({ mr }: { mr: MrDetail }) {
  const reached = new Set(mr.history.map((h) => h.toStatus));
  const stopped = mr.status === 'rejected' || mr.status === 'cancelled';
  return (
    <div className="grid gap-2">
      <ol className="grid gap-1 md:grid-cols-7" aria-label="Progress">
        {MR_FLOW.map((s, i) => {
          const current = s === mr.status;
          const done = reached.has(s) && !current;
          return (
            <li key={s} aria-current={current ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-lg border p-2 text-xs md:flex-col md:text-center', current && 'border-primary bg-primary-soft font-semibold', done && 'text-muted-foreground')}>
              <span className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px]', current && 'border-primary bg-primary text-primary-foreground', done && 'border-success bg-success-soft text-success')}>{done ? '✓' : i + 1}</span>
              <span>{MR_STATUS[s].label}</span>
            </li>
          );
        })}
      </ol>
      {stopped && <p className="text-sm"><MrStatusBadge status={mr.status} /> <span className="text-muted-foreground">This request stopped here.</span></p>}
    </div>
  );
}

function Thumb({ file, alt }: { file: MrFile; alt: string }) {
  return (
    <a href={OPS.attachment(file.id)} target="_blank" rel="noopener noreferrer" className="block size-16 overflow-hidden rounded-lg border bg-muted" aria-label={`Open ${file.fileName}`}>
      {file.mime.startsWith('image/')
        ? <img src={OPS.attachment(file.id)} alt={alt} loading="lazy" className="size-full object-cover" />
        : <span className="flex size-full items-center justify-center"><FileText className="size-6 text-muted-foreground" aria-hidden /></span>}
    </a>
  );
}

function LinePhotos({ mr, line, canAdd, userId, isCoord, onChange }: { mr: MrDetail; line: MrLine; canAdd: boolean; userId: string; isCoord: boolean; onChange: () => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const f = new FormData();
      f.append('kind', 'line');
      f.append('lineId', line.id);
      for (const file of Array.from(files)) { const c = await compressImage(file); f.append('file', c, c.name); }
      await api(OPS.mrAttachments(mr.id), { method: 'POST', form: f });
      onChange();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await apiDelete(OPS.mrAttachment(mr.id, id)); onChange(); } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {line.photos.map((p) => (
        <span key={p.id} className="relative">
          <Thumb file={p} alt={`Photo of ${line.description}`} />
          {canAdd && (isCoord || p.uploadedBy === userId) && (
            <button type="button" onClick={() => void remove(p.id)} aria-label={`Remove photo ${p.fileName}`} className="absolute -end-1 -top-1 inline-flex size-6 items-center justify-center rounded-full bg-black/70 text-white"><Trash2 className="size-3.5" aria-hidden /></button>
          )}
        </span>
      ))}
      {canAdd && line.photos.length < 6 && (
        <>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()} aria-label={`Add photo to line ${line.lineNo}`}><Camera className="size-4" aria-hidden /> Add photo</Button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </>
      )}
    </div>
  );
}

function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
      {items.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-medium">{v || '—'}</dd></div>)}
    </dl>
  );
}

function ProcurementPanel({ mr, people, onSaved }: { mr: MrDetail; people: Person[]; onSaved: (d: MrDetail) => void }) {
  const [assigned, setAssigned] = React.useState(mr.assignedTo ?? '');
  const [vendor, setVendor] = React.useState(mr.vendorName ?? '');
  const [contact, setContact] = React.useState(mr.vendorContact ?? '');
  const [quote, setQuote] = React.useState(mr.quotationRef ?? '');
  const [amount, setAmount] = React.useState(mr.quotedAmount === null ? '' : String(mr.quotedAmount));
  const [delivery, setDelivery] = React.useState(mr.expectedDelivery ?? '');
  const [remarks, setRemarks] = React.useState(mr.procurementRemarks ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const procPeople = people.filter((p) => PROC_PEOPLE_ROLES.includes(p.role));
  const save = useMutation({
    mutationFn: () => apiPatch<MrDetail>(OPS.mrProcurement(mr.id), {
      assignedTo: assigned || null, vendorName: vendor, vendorContact: contact, quotationRef: quote,
      quotedAmount: amount.trim() === '' ? null : Number(amount), expectedDelivery: delivery || null, procurementRemarks: remarks,
    }),
    onSuccess: (d) => { toast.success('Procurement details saved.'); setError(null); onSaved(d); },
    onError: (e) => setError(errorMessage(e)),
  });
  function submit() {
    if (amount.trim() !== '' && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) { setError('Enter the quoted amount as a number.'); return; }
    setError(null);
    save.mutate();
  }
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Procurement details">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pr-assigned">Assigned to</Label>
          <NativeSelect id="pr-assigned" value={assigned} onChange={(e) => setAssigned(e.target.value)}>
            <option value="">Nobody yet</option>
            {mr.assignedTo && !procPeople.some((p) => p.id === mr.assignedTo) && <option value={mr.assignedTo}>{mr.assignedToName}</option>}
            {procPeople.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="pr-vendor">Vendor</Label><Input id="pr-vendor" value={vendor} maxLength={200} onChange={(e) => setVendor(e.target.value)} className="text-base" /></div>
        <div className="grid gap-1.5"><Label htmlFor="pr-contact">Vendor contact</Label><Input id="pr-contact" value={contact} maxLength={300} onChange={(e) => setContact(e.target.value)} className="text-base" /></div>
        <div className="grid gap-1.5"><Label htmlFor="pr-quote">Quotation reference</Label><Input id="pr-quote" value={quote} maxLength={100} onChange={(e) => setQuote(e.target.value)} className="text-base" /></div>
        <div className="grid gap-1.5"><Label htmlFor="pr-amount">Quoted amount (QR)</Label><Input id="pr-amount" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-base" /></div>
        <div className="grid gap-1.5"><Label htmlFor="pr-delivery">Expected delivery</Label><Input id="pr-delivery" type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} className="text-base" /></div>
      </div>
      <div className="grid gap-1.5"><Label htmlFor="pr-remarks">Procurement remarks</Label><Textarea id="pr-remarks" rows={2} maxLength={2000} value={remarks} onChange={(e) => setRemarks(e.target.value)} className="text-base" /></div>
      <FormError message={error} />
      <Button type="submit" className="justify-self-start" disabled={save.isPending}>Save details</Button>
    </form>
  );
}

export function MrDetailView({ mr, role, userId, people = [] }: { mr: MrDetail; role: string; userId: string; people?: Person[] }) {
  const refresh = useRefreshMr(mr.id);
  const isCoord = (COORD_LEVEL as readonly string[]).includes(role);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [closeOpen, setCloseOpen] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [note, setNote] = React.useState('');
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [docKind, setDocKind] = React.useState<MrDocKind>('quote');
  const [docBusy, setDocBusy] = React.useState(false);
  const docInput = React.useRef<HTMLInputElement>(null);
  const [delDoc, setDelDoc] = React.useState<string | null>(null);

  const next = mr.can.nextStatuses;
  const procNext = next.filter((s) => s !== 'cancelled' && s !== 'closed');
  const overdue = mr.lines.some((l) => l.targetDate && l.targetDate < new Date().toISOString().slice(0, 10)) && ['submitted', 'accepted', 'enquiry', 'quoted', 'ordered'].includes(mr.status);

  const move = useMutation({
    mutationFn: (b: { to: MrStatus; note?: string }) => apiPost<MrDetail>(OPS.mrStatus(mr.id), b),
    onSuccess: (d) => { toast.success(`Now: ${MR_STATUS[d.status].label}.`); setTo(''); setNote(''); setStatusError(null); setCancelOpen(false); setCloseOpen(false); refresh(d); },
    onError: (e) => setStatusError(errorMessage(e)),
  });

  function applyStatus() {
    const target = (to || procNext[0]) as MrStatus | undefined;
    if (!target) return;
    if (target === 'rejected' && !note.trim()) { setStatusError('Say why the request is rejected.'); return; }
    setStatusError(null);
    move.mutate({ to: target, ...(note.trim() ? { note: note.trim() } : {}) });
  }

  async function uploadDocs(files: FileList | null) {
    if (!files?.length) return;
    setDocBusy(true);
    try {
      const f = new FormData();
      f.append('kind', 'doc');
      f.append('docKind', docKind);
      for (const file of Array.from(files)) f.append('file', file, file.name);
      await api(OPS.mrAttachments(mr.id), { method: 'POST', form: f });
      toast.success('Document added.');
      refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setDocBusy(false); }
  }

  const photosEditable = mr.can.upload;
  const hasVendorInfo = mr.vendorName || mr.quotationRef || mr.quotedAmount !== null || mr.expectedDelivery || mr.procurementRemarks || mr.assignedToName;

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-bold">{mr.mrCode}</h1>
            <MrStatusBadge status={mr.status} />
            {overdue && <StatusBadge tone="danger">Overdue</StatusBadge>}
            {mr.wrCode && <Link to={`/work-requests/${encodeURIComponent(mr.wrCode)}`} className="text-sm underline">WR {mr.wrCode}</Link>}
          </div>
          <p className="text-sm text-muted-foreground">Raised by {mr.requestedByName ?? 'unknown'} on {fmtDate(mr.dateRequested)}</p>
          <div className="flex flex-wrap gap-2">
            {mr.can.edit && <Button asChild variant="outline"><Link to={`/procurement/mr/${mr.id}/edit`}><Pencil className="size-4" aria-hidden /> Edit</Link></Button>}
            {next.includes('cancelled') && <Button variant="outline" onClick={() => setCancelOpen(true)}>Cancel request</Button>}
            {next.includes('closed') && <Button onClick={() => setCloseOpen(true)}>Close request</Button>}
          </div>
          <MrStepper mr={mr} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Materials / service request</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <dl className="grid grid-cols-2 border-l border-t md:grid-cols-4" aria-label="Request header">
            <Cell label="Project name">{mr.projectName}</Cell>
            <Cell label="Project contract no.">{mr.contractNo}</Cell>
            <Cell label="Item discipline">{mr.itemDiscipline}</Cell>
            <Cell label="Date requested">{fmtDate(mr.dateRequested)}</Cell>
            <Cell label="MR reference no.">{mr.mrCode}</Cell>
            <Cell label="Work request">{mr.wrCode}</Cell>
            <Cell label="Facility / zone">{[mr.facility, mr.zone].filter(Boolean).join(' / ')}</Cell>
            <Cell label="Building">{mr.buildingName}</Cell>
            <Cell label="Purchase of"><span className="flex flex-wrap gap-3"><Tick on={mr.purchaseType === 'materials'} label="Materials" /><Tick on={mr.purchaseType === 'services'} label="Services" /></span></Cell>
            <Cell label="Purpose of purchase"><span className="flex flex-wrap gap-3"><Tick on={mr.purpose === 'stock'} label="Stock" /><Tick on={mr.purpose === 'new'} label="New" /></span></Cell>
            <Cell label="Any additional requirements" className="col-span-2">{mr.additionalRequirements}</Cell>
            <Cell label="Required documents attached" className="col-span-2 md:col-span-4">
              <span className="flex flex-wrap gap-x-4 gap-y-1">{DOC_KINDS.map((k) => <Tick key={k} on={mr.docsRequired.includes(k)} label={DOC_KIND_LABELS[k]} />)}</span>
            </Cell>
          </dl>

          <div className="hidden overflow-x-auto md:block">
            <Table aria-label="Items">
              <TableHeader>
                <TableRow>
                  <TableHead>Sl.</TableHead><TableHead>WR no.</TableHead><TableHead>Store Sl. no. / Client mat&apos;s ref.</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Qty</TableHead>
                  <TableHead>UoM</TableHead><TableHead>Brand / make</TableHead><TableHead>Material / service</TableHead><TableHead>Vendor</TableHead><TableHead>Claimable</TableHead><TableHead>Target date</TableHead><TableHead>Remarks / photo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mr.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.lineNo}</TableCell>
                    <TableCell className="font-mono">{l.wrCode}</TableCell>
                    <TableCell>{[l.storeSlNo, l.clientMatRef].filter(Boolean).join(' / ')}</TableCell>
                    <TableCell className="min-w-48 whitespace-normal">{l.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                    <TableCell>{l.uom}</TableCell>
                    <TableCell>{l.brand}</TableCell>
                    <TableCell className="capitalize">{l.kind}</TableCell>
                    <TableCell className="capitalize">{l.vendorOrigin ?? '—'}</TableCell>
                    <TableCell>{l.claimable === null ? '—' : l.claimable ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{fmtDate(l.targetDate)}</TableCell>
                    <TableCell className="min-w-40 whitespace-normal">
                      {l.remarks && <p className="mb-1">{l.remarks}</p>}
                      <LinePhotos mr={mr} line={l} canAdd={photosEditable} userId={userId} isCoord={isCoord} onChange={() => refresh()} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="grid gap-2 md:hidden" aria-label="Items">
            {mr.lines.map((l) => (
              <li key={l.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                <p className="font-semibold">{l.lineNo}. {l.description}</p>
                <p>{l.quantity} {l.uom ?? ''}{l.brand ? ` · ${l.brand}` : ''} · <span className="capitalize">{l.kind}</span></p>
                <Facts items={[
                  ['WR no.', l.wrCode], ['Store Sl. / client ref.', [l.storeSlNo, l.clientMatRef].filter(Boolean).join(' / ')],
                  ['Suggested vendor', l.vendorOrigin], ['Claimable', l.claimable === null ? null : l.claimable ? 'Yes' : 'No'], ['Target date', l.targetDate ? fmtDate(l.targetDate) : null], ['Remarks', l.remarks],
                ]} />
                <LinePhotos mr={mr} line={l} canAdd={photosEditable} userId={userId} isCoord={isCoord} onChange={() => refresh()} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {mr.can.procure ? (
        <Card>
          <CardHeader><CardTitle>Procurement</CardTitle></CardHeader>
          <CardContent className="grid gap-5">
            {procNext.length > 0 && (
              <div className="grid gap-3 rounded-lg border p-3" role="group" aria-label="Move this request">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="pr-status">Move to</Label>
                    <NativeSelect id="pr-status" value={to || procNext[0]} onChange={(e) => setTo(e.target.value)}>
                      {procNext.map((s) => <option key={s} value={s}>{MR_STATUS[s].label}</option>)}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1.5"><Label htmlFor="pr-note">Note (needed to reject)</Label><Input id="pr-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className="text-base" /></div>
                </div>
                <FormError message={statusError} />
                <div className="flex flex-wrap gap-2">
                  {mr.status === 'submitted' && <Button disabled={move.isPending} onClick={() => move.mutate({ to: 'accepted', ...(note.trim() ? { note: note.trim() } : {}) })}>Accept</Button>}
                  <Button variant={mr.status === 'submitted' ? 'outline' : 'default'} disabled={move.isPending} onClick={applyStatus}>Update status</Button>
                </div>
              </div>
            )}
            <ProcurementPanel key={mr.updatedAt} mr={mr} people={people} onSaved={(d) => refresh(d)} />
          </CardContent>
        </Card>
      ) : hasVendorInfo ? (
        <Card>
          <CardHeader><CardTitle>Procurement</CardTitle></CardHeader>
          <CardContent>
            <Facts items={[['Assigned to', mr.assignedToName], ['Vendor', mr.vendorName], ['Vendor contact', mr.vendorContact], ['Quotation ref.', mr.quotationRef], ['Quoted amount', mr.quotedAmount === null ? null : qr(mr.quotedAmount)], ['Expected delivery', mr.expectedDelivery ? fmtDate(mr.expectedDelivery) : null], ['Remarks', mr.procurementRemarks]]} />
          </CardContent>
        </Card>
      ) : null}

      <MrLpoCard lpos={mr.lpos ?? []} />

      <Card>
        <CardHeader><CardTitle>Documents</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {mr.documents.length === 0 ? <p className="text-sm text-muted-foreground">No documents yet.</p> : (
            <ul className="grid gap-2">
              {mr.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-2 text-sm">
                  <Thumb file={d} alt={d.fileName} />
                  <span className="min-w-0 flex-1">
                    <Badge variant="neutral">{d.docKind ? DOC_KIND_LABELS[d.docKind] : 'Document'}</Badge>
                    <span className="block truncate">{d.fileName}</span>
                    <span className="block text-xs text-muted-foreground">{[d.uploadedByName, formatDateTime(d.createdAt)].filter(Boolean).join(' · ')}</span>
                  </span>
                  {mr.can.upload && (isCoord || d.uploadedBy === userId) && <Button size="sm" variant="ghost" aria-label={`Delete ${d.fileName}`} onClick={() => setDelDoc(d.id)}><Trash2 className="size-4" aria-hidden /></Button>}
                </li>
              ))}
            </ul>
          )}
          {mr.can.upload && (
            <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
                <Label htmlFor="doc-kind">Document type</Label>
                <NativeSelect id="doc-kind" value={docKind} onChange={(e) => setDocKind(e.target.value as MrDocKind)}>
                  {DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>)}
                </NativeSelect>
              </div>
              <Button type="button" disabled={docBusy} onClick={() => docInput.current?.click()}><Upload className="size-4" aria-hidden /> Add document</Button>
              <input ref={docInput} type="file" accept="image/*,application/pdf" multiple hidden aria-label="Choose documents" onChange={(e) => { void uploadDocs(e.target.files); e.target.value = ''; }} />
              <p className="text-xs text-muted-foreground sm:col-span-2">JPEG, PNG, WebP or PDF, up to 10 MB each.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent>
          <Timeline
            items={[...mr.history].reverse().map((h) => ({
              id: h.id,
              title: MR_STATUS[h.toStatus].label,
              at: formatDateTime(h.at),
              state: 'done' as const,
              note: <span>{[h.userName, h.note].filter(Boolean).join(' · ')}</span>,
            }))}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel this request?" destructive confirmLabel="Cancel request" cancelLabel="Keep it"
        description="Procurement will not see it as new any more. This cannot be undone."
        onConfirm={async () => { await move.mutateAsync({ to: 'cancelled' }).catch(() => undefined); }}
      />
      <ConfirmDialog
        open={closeOpen} onOpenChange={setCloseOpen} title="Close this request?" confirmLabel="Close request"
        description="Confirm that the material has been received."
        onConfirm={async () => { await move.mutateAsync({ to: 'closed' }).catch(() => undefined); }}
      />
      <ConfirmDialog
        open={delDoc !== null} onOpenChange={(o) => { if (!o) setDelDoc(null); }} title="Delete this document?" destructive confirmLabel="Delete"
        onConfirm={async () => {
          try { await apiDelete(OPS.mrAttachment(mr.id, delDoc!)); toast.success('Document deleted.'); setDelDoc(null); refresh(); } catch (e) { toast.error(errorMessage(e)); }
        }}
      />
    </div>
  );
}

export default function MrDetailPage() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const meta = useMeta();
  const q = useQuery({ queryKey: ['mr', id], queryFn: () => apiGet<MrDetail>(OPS.mr(id)) });
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/procurement/mr"><ArrowLeft className="size-4" aria-hidden /> Material requests</Link></Button>
      {q.isPending ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : user ? (
        <MrDetailView mr={q.data} role={user.role} userId={user.id} people={meta.data?.people ?? []} />
      ) : null}
    </>
  );
}
