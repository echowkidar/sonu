/** Small helpers shared by the operational screens. */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { OPS } from './endpoints';
import type { Job, JobStatus, Meta } from './types';
import type { Tone } from '@/components/StatusBadge';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => apiGet<Meta>(OPS.meta), staleTime: 5 * 60_000 });
}

/** URL of the work-request list with filters (empty values are left out). */
export function wrListUrl(filters: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `/work-requests?${s}` : '/work-requests';
}

/** The matrix uses "(No status)" for rows without a contractor status; the API filter calls it "(none)". */
export const NO_STATUS_LABEL = '(No status)';
export const statusFilterValue = (row: string) => (row === NO_STATUS_LABEL ? '(none)' : row);

export const tdTone = (td: string): Tone => (td === 'Breached' ? 'danger' : td === 'TD Valid' ? 'success' : 'neutral');
export const kpiTone = (k: string): Tone => (k === 'Backlog KPI' ? 'danger' : k === 'Present KPI' ? 'success' : 'neutral');
export function rfeTone(kind: string): Tone {
  switch (kind) {
    case 'breach': return 'danger';
    case 'valid': return 'warning';
    case 'approved': case 'submitted': return 'success';
    default: return 'neutral';
  }
}
export const RFE_KIND_LABELS: Record<string, string> = {
  valid: 'RFE within time', breach: 'RFE time breached', submitted: 'RFE submitted', notRequired: 'RFE not required', approved: 'RFE approved', unknown: 'RFE unknown',
};

export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  assigned: { label: 'Assigned', tone: 'info' },
  started: { label: 'In progress', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
};

export function jobLocation(j: Job): string {
  const w = j.wr;
  return [w.buildingName ?? w.buildingCode, w.floorCode && `Floor ${w.floorCode}`, w.roomCode && `Room ${w.roomCode}`].filter(Boolean).join(' · ');
}

export function jobPermit(j: Job): string | undefined {
  if (!j.wr.ptwCode) return undefined;
  return `${j.wr.ptwStatus ?? 'unknown'}${j.wr.permitDateUpto ? ` until ${j.wr.permitDateUpto}` : ''}`;
}

/** Notification links written by the server use /wr/<code>; the web app uses /work-requests/<code>. */
export function internalPath(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/')) return null;
  const m = /^\/wr\/([^/?#]+)/.exec(link);
  return m ? `/work-requests/${m[1]}` : link;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const CAN_EDIT_WR = ['supervisor', 'foreman', 'coordinator', 'manager', 'contractor_admin'] as const;
export const COORD_ROLES = ['coordinator', 'manager', 'contractor_admin'] as const;
/** Who may convert a WR to 0 RFE: coordinator level, or the supervisor who owns it (server rule). */
export function canConvertZeroRfe(role: string, ownerId: string | null, userId: string): boolean {
  if ((COORD_ROLES as readonly string[]).includes(role)) return true;
  return role === 'supervisor' && ownerId === userId;
}
export const PURCHASE_ROLES = ['supervisor', 'foreman', 'purchasing', 'coordinator', 'manager', 'contractor_admin'] as const;

export const OWNER_ROLES = ['supervisor', 'foreman', 'coordinator', 'manager', 'contractor_admin'];
