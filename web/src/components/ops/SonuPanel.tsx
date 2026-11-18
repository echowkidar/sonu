import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/admin/kit';
import { apiPatch } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage } from '@/lib/forms';
import { CAN_EDIT_WR, COORD_ROLES, OWNER_ROLES } from '@/lib/ops';
import { ZeroRfeBlock } from '@/components/ops/ZeroRfe';
import type { Meta, WrDetail } from '@/lib/types';

export interface PatchBody { takeOwnership?: true; ownerId?: string | null; criterion?: number | null; contractorStatus?: string | null; fcRemarks?: string }

/** SONU's own fields on a work request: owner, criterion, contractor status (with the suggestion) and FC remarks. */
export function SonuPanel({ wr, meta, role, userId }: { wr: WrDetail; meta: Meta | undefined; role: string; userId: string }) {
  const qc = useQueryClient();
  const isCoord = (COORD_ROLES as readonly string[]).includes(role);
  // Mirrors the server PATCH rules: a foreman cannot take ownership, and anyone below
  // coordinator must own the WR before changing criterion, status or remarks.
  const canTakeOwnership = (CAN_EDIT_WR as readonly string[]).includes(role) && role !== 'foreman';
  const canEdit = isCoord || ((CAN_EDIT_WR as readonly string[]).includes(role) && wr.internal.ownerId === userId);
  const [remarks, setRemarks] = React.useState(wr.internal.fcRemarks ?? '');
  React.useEffect(() => setRemarks(wr.internal.fcRemarks ?? ''), [wr.internal.fcRemarks]);

  const patch = useMutation({
    mutationFn: (b: PatchBody) => apiPatch(OPS.workRequest(wr.wrCode), b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wr', wr.wrCode] });
      void qc.invalidateQueries({ queryKey: ['work-requests'] });
      void qc.invalidateQueries({ queryKey: ['my-work'] });
      toast.success('Saved.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const sug = wr.suggestedStatus && wr.suggestedStatus.status !== wr.internal.contractorStatus ? wr.suggestedStatus : null;
  const owners = (meta?.people ?? []).filter((p) => OWNER_ROLES.includes(p.role));
  const statuses = meta?.contractorStatuses ?? [];
  const criteria = meta?.criteria ?? [1, 2, 3, 4].map((v) => ({ value: v, label: `Criterion ${v}` }));

  return (
    <Card>
      <CardHeader><CardTitle>SONU</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="sonu-owner">Owner</Label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm">{wr.internal.ownerName ?? <span className="text-muted-foreground">Nobody owns this yet</span>}</span>
            {canTakeOwnership && wr.internal.ownerId !== userId && (
              <Button size="sm" onClick={() => patch.mutate({ takeOwnership: true })} disabled={patch.isPending}><UserCheck className="size-4" aria-hidden /> Take ownership</Button>
            )}
          </div>
          {isCoord && (
            <NativeSelect id="sonu-owner" aria-label="Set owner" value={wr.internal.ownerId ?? ''} onChange={(e) => patch.mutate({ ownerId: e.target.value || null })} disabled={patch.isPending}>
              <option value="">No owner</option>
              {owners.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </NativeSelect>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="sonu-criterion">Criterion</Label>
          <NativeSelect id="sonu-criterion" value={wr.internal.criterion ?? ''} disabled={!canEdit || patch.isPending}
            onChange={(e) => patch.mutate({ criterion: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not classified</option>
            {criteria.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </NativeSelect>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="sonu-status">Contractor status</Label>
          {sug && (
            <div className="grid gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-sm" data-testid="status-suggestion">
              <p className="flex items-start gap-2"><Lightbulb className="mt-0.5 size-4 shrink-0 text-info" aria-hidden /><span>Suggested: <strong>{sug.status}</strong> because {sug.reason}</span></p>
              {canEdit && (
                <Button size="sm" onClick={() => patch.mutate({ contractorStatus: sug.status })} disabled={patch.isPending}><Check className="size-4" aria-hidden /> Accept suggestion</Button>
              )}
            </div>
          )}
          <NativeSelect id="sonu-status" value={wr.internal.contractorStatus ?? ''} disabled={!canEdit || patch.isPending}
            onChange={(e) => patch.mutate({ contractorStatus: e.target.value || null })}>
            <option value="">No status</option>
            {statuses.map((s) => <option key={s.name} value={s.name}>{s.name}{sug?.status === s.name ? ' (suggested)' : ''}</option>)}
          </NativeSelect>
          {!canEdit && canTakeOwnership && <p className="text-xs text-muted-foreground">Take ownership to change criterion, status or remarks.</p>}
          {wr.internal.statusSource && <p className="text-xs text-muted-foreground">Set by: {wr.internal.statusSource}</p>}
        </div>

        <ZeroRfeBlock wr={wr} role={role} userId={userId} />

        <div className="grid gap-1.5">
          <Label htmlFor="sonu-remarks">FC remarks</Label>
          <Textarea id="sonu-remarks" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!canEdit} />
          {canEdit && <Button size="sm" variant="outline" className="justify-self-start" disabled={patch.isPending || remarks === (wr.internal.fcRemarks ?? '')} onClick={() => patch.mutate({ fcRemarks: remarks })}>Save remarks</Button>}
        </div>
      </CardContent>
    </Card>
  );
}
