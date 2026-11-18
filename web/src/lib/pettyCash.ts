/** Petty cash claim constants and helpers shared by the claim screens (server: ops/pettyCash.ts). */
import type { Tone } from '@/components/StatusBadge';
import type { PettyCashDetail, PettyCashLine, PettyCashStatus } from './types';

export const PC_STATUS: Record<PettyCashStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Waiting for Admin review', tone: 'warning' },
  returned: { label: 'Returned to preparer', tone: 'warning' },
  reviewed: { label: 'Waiting for Project Manager', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};
export const PC_STATUS_ORDER: readonly PettyCashStatus[] = ['draft', 'submitted', 'returned', 'reviewed', 'approved', 'rejected'];

/** Who prepares a claim (server: supervisor, coordinator, manager). */
export const PREPARE_PETTY_CASH_ROLES = ['supervisor', 'coordinator', 'manager'] as const;
/** Who may open claims. */
export const PETTY_CASH_ROLES = ['supervisor', 'coordinator', 'manager', 'contractor_admin', 'purchasing'] as const;
export const canPrepareClaim = (role: string) => (PREPARE_PETTY_CASH_ROLES as readonly string[]).includes(role);
export const canViewClaims = (role: string) => (PETTY_CASH_ROLES as readonly string[]).includes(role);

export function claimListUrl(filters: Record<string, string | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/petty-cash?${s}` : '/petty-cash';
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Line total = qty x unit cost - discount, 2 decimals (the server computes the same). */
export function lineTotal(qty: number, unitCost: number, discount: number): number {
  return round2(qty * unitCost - discount);
}
export const claimTotal = (lines: { totalAmount: number }[]): number => round2(lines.reduce((t, l) => t + l.totalAmount, 0));

/** Body of the approve action: only the lines the manager changed, and a total only when it differs from the sum of the lines. */
export function approvePayload(lines: Pick<PettyCashLine, 'id' | 'totalAmount'>[], amounts: Record<string, string>, totalOverride: string | null) {
  const approvedAmounts: Record<string, number> = {};
  let sum = 0;
  for (const l of lines) {
    const raw = amounts[l.id];
    const v = raw === undefined || raw.trim() === '' ? l.totalAmount : Number(raw);
    sum += v;
    if (v !== l.totalAmount) approvedAmounts[l.id] = v;
  }
  sum = round2(sum);
  const body: { action: 'approve'; approvedAmounts?: Record<string, number>; approvedTotal?: number } = { action: 'approve' };
  if (Object.keys(approvedAmounts).length) body.approvedAmounts = approvedAmounts;
  if (totalOverride !== null && totalOverride.trim() !== '' && Number(totalOverride) !== sum) body.approvedTotal = Number(totalOverride);
  return { body, sum };
}

export type ClaimAction = 'submit' | 'review' | 'return' | 'approve' | 'reject';
/** Which workflow buttons to show, from the server's `can` flags. */
export function claimActions(can: PettyCashDetail['can']): ClaimAction[] {
  const out: ClaimAction[] = [];
  if (can.submit) out.push('submit');
  if (can.review) out.push('review');
  if (can.return) out.push('return');
  if (can.approve) out.push('approve');
  if (can.reject) out.push('reject');
  return out;
}

export const monthLabel = (m: string) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? m : d.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
export const qar = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `QR ${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
