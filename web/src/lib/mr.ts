/** Material request (MR) constants and helpers shared by the procurement screens. */
import type { Tone } from '@/components/StatusBadge';
import type { MrDocKind, MrStatus } from './types';

export const MR_STATUS: Record<MrStatus, { label: string; tone: Tone }> = {
  submitted: { label: 'New', tone: 'info' },
  accepted: { label: 'Pending (under procurement)', tone: 'warning' },
  enquiry: { label: 'Vendor enquiry sent', tone: 'info' },
  quoted: { label: 'Quotation received', tone: 'info' },
  ordered: { label: 'Material ordered', tone: 'info' },
  delivered: { label: 'Material delivered', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** The normal path of an MR, in order (rejected and cancelled leave it). */
export const MR_FLOW: readonly MrStatus[] = ['submitted', 'accepted', 'enquiry', 'quoted', 'ordered', 'delivered', 'closed'];

export const MR_STATUS_ORDER: readonly MrStatus[] = [...MR_FLOW, 'rejected', 'cancelled'];

export const DOC_KIND_LABELS: Record<MrDocKind, string> = {
  quote: 'Quote',
  warranty: 'Warranty',
  client_approval: 'Client approval',
  calibration_certificate: 'Calibration certificate',
  other: 'Others',
};
export const DOC_KINDS = Object.keys(DOC_KIND_LABELS) as MrDocKind[];

/** Who may raise an MR (server: ops/material.ts). */
export const RAISE_MR_ROLES = ['supervisor', 'foreman', 'coordinator', 'manager', 'contractor_admin'] as const;
/** Who works an MR in procurement. */
export const PROCUREMENT_ROLES = ['purchasing', 'coordinator', 'manager', 'contractor_admin'] as const;
export const COORD_LEVEL = ['coordinator', 'manager', 'contractor_admin'] as const;

export const canRaiseMr = (role: string) => (RAISE_MR_ROLES as readonly string[]).includes(role);
export const isProcurementRole = (role: string) => (PROCUREMENT_ROLES as readonly string[]).includes(role);

export function mrListUrl(filters: Record<string, string | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/procurement/mr?${s}` : '/procurement/mr';
}

export const qr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `QR ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
