import * as React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ShieldAlert } from 'lucide-react';
import { useSession } from '@/lib/session';
import type { Role } from '@/lib/roles';
import { canAccess, homeForRole } from '@/nav';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router';

/**
 * Route guard. Without `roles` it requires a session and checks the path against nav.ts (`canAccess`).
 * With `roles` it requires one of them. Not signed in -> /login?next=...
 * Wrap children or use as a layout route (renders <Outlet/>).
 */
export function RequireRole({ roles, children }: { roles?: readonly Role[]; children?: React.ReactNode }) {
  const { user, isLoading } = useSession();
  const loc = useLocation();
  if (isLoading) return <div className="p-6"><Skeleton className="h-8 w-40" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  const allowed = roles ? roles.includes(user.role) : canAccess(user.role, loc.pathname);
  if (!allowed) {
    return (
      <EmptyState
        title="You do not have access to this page"
        description="Your role cannot open it. If you think this is a mistake, ask your contractor admin."
        action={<Button asChild><Link to={homeForRole(user.role)}>Go to my home</Link></Button>}
        illustration="search"
      />
    );
  }
  return <>{children ?? <Outlet />}</>;
}

export { ShieldAlert };
