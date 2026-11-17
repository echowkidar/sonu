/**
 * Slots the top bar needs from the API (GET /api/data-as-of, GET /api/notifications).
 * Signatures are unchanged; the data comes from TanStack Query.
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { useSession } from '@/lib/session';
import type { NotificationList } from '@/lib/types';

export const DATA_AS_OF_KEY = ['data-as-of'] as const;
export const UNREAD_KEY = ['notifications', 'unread'] as const;

function useTenantUser(): boolean {
  const { user } = useSession();
  return !!user && user.role !== 'platform_admin';
}

/** ISO time of the last successful Marafiq import (newest list), or null when nothing was imported yet. */
export function useDataAsOf(): string | null {
  const enabled = useTenantUser();
  const q = useQuery({
    queryKey: DATA_AS_OF_KEY,
    queryFn: () => apiGet<{ overall: string | null }>(OPS.dataAsOf, { redirectOn401: false }),
    enabled,
    refetchInterval: 5 * 60_000,
  });
  return q.data?.overall ?? null;
}

/** Number of unread notifications for the signed-in user. */
export function useUnreadCount(): number {
  const enabled = useTenantUser();
  const q = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => apiGet<NotificationList>(OPS.notifications, { query: { unread: 1, limit: 1 }, redirectOn401: false }),
    enabled,
    refetchInterval: 60_000,
  });
  return q.data?.unread ?? 0;
}

export function formatAsOf(iso: string | null, now = new Date()): string {
  if (!iso) return 'no import yet';
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`;
}

/** Older than 24 hours counts as stale (shown in amber). */
export function isStale(iso: string | null, now = new Date()): boolean {
  if (!iso) return false;
  return now.getTime() - new Date(iso).getTime() > 24 * 3600_000;
}
