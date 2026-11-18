import * as React from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, CheckCircle2, Download, FilePlus2, Pencil, Plus, Send, Trash2, Undo2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Timeline } from '@/components/Timeline';
import { ErrorState, FormError, NativeSelect } from '@/components/admin/kit';
import { PettyCashLineDialog } from '@/components/ops/PettyCashLineDialog';
import { PettyCashStatusBadge } from '@/components/ops/PettyCashStatusBadge';
import { api, apiBlob, apiDelete, apiGet, apiPatch, apiPost, saveBlob } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { compressImage } from '@/lib/image';
import { fmtDate } from '@/lib/ops';
import { approvePayload, claimActions, monthLabel, PC_STATUS, qar, type ClaimAction } from '@/lib/pettyCash';
import { useSession } from '@/lib/session';
import type { PettyCashDetail, PettyCashLine, PettyCashReceipt } from '@/lib/types';
import { cn } from '@/lib/utils';

function useRefreshClaim(id: string) {
  const qc = useQueryClient();
  return (data?: PettyCashDetail) => {
    if (data) qc.setQueryData(['petty-cash', id], data);
    else void qc.invalidateQueries({ queryKey: ['petty-cash', id] });
    for (const k of ['petty-cash-list', 'procurement-summary', 'zero-rfe', 'wr']) void qc.invalidateQueries({ queryKey: [k] });
  };
}

/** True from the md breakpoint up (the wide table); phones get stacked cards. No media query support: cards. */
export function useWide(): boolean {
  const query = '(min-width: 768px)';
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [wide, setWide] = React.useState(get);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 border-b border-r p-2', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{children || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function Receipts({ line, claim, canEdit, onChange }: { line: PettyCashLine; claim: PettyCashDetail; canEdit: boolean; onChange: () => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const f = new FormData();
      for (const file of Array.from(files)) { const c = await compressImage(file); f.append('file', c, c.name); }
      await api(OPS.pettyCashLineFiles(claim.id, line.id), { method: 'POST', form: f });
      onChange();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove(r: PettyCashReceipt) {
    try { await apiDelete(OPS.pettyCashLineFile(claim.id, line.id, r.id)); onChange(); } catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {line.receipts.map((r) => (
        <span key={r.id} className="relative">
          <a href={OPS.attachment(r.id)} target="_blank" rel="noopener noreferrer" className="block size-14 overflow-hidden rounded-lg border bg-muted" aria-label={`Open ${r.source === 'local_purchase' ? 'receipt' : 'bill photo'} ${r.fileName}`}>
            <img src={OPS.attachment(r.id)} alt={`${r.source === 'local_purchase' ? 'Receipt' : 'Bill'} for line ${line.lineNo}`} loading="lazy" className="size-full object-cover" />
          </a>
          {canEdit && r.source === 'line' && (
            <button type="button" onClick={() => void remove(r)} aria-label={`Remove photo ${r.fileName}`} className="absolute -end-1 -top-1 inline-flex size-6 items-center justify-center rounded-full bg-black/70 text-white"><Trash2 className="size-3.5" aria-hidden /></button>
          )}
        </span>
      ))}
      {line.receipts.length === 0 && <span className="text-xs text-warning">No bill photo</span>}
      {canEdit && line.receipts.filter((r) => r.source === 'line').length < 6 && (
        <>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()} aria-label={`Add bill photo to line ${line.lineNo}`}><Camera className="size-4" aria-hidden /> Photo</Button>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        </>
      )}
    </div>
  );
}

function LineActions({ line, onEdit, onDelete }: { line: PettyCashLine; onEdit: () => void; onDelete: () => void }) {
  return (
    <span className="flex gap-1">
      <Button size="sm" variant="ghost" aria-label={`Edit line ${line.lineNo}`} onClick={onEdit}><Pencil className="size-4" aria-hidden /></Button>
      <Button size="sm" variant="ghost" aria-label={`Delete line ${line.lineNo}`} onClick={onDelete}><Trash2 className="size-4" aria-hidden /></Button>
    </span>
  );
}

