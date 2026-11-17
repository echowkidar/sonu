import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/EmptyState';
import { QueryBoundary } from '@/components/admin/kit';
import { apiGet, apiPost } from '@/lib/api';
import { OPS } from '@/lib/endpoints';
import { errorMessage, formatDateTime } from '@/lib/forms';
import { internalPath } from '@/lib/ops';
import { cn } from '@/lib/utils';
import type { NotificationItem, NotificationList } from '@/lib/types';

const KEY = ['notifications', 'list'] as const;

export default function NotificationsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: KEY, queryFn: () => apiGet<NotificationList>(OPS.notifications, { query: { limit: 100 } }) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); };

  const readAll = useMutation({
    mutationFn: () => apiPost(OPS.notificationsReadAll),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const readOne = useMutation({ mutationFn: (id: string) => apiPost(OPS.notificationRead(id)), onSuccess: refresh });

  function open(n: NotificationItem) {
    if (!n.readAt) readOne.mutate(n.id);
    const to = internalPath(n.link ?? n.url);
    if (to) nav(to);
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description={q.data ? `${q.data.unread} unread` : undefined}
        actions={<Button variant="outline" disabled={!q.data?.unread || readAll.isPending} onClick={() => readAll.mutate()}><CheckCheck className="size-4" aria-hidden /> Mark all as read</Button>}
      />
      <QueryBoundary
        query={q}
        isEmpty={(d) => d.items.length === 0}
        empty={<EmptyState illustration="done" title="You are all caught up" description="New assignments, returns and deadlines will show up here." />}
      >
        {(d) => (
          <ul className="grid gap-2" aria-label="Notifications">
            {d.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => open(n)}
                  className={cn('flex min-h-14 w-full items-start gap-3 rounded-xl border bg-card p-3 text-start hover:bg-muted/50', !n.readAt && 'border-primary/40 bg-primary-soft/40')}
                >
                  <Bell className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={cn('truncate', !n.readAt && 'font-semibold')}>{n.title}</span>
                      {!n.readAt && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">New</span>}
                    </span>
                    {n.body && <span className="block truncate text-sm text-muted-foreground">{n.body}</span>}
                    <span className="block text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </>
  );
}
