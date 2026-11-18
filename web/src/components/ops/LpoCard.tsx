import * as React from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Pencil, Plus, Trash2, Upload, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { FormError, NativeSelect } from '@/components/admin/kit';
import { api, apiGet, apiPatch, apiPost, apiDelete } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { isProcurementRole, qr } from '@/lib/mr';
import { fmtDate } from '@/lib/ops';
import type { Lpo, LpoHistoryItem, RfeHistoryItem, WrDetail } from '@/lib/types';

const FIELD_LABELS: Record<string, string> = {
  lpoNo: 'LPO number', issueDate: 'Issue date', vendorName: 'Vendor', vendorContact: 'Vendor contact', approvedAmount: 'Approved amount', materialRequestId: 'Material request', remarks: 'Remarks',
};
const ACTION_LABELS: Record<LpoHistoryItem['action'], string> = {
  created: 'LPO released', updated: 'Changed', cancelled: 'Cancelled', document_added: 'Document added', document_removed: 'Document removed',
};
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function historyText(h: LpoHistoryItem): string {
  const ch = h.changes ?? {};
  if (h.action === 'created') return [ch.lpoNo, ch.vendorName].map((x) => show((x as { to?: unknown } | undefined)?.to)).join(' · ');
  if (h.action === 'updated') {
    return Object.entries(ch).map(([k, v]) => { const d = v as { from?: unknown; to?: unknown }; return `${FIELD_LABELS[k] ?? k}: ${show(d.from)} → ${show(d.to)}`; }).join('; ');
  }
  if (h.action === 'cancelled') return show(ch.reason);
  if (h.action === 'document_added') return Array.isArray(ch.files) ? ch.files.join(', ') : '';
  return show(ch.file);
}

function useRefresh(code?: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of ['procurement-summary', 'lpo', 'lpo-pending', 'mr', 'work-requests']) void qc.invalidateQueries({ queryKey: [k] });
    if (code) void qc.invalidateQueries({ queryKey: ['wr', code] });
    else void qc.invalidateQueries({ queryKey: ['wr'] });
  };
}