const num = (n: number) => n.toLocaleString('en', { maximumFractionDigits: 3 });
const money = (n: number) => n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function LinesTable({ claim, canEdit, onEdit, onDelete, onChange }: { claim: PettyCashDetail; canEdit: boolean; onEdit: (l: PettyCashLine) => void; onDelete: (l: PettyCashLine) => void; onChange: () => void }) {
  const heads = ['Sl. No', 'GRN Code', 'Work Order No', 'WR Status', 'GL Code', 'WBS', 'Work Description', 'Location', 'RFE Approved', 'Claimable', 'Supplier', 'Material Used', 'Bill Date', 'Bill #', 'Qty', 'Unit', 'Unit Cost', 'Discount', 'Total Amount', 'Bills'];
  const approved = claim.status === 'approved';
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="lines-table">
      <table className="w-full min-w-[1700px] border-collapse text-sm">
        <thead className="bg-muted/60 text-start text-xs">
          <tr>{heads.map((h) => <th key={h} scope="col" className="border-b border-e p-2 text-start font-semibold">{h}</th>)}{canEdit && <th scope="col" className="border-b p-2"><span className="sr-only">Actions</span></th>}</tr>
        </thead>
        <tbody>
          {claim.lines.map((l) => (
            <tr key={l.id} className="align-top odd:bg-muted/20">
              <td className="border-e p-2 tabular-nums">{l.lineNo}</td>
              <td className="border-e p-2">{l.grnCode}</td>
              <td className="border-e p-2 font-mono">{l.wrCode}</td>
              <td className="border-e p-2">{l.wrStatus}</td>
              <td className="border-e p-2">{l.glCode}</td>
              <td className="border-e p-2">{l.wbs}</td>
              <td className="max-w-64 border-e p-2">{l.workDescription}</td>
              <td className="max-w-40 border-e p-2">{l.location}</td>
              <td className="border-e p-2 text-end tabular-nums">{money(l.rfeApprovedAmount)}</td>
              <td className="border-e p-2">{l.claimable ? 'Claimable' : 'Non-Claimable'}</td>
              <td className="border-e p-2">{l.supplier}</td>
              <td className="max-w-48 border-e p-2">{l.materialUsed}</td>
              <td className="border-e p-2 whitespace-nowrap">{l.billDate}</td>
              <td className="border-e p-2">{l.billNo}</td>
              <td className="border-e p-2 text-end tabular-nums">{num(l.qty)}</td>
              <td className="border-e p-2">{l.unit}</td>
              <td className="border-e p-2 text-end tabular-nums">{money(l.unitCost)}</td>
              <td className="border-e p-2 text-end tabular-nums">{money(l.discount)}</td>
              <td className="border-e p-2 text-end font-semibold tabular-nums">
                {money(l.totalAmount)}
                {approved && l.approvedTotal !== null && l.approvedTotal !== l.totalAmount && <span className="block text-xs font-normal text-success">Approved {money(l.approvedTotal)}</span>}
              </td>
              <td className="border-e p-2"><Receipts line={l} claim={claim} canEdit={canEdit} onChange={onChange} /></td>
              {canEdit && <td className="p-2"><LineActions line={l} onEdit={() => onEdit(l)} onDelete={() => onDelete(l)} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineCards({ claim, canEdit, onEdit, onDelete, onChange }: { claim: PettyCashDetail; canEdit: boolean; onEdit: (l: PettyCashLine) => void; onDelete: (l: PettyCashLine) => void; onChange: () => void }) {
  const approved = claim.status === 'approved';
  return (
    <ul className="grid gap-3" aria-label="Claim lines">
      {claim.lines.map((l) => {
        const facts: [string, React.ReactNode][] = [
          ['Work order', l.wrCode], ['WR status', l.wrStatus], ['Location', l.location], ['Supplier', l.supplier], ['Material used', l.materialUsed],
          ['Bill date', l.billDate], ['Bill #', l.billNo], ['GRN code', l.grnCode], ['GL code', l.glCode], ['WBS', l.wbs],
          ['Qty', `${num(l.qty)}${l.unit ? ` ${l.unit}` : ''}`], ['Unit cost', money(l.unitCost)], ['Discount', money(l.discount)], ['RFE approved', money(l.rfeApprovedAmount)],
        ];
        return (
          <li key={l.id}>
            <Card>
              <CardContent className="grid gap-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-semibold">Line {l.lineNo} <span className="ms-1 text-xs font-normal text-muted-foreground">{l.claimable ? 'Claimable' : 'Non-Claimable'}</span></p>
                  <p className="text-sm font-bold tabular-nums">{qar(l.totalAmount)}</p>
                </div>
                {approved && l.approvedTotal !== null && l.approvedTotal !== l.totalAmount && <p className="text-xs text-success">Approved {qar(l.approvedTotal)}</p>}
                {l.workDescription && <p className="break-words text-sm">{l.workDescription}</p>}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {facts.filter(([, v]) => v !== null && v !== '').map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words font-medium">{v}</dd></div>)}
                </dl>
                <Receipts line={l} claim={claim} canEdit={canEdit} onChange={onChange} />
                {canEdit && <LineActions line={l} onEdit={() => onEdit(l)} onDelete={() => onDelete(l)} />}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function HeaderForm({ claim, onSaved }: { claim: PettyCashDetail; onSaved: (d: PettyCashDetail) => void }) {
  const [project, setProject] = React.useState(claim.projectName ?? '');
  const [month, setMonth] = React.useState(claim.month);
  const [type, setType] = React.useState(claim.purchaseType);
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => apiPatch<PettyCashDetail>(OPS.pettyCashClaim(claim.id), { projectName: project, month, purchaseType: type }),
    onSuccess: (d) => { toast.success('Header saved.'); setError(null); onSaved(d); },
    onError: (e) => setError(errorMessage(e)),
  });
  const dirty = project !== (claim.projectName ?? '') || month !== claim.month || type !== claim.purchaseType;
  return (
    <form className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (!month) { setError('Pick the month.'); return; } save.mutate(); }} aria-label="Claim header">
      <div className="grid gap-1.5"><Label htmlFor="pch-project">Project name</Label><Input id="pch-project" value={project} maxLength={200} onChange={(e) => setProject(e.target.value)} className="text-base" /></div>
      <div className="grid gap-1.5"><Label htmlFor="pch-month">Month</Label><Input id="pch-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="text-base" /></div>
      <div className="grid gap-1.5"><Label>Ref. no.</Label><p className="flex min-h-11 items-center font-mono text-sm font-semibold">{claim.code}</p></div>
      <div className="grid gap-1.5">
        <Label htmlFor="pch-type">Type</Label>
        <NativeSelect id="pch-type" value={type} onChange={(e) => setType(e.target.value as 'materials' | 'services')}><option value="materials">Materials</option><option value="services">Services</option></NativeSelect>
      </div>
      <div className="sm:col-span-2 lg:col-span-4"><FormError message={error} /></div>
      {dirty && <Button type="submit" className="justify-self-start" disabled={save.isPending}>Save header</Button>}
    </form>
  );
}

function Signatures({ claim }: { claim: PettyCashDetail }) {
  const boxes: [string, string | null, string | null][] = [
    ['Prepared By', claim.preparedByName, claim.preparedAt],
    ['Review & Noted By (Admin)', claim.reviewedByName, claim.reviewedAt],
    ['Approved By (Project Manager)', claim.approvedByName, claim.approvedAt],
    ['Approved By', null, null],
  ];
  return (
    <section aria-label="Signatures" className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {boxes.map(([cap, name, at], i) => (
        <div key={`${cap}-${i}`} className="flex min-h-28 flex-col justify-between rounded-lg border p-3">
          <p className="text-xs font-semibold text-muted-foreground">{cap}</p>
          <div><p className="break-words text-sm font-medium">{name ?? ''}</p>{at && <p className="text-xs text-muted-foreground">{fmtDate(at)}</p>}</div>
        </div>
      ))}
    </section>
  );
}

type Dlg = null | { kind: 'return' | 'reject' } | { kind: 'approve' };

export function PettyCashDetailView({ claim, role, userId }: { claim: PettyCashDetail; role: string; userId: string }) {
  void role; void userId;
  const refresh = useRefreshClaim(claim.id);
  const wide = useWide();
  const [lineDlg, setLineDlg] = React.useState<{ line?: PettyCashLine } | null>(null);
  const [delLine, setDelLine] = React.useState<PettyCashLine | null>(null);
  const [dlg, setDlg] = React.useState<Dlg>(null);
  const [note, setNote] = React.useState('');
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [totalOverride, setTotalOverride] = React.useState<string | null>(null);
  const [dlgError, setDlgError] = React.useState<string | null>(null);
  const [busyImport, setBusyImport] = React.useState(false);
  const [busyExport, setBusyExport] = React.useState(false);
  const can = claim.can;
  const actions = claimActions(can);

  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<PettyCashDetail>(OPS.pettyCashAction(claim.id), body),
    onSuccess: (d) => { toast.success(`${d.code}: ${PC_STATUS[d.status].label}.`); setDlg(null); setNote(''); setDlgError(null); refresh(d); },
    onError: (e) => { setDlgError(errorMessage(e)); toast.error(errorMessage(e)); },
  });

  async function importPurchases() {
    setBusyImport(true);
    try {
      const r = await apiPost<{ added: number; claim: PettyCashDetail }>(OPS.pettyCashImport(claim.id), {});
      toast.success(r.added ? `${r.added} local ${r.added === 1 ? 'purchase' : 'purchases'} added.` : 'No unclaimed local purchases found.');
      refresh(r.claim);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusyImport(false); }
  }
  async function exportXlsx() {
    setBusyExport(true);
    try {
      const { blob, fileName } = await apiBlob(OPS.pettyCashExport(claim.id));
      saveBlob(blob, fileName ?? `sonu-${claim.code}-${claim.month}.xlsx`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusyExport(false); }
  }

  const approval = React.useMemo(() => approvePayload(claim.lines, amounts, totalOverride), [claim.lines, amounts, totalOverride]);
  function confirmApprove() {
    for (const l of claim.lines) {
      const raw = amounts[l.id];
      if (raw !== undefined && raw.trim() !== '') {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) { setDlgError(`Line ${l.lineNo}: enter an amount of 0 or more.`); return; }
        if (v > l.totalAmount) { setDlgError(`Line ${l.lineNo}: the approved amount cannot be more than ${qar(l.totalAmount)}.`); return; }
      }
    }
    if (totalOverride !== null && totalOverride.trim() !== '' && (!Number.isFinite(Number(totalOverride)) || Number(totalOverride) < 0 || Number(totalOverride) > claim.totalAmount)) {
      setDlgError(`The final amount must be between 0 and ${qar(claim.totalAmount)}.`);
      return;
    }
    setDlgError(null);
    act.mutate(approval.body);
  }
  function confirmNote() {
    if (!note.trim()) { setDlgError(dlg?.kind === 'return' ? 'Say what the preparer must fix.' : 'Say why the claim is rejected.'); return; }
    setDlgError(null);
    act.mutate({ action: dlg!.kind, note: note.trim() });
  }

  const button = (a: ClaimAction) => {
    switch (a) {
      case 'submit': return <Button key={a} disabled={act.isPending} onClick={() => act.mutate({ action: 'submit' })}><Send className="size-4" aria-hidden /> Submit for review</Button>;
      case 'review': return <Button key={a} disabled={act.isPending} onClick={() => act.mutate({ action: 'review' })}><CheckCircle2 className="size-4" aria-hidden /> Review and forward to Manager</Button>;
      case 'return': return <Button key={a} variant="outline" onClick={() => { setNote(''); setDlgError(null); setDlg({ kind: 'return' }); }}><Undo2 className="size-4" aria-hidden /> Return to preparer</Button>;
      case 'approve': return <Button key={a} onClick={() => { setAmounts({}); setTotalOverride(null); setDlgError(null); setDlg({ kind: 'approve' }); }}><CheckCircle2 className="size-4" aria-hidden /> Approve</Button>;
      case 'reject': return <Button key={a} variant="destructive" onClick={() => { setNote(''); setDlgError(null); setDlg({ kind: 'reject' }); }}><XCircle className="size-4" aria-hidden /> Reject</Button>;
    }
  };

  const lastReturn = [...claim.history].reverse().find((h) => h.toStatus === 'returned' || h.toStatus === 'rejected');
  const showNote = lastReturn && lastReturn.toStatus === claim.status && lastReturn.note;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Petty cash claim <span className="font-mono">{claim.code}</span></h1>
        <PettyCashStatusBadge status={claim.status} />
      </div>
      {claim.pending.label && <p className="text-sm text-muted-foreground" data-testid="pending">Waiting for: <span className="font-medium text-foreground">{claim.pending.label}</span></p>}
      {showNote && <p className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm" role="note"><span className="font-semibold">{claim.status === 'returned' ? 'Returned:' : 'Rejected:'}</span> {lastReturn!.note}</p>}

      <div className="flex flex-wrap items-center gap-2" aria-label="Actions">
        {actions.map(button)}
        {can.importPurchases && (
          <Button variant="outline" disabled={busyImport} onClick={() => void importPurchases()}>
            <FilePlus2 className="size-4" aria-hidden /> Add unclaimed local purchases{claim.unclaimedCount ? ` (${claim.unclaimedCount})` : ''}
          </Button>
        )}
        {can.edit && <Button variant="outline" onClick={() => setLineDlg({})}><Plus className="size-4" aria-hidden /> Add line</Button>}
        {can.export && <Button variant="outline" disabled={busyExport} onClick={() => void exportXlsx()}><Download className="size-4" aria-hidden /> Export Excel</Button>}
      </div>

      <Card>
        <CardHeader className="pb-0"><CardTitle className="text-center text-base tracking-wide">EXPENSE PETTY CASH REIMBURSEMENT CLAIM</CardTitle></CardHeader>
        <CardContent className="p-0 pt-3">
          {can.edit ? (
            <HeaderForm claim={claim} onSaved={refresh} />
          ) : (
            <dl className="grid grid-cols-2 border-t border-s lg:grid-cols-4">
              <Cell label="Project name">{claim.projectName}</Cell>
              <Cell label="Month">{monthLabel(claim.month)}</Cell>
              <Cell label="Ref. no.">{claim.code}</Cell>
              <Cell label="Type">{claim.purchaseType === 'services' ? 'SERVICES' : 'MATERIALS'}</Cell>
            </dl>
          )}
        </CardContent>
      </Card>

      {claim.lines.length === 0 ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">No lines yet. {can.edit ? 'Add the local purchases of 0 RFE jobs, or add a line for another bill.' : ''}</p>
      ) : wide ? (
        <LinesTable claim={claim} canEdit={can.edit} onEdit={(l) => setLineDlg({ line: l })} onDelete={setDelLine} onChange={() => refresh()} />
      ) : (
        <LineCards claim={claim} canEdit={can.edit} onEdit={(l) => setLineDlg({ line: l })} onDelete={setDelLine} onChange={() => refresh()} />
      )}

      <div className="grid gap-1 rounded-lg border bg-muted/40 p-3 text-end" data-testid="claim-total">
        <p className="text-sm font-semibold">Total Amount Claim in Qatari Riyal: <span className="text-lg tabular-nums">{qar(claim.totalAmount)}</span></p>
        {claim.approvedAmount !== null && <p className="text-sm font-semibold text-success" data-testid="approved-amount">Approved amount: <span className="text-lg tabular-nums">{qar(claim.approvedAmount)}</span></p>}
      </div>

      <Signatures claim={claim} />

      <Card>
        <CardHeader><CardTitle>Approval history</CardTitle></CardHeader>
        <CardContent>
          <Timeline
            items={claim.history.map((h) => ({
              id: h.id,
              title: `${PC_STATUS[h.toStatus].label}${h.userName ? ` · ${h.userName}` : ''}`,
              at: formatDateTime(h.at),
              note: h.note ?? undefined,
            }))}
          />
        </CardContent>
      </Card>

      {lineDlg && <PettyCashLineDialog claimId={claim.id} line={lineDlg.line} open onOpenChange={(o) => { if (!o) setLineDlg(null); }} onSaved={refresh} />}
      <ConfirmDialog
        open={delLine !== null} onOpenChange={(o) => { if (!o) setDelLine(null); }} title={`Delete line ${delLine?.lineNo ?? ''}?`} destructive confirmLabel="Delete"
        description={delLine?.localPurchaseId ? 'The local purchase is released and can be added to a claim again.' : 'The line and its bill photos are removed.'}
        onConfirm={async () => {
          try { const d = await apiDelete<PettyCashDetail>(OPS.pettyCashLine(claim.id, delLine!.id)); toast.success('Line deleted.'); setDelLine(null); refresh(d); } catch (e) { toast.error(errorMessage(e)); }
        }}
      />
      <Dialog open={dlg?.kind === 'return' || dlg?.kind === 'reject'} onOpenChange={(o) => { if (!o) setDlg(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dlg?.kind === 'return' ? 'Return to the preparer' : 'Reject this claim'}</DialogTitle>
            <DialogDescription>{dlg?.kind === 'return' ? 'The preparer can edit the claim and submit it again.' : 'A rejected claim is closed and its local purchases can go on a new claim.'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="pc-note">{dlg?.kind === 'return' ? 'What must be fixed' : 'Reason'}</Label>
            <Textarea id="pc-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className="text-base" />
          </div>
          <FormError message={dlgError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>Cancel</Button>
            <Button variant={dlg?.kind === 'reject' ? 'destructive' : 'default'} disabled={act.isPending} onClick={confirmNote}>{dlg?.kind === 'return' ? 'Return claim' : 'Reject claim'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dlg?.kind === 'approve'} onOpenChange={(o) => { if (!o) setDlg(null); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Approve {claim.code}</DialogTitle>
            <DialogDescription>Keep the claimed amounts, or lower the approved amount of a line. You can also set the final amount directly.</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-2">
            {claim.lines.map((l) => (
              <li key={l.id} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-sm">
                <Label htmlFor={`ap-${l.id}`} className="min-w-0 break-words">Line {l.lineNo}: {l.materialUsed || l.workDescription || l.wrCode || ''} <span className="text-muted-foreground">(claimed {money(l.totalAmount)})</span></Label>
                <Input id={`ap-${l.id}`} type="number" inputMode="decimal" min="0" max={l.totalAmount} step="0.01" value={amounts[l.id] ?? String(l.totalAmount)} onChange={(e) => { setAmounts((p) => ({ ...p, [l.id]: e.target.value })); setTotalOverride(null); }} className="text-base" />
              </li>
            ))}
          </ul>
          <div className="grid gap-1.5">
            <Label htmlFor="ap-total">Final approved amount (QR)</Label>
            <Input id="ap-total" type="number" inputMode="decimal" min="0" max={claim.totalAmount} step="0.01" value={totalOverride ?? String(approval.sum)} onChange={(e) => setTotalOverride(e.target.value)} className="text-base" />
          </div>
          <FormError message={dlgError} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>Cancel</Button>
            <Button disabled={act.isPending} onClick={confirmApprove}>Approve claim</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PettyCashDetailPage() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const q = useQuery({ queryKey: ['petty-cash', id], queryFn: () => apiGet<PettyCashDetail>(OPS.pettyCashClaim(id)) });
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2"><Link to="/petty-cash"><ArrowLeft className="size-4" aria-hidden /> Petty cash claims</Link></Button>
      {q.isPending ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : user ? (
        <PettyCashDetailView claim={q.data} role={user.role} userId={user.id} />
      ) : null}
    </>
  );
}
