/**
 * Slots the top bar needs from the API. They are stubs until the endpoints exist:
 * replace the bodies with TanStack Query hooks, keep the signatures.
 */

/** ISO time of the last successful Marafiq import (oldest list), or null when nothing was imported yet. */
export function useDataAsOf(): string | null {
  return null;
}

/** Number of unread notifications for the signed-in user. */
export function useUnreadCount(): number {
  return 0;
}

export function formatAsOf(iso: string | null, now = new Date()): string {
  if (!iso) return 'no import yet';
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`;
}