/** Add (lpo = undefined) or edit an LPO. `mrs` are the work request's material requests; when not given they are fetched with the work request. */
export function LpoDialog({
  open, onOpenChange, wrCode, lpo, mrs, today,
}: { open: boolean; onOpenChange: (v: boolean) => void; wrCode: string; lpo?: Lpo; mrs?: { id: string; mrCode: string }[]; today?: string }) {
  const refresh = useRefresh(wrCode);
  const wrq = useQuery({ queryKey: ['wr', wrCode], queryFn: () => apiGet<WrDetail>(OPS.workRequest(wrCode)), enabled: open && mrs === undefined });
  const mrList = mrs ?? wrq.data?.materialRequests ?? [];
  const [lpoNo, setLpoNo] = React.useState(lpo?.lpoNo ?? '');
  const [issueDate, setIssueDate] = React.useState(lpo?.issueDate ?? today ?? new Date().toISOString().slice(0, 10));
  const [vendorName, setVendorName] = React.useState(lpo?.vendorName ?? '');
  const [vendorContact, setVendorContact] = React.useState(lpo?.vendorContact ?? '');
  const [amount, setAmount] = React.useState(lpo?.approvedAmount != null ? String(lpo.approvedAmount) : '');
  const [mrId, setMrId] = React.useState(lpo?.materialRequestId ?? '');
  const [remarks, setRemarks] = React.useState(lpo?.remarks ?? '');
  const [file, setFile] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        lpoNo: lpoNo.trim(), issueDate, vendorName: vendorName.trim(), vendorContact: vendorContact.trim() || null, approvedAmount: Number(amount),
        materialRequestId: mrId || null, remarks: remarks.trim() || null,
      };
      if (lpo) return apiPatch<Lpo>(OPS.lpo(lpo.id), body);
      const { vendorContact: vc, remarks: rm, materialRequestId, ...rest } = body;
      const created = await apiPost<Lpo>(OPS.lpos, { wrCode, ...rest, ...(vc ? { vendorContact: vc } : {}), ...(rm ? { remarks: rm } : {}), ...(materialRequestId ? { materialRequestId } : {}) });
      if (file) {
        const f = new FormData();
        f.append('file', file, file.name);
        try { await api(OPS.lpoDocuments(created.id), { method: 'POST', form: f }); } catch (e) { toast.error(`The LPO was saved, but the document was not: ${errorMessage(e)}`); }
      }
      return created;
    },
    onSuccess: (res) => {
      if (res.warning) toast.warning(`${res.warning}. The LPO was saved.`); else toast.success(lpo ? 'LPO updated.' : 'LPO saved.');
      onOpenChange(false);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit() {
    const n = Number(amount);
    if (!lpoNo.trim()) { setError('Enter the LPO number.'); return; }
    if (!issueDate) { setError('Pick the issue date.'); return; }
    if (!vendorName.trim()) { setError('Enter the vendor name.'); return; }
    if (!amount.trim() || !Number.isFinite(n) || n < 0) { setError('Enter the approved amount in QR.'); return; }
    setError(null);
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lpo ? `Edit LPO ${lpo.lpoNo}` : `Add LPO for WR ${wrCode}`}</DialogTitle>
          <DialogDescription>Type in what the released LPO says. SONU only records it; nothing is sent to Marafiq.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
          <div className="grid gap-1.5"><Label htmlFor="lpo-no">LPO number</Label><Input id="lpo-no" value={lpoNo} maxLength={100} onChange={(e) => setLpoNo(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="lpo-date">Issue date</Label><Input id="lpo-date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="lpo-vendor">Vendor name</Label><Input id="lpo-vendor" value={vendorName} maxLength={200} onChange={(e) => setVendorName(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="lpo-contact">Vendor contact (optional)</Label><Input id="lpo-contact" value={vendorContact} maxLength={300} onChange={(e) => setVendorContact(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="lpo-amount">Approved amount (QR)</Label><Input id="lpo-amount" type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          {mrList.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="lpo-mr">Material request (optional)</Label>
              <NativeSelect id="lpo-mr" value={mrId} onChange={(e) => setMrId(e.target.value)}>
                <option value="">Not linked</option>
                {mrList.map((m) => <option key={m.id} value={m.id}>{m.mrCode}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-1.5"><Label htmlFor="lpo-remarks">Remarks (optional)</Label><Textarea id="lpo-remarks" rows={2} maxLength={2000} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
          {!lpo && (
            <div className="grid gap-1.5">
              <Label htmlFor="lpo-file">LPO document (optional)</Label>
              <Input id="lpo-file" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <p className="text-xs text-muted-foreground">PDF or photo, up to 10 MB. You can add it later too.</p>
            </div>
          )}
          <FormError message={error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{lpo ? 'Save changes' : 'Save LPO'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LpoItem({ lpo, wr }: { lpo: Lpo; wr: WrDetail }) {
  const refresh = useRefresh(wr.wrCode);
  const [editOpen, setEditOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [histOpen, setHistOpen] = React.useState(false);
  const [delDoc, setDelDoc] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const cancelled = lpo.status === 'cancelled';

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const f = new FormData();
      for (const x of files) f.append('file', x, x.name);
      return api(OPS.lpoDocuments(lpo.id), { method: 'POST', form: f });
    },
    onSuccess: () => { toast.success('Document added.'); refresh(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => apiPost(OPS.lpoCancel(lpo.id), { reason: reason.trim() }),
    onSuccess: () => { toast.success('LPO cancelled.'); setCancelOpen(false); setReason(''); refresh(); },
    onError: (e) => setReasonError(errorMessage(e)),
  });

  return (
    <li className="grid gap-2 rounded-lg border p-3 text-sm" data-testid={`lpo-${lpo.lpoNo}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{lpo.lpoNo}</span>
        <StatusBadge tone={cancelled ? 'neutral' : 'success'}>{cancelled ? 'Cancelled' : 'Released'}</StatusBadge>
        {lpo.mrCode && lpo.materialRequestId && <Link to={`/procurement/mr/${lpo.materialRequestId}`} className="font-mono text-xs underline">{lpo.mrCode}</Link>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Issue date</dt><dd className="font-medium">{fmtDate(lpo.issueDate)}</dd></div>
        <div className="min-w-0"><dt className="text-xs text-muted-foreground">Vendor</dt><dd className="break-words font-medium">{lpo.vendorName}</dd></div>
        {lpo.approvedAmount !== null && <div><dt className="text-xs text-muted-foreground">Approved amount</dt><dd className="font-medium">{qr(lpo.approvedAmount)}</dd></div>}
        {lpo.vendorContact && <div className="min-w-0"><dt className="text-xs text-muted-foreground">Vendor contact</dt><dd className="break-words">{lpo.vendorContact}</dd></div>}
      </dl>
      {lpo.remarks && <p className="text-muted-foreground">{lpo.remarks}</p>}
      {cancelled && lpo.cancelledReason && <p className="text-muted-foreground">Cancelled: {lpo.cancelledReason}</p>}
      <div>
        {lpo.documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No LPO document yet.</p>
        ) : (
          <ul className="grid gap-1">
            {lpo.documents.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <a href={OPS.attachment(d.id)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate underline">{d.fileName}</a>
                {lpo.can.edit && <Button size="sm" variant="ghost" aria-label={`Remove ${d.fileName}`} onClick={() => setDelDoc(d.id)}><Trash2 className="size-4" aria-hidden /></Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {lpo.can.edit && (
          <>
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}><Pencil className="size-4" aria-hidden /> Edit</Button>
            <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}><Upload className="size-4" aria-hidden /> Upload document</Button>
            <input ref={input} type="file" hidden multiple accept="image/*,application/pdf" aria-label="Choose LPO documents" onChange={(e) => { const l = Array.from(e.target.files ?? []); e.target.value = ''; if (l.length) upload.mutate(l); }} />
            <Button size="sm" variant="outline" onClick={() => { setReasonError(null); setCancelOpen(true); }}><XCircle className="size-4" aria-hidden /> Cancel LPO</Button>
          </>
        )}
        <Button size="sm" variant="ghost" aria-expanded={histOpen} onClick={() => setHistOpen((v) => !v)}>
          {histOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />} History
        </Button>
      </div>
      {histOpen && (
        <ol className="grid gap-1 border-l pl-3 text-xs" aria-label={`History of LPO ${lpo.lpoNo}`}>
          {(lpo.history ?? []).map((h) => (
            <li key={h.id}><strong>{ACTION_LABELS[h.action]}</strong> <span className="text-muted-foreground">{formatDateTime(h.at)}{h.userName ? ` · ${h.userName}` : ''}</span>{historyText(h) && <span className="block break-words">{historyText(h)}</span>}</li>
          ))}
        </ol>
      )}
      {editOpen && <LpoDialog open={editOpen} onOpenChange={setEditOpen} wrCode={wr.wrCode} lpo={lpo} mrs={wr.materialRequests ?? []} />}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel LPO {lpo.lpoNo}?</DialogTitle><DialogDescription>It stays in the history, and the work request goes back to LPO Pending.</DialogDescription></DialogHeader>
          <div className="grid gap-1.5"><Label htmlFor={`cancel-${lpo.id}`}>Reason</Label><Textarea id={`cancel-${lpo.id}`} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <FormError message={reasonError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep LPO</Button>
            <Button variant="destructive" disabled={cancel.isPending} onClick={() => { if (!reason.trim()) { setReasonError('Say why the LPO is cancelled.'); return; } cancel.mutate(); }}>Cancel LPO</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={delDoc !== null} onOpenChange={(v) => { if (!v) setDelDoc(null); }} title="Remove this document?" destructive confirmLabel="Remove"
        description="The file is deleted. The history keeps a note that it was removed."
        onConfirm={async () => { try { await apiDelete(OPS.lpoDocument(lpo.id, delDoc!)); toast.success('Document removed.'); refresh(); } catch (e) { toast.error(errorMessage(e)); } }}
      />
    </li>
  );
}

function RfeHistory({ items }: { items: RfeHistoryItem[] }) {
  return (
    <ol className="grid gap-1 border-l pl-3 text-xs" aria-label="RFE and LPO history">
      {items.map((h, i) => (
        <li key={`${h.at}-${i}`}>
          <strong>{fmtDate(h.at)}</strong> <Badge variant={h.source === 'sonu' ? 'default' : 'neutral'}>{h.source === 'sonu' ? 'SONU' : 'Marafiq'}</Badge> {h.by ? `${h.by}: ` : ''}<span className="break-words">{h.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** WR detail: the RFE information and every LPO of this work request (with its history), and the buttons for procurement. */
export function RfeLpoCard({ wr, role }: { wr: WrDetail; role: string }) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [histOpen, setHistOpen] = React.useState(false);
  const lpos = wr.lpos ?? [];
  const rfe = wr.rfe;
  const canAdd = isProcurementRole(role) && !wr.goneAt && !!rfe;
  if (!rfe && lpos.length === 0) return null;
  const history = wr.rfeHistory ?? [];
  const facts: [string, React.ReactNode][] = rfe
    ? [['RFE submitted', fmtDate(rfe.submittedOn)], ['RFE approved', rfe.approvedOn ? fmtDate(rfe.approvedOn) : 'Not approved yet'], ['Pending with', rfe.pendingWith],
      ...(rfe.rfeAmount != null ? [['RFE amount', qr(rfe.rfeAmount)] as [string, React.ReactNode]] : []), ['BPA release', rfe.bpaReleaseRef], ['Comments', String(wr.rfeComments.length)]]
    : [];
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>RFE &amp; LPO</CardTitle>
        {canAdd && <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-4" aria-hidden /> Add LPO</Button>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
            {facts.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-medium">{v ?? '—'}</dd></div>)}
          </dl>
        )}
        {lpos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{rfe?.approvedOn ? 'The RFE is approved. No LPO has been entered yet.' : 'No LPO has been entered yet.'}</p>
        ) : (
          <ul className="grid gap-3" aria-label="LPOs">{lpos.map((l) => <LpoItem key={l.id} lpo={l} wr={wr} />)}</ul>
        )}
        {history.length > 0 && (
          <div className="grid gap-2">
            <Button size="sm" variant="ghost" className="justify-self-start" aria-expanded={histOpen} onClick={() => setHistOpen((v) => !v)}>
              {histOpen ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />} RFE and LPO history ({history.length})
            </Button>
            {histOpen && <RfeHistory items={history} />}
          </div>
        )}
      </CardContent>
      {addOpen && <LpoDialog open={addOpen} onOpenChange={setAddOpen} wrCode={wr.wrCode} mrs={wr.materialRequests ?? []} today={wr.today} />}
    </Card>
  );
}

/** MR detail: the LPOs linked to this request. */
export function MrLpoCard({ lpos }: { lpos: Lpo[] }) {
  if (!lpos.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>LPO</CardTitle></CardHeader>
      <CardContent>
        <ul className="grid gap-2" aria-label="Linked LPOs">
          {lpos.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
              <span className="font-mono font-semibold">{l.lpoNo}</span>
              <StatusBadge tone={l.status === 'cancelled' ? 'neutral' : 'success'}>{l.status === 'cancelled' ? 'Cancelled' : 'Released'}</StatusBadge>
              <span className="text-muted-foreground">{[fmtDate(l.issueDate), l.vendorName, l.approvedAmount !== null ? qr(l.approvedAmount) : null].filter(Boolean).join(' · ')}</span>
              {l.documents.map((d) => <a key={d.id} href={OPS.attachment(d.id)} target="_blank" rel="noopener noreferrer" className="underline">{d.fileName}</a>)}
              <Link to={`/work-requests/${encodeURIComponent(l.wrCode)}`} className="font-mono text-xs underline">WR {l.wrCode}</Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
