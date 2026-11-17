import * as React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Bell, Database, Ellipsis } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';
import { navForRole, tabsForRole, type NavItem } from '@/nav';
import { OfflineBanner } from './OfflineBanner';
import { InstallPrompt } from './InstallPrompt';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import { useThemeContext } from './ThemeContext';
import { formatAsOf, useDataAsOf, useUnreadCount } from './slots';

function SideLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn('flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors', isActive ? 'bg-primary-soft text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')
      }
    >
      <item.icon className="size-5 shrink-0" aria-hidden />
      {item.label}
    </NavLink>
  );
}

function Sidebar({ items }: { items: NavItem[] }) {
  const main = items.filter((i) => i.group === 'main');
  const admin = items.filter((i) => i.group === 'admin');
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-1 overflow-y-auto border-e bg-card p-3 md:flex" aria-label="Main navigation">
      <Link to="/" className="mb-3 px-2 py-2"><Logo /></Link>
      <nav className="grid gap-1">{main.map((i) => <SideLink key={i.id} item={i} />)}</nav>
      {admin.length > 0 && (
        <>
          <p className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin</p>
          <nav className="grid gap-1">{admin.map((i) => <SideLink key={i.id} item={i} />)}</nav>
        </>
      )}
    </aside>
  );
}

function BottomTabs({ tabs, more }: { tabs: NavItem[]; more: NavItem[] }) {
  const [open, setOpen] = React.useState(false);
  const loc = useLocation();
  React.useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <>
      <nav aria-label="Main navigation" className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex border-t bg-card md:hidden">
        {tabs.map((t) => (
          <NavLink
            key={t.id}
            to={t.to}
            className={({ isActive }) => cn('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted-foreground')}
          >
            <t.icon className="size-6" aria-hidden />
            <span className="max-w-full truncate">{t.label}</span>
          </NavLink>
        ))}
        {more.length > 0 && (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-muted-foreground">
            <Ellipsis className="size-6" aria-hidden />
            More
          </button>
        )}
      </nav>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom">
          <SheetTitle className="text-lg font-semibold">More</SheetTitle>
          <div className="grid gap-1 overflow-y-auto">{more.map((i) => <SideLink key={i.id} item={i} />)}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AppShell() {
  const { user, isLoading } = useSession();
  const { toggle } = useThemeContext();
  const asOf = useDataAsOf();
  const unread = useUnreadCount();
  const loc = useLocation();

  if (isLoading || !user) {
    return <div className="grid min-h-dvh place-items-center p-6"><Skeleton className="h-10 w-48" /></div>;
  }
  const items = navForRole(user.role);
  const { tabs, more } = tabsForRole(user.role);

  return (
    <div className="flex min-h-dvh">
      <Sidebar items={items} />
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <InstallPrompt />
        <header className="safe-top sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur md:px-5">
          <Link to="/" className="md:hidden"><Logo mark /></Link>
          <p data-testid="data-as-of" className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground sm:text-sm">
            <Database className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Marafiq data as of {formatAsOf(asOf)}</span>
          </p>
          <Button asChild variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
            <Link to="/notifications">
              <Bell className="size-5" aria-hidden />
              {unread > 0 && <Badge variant="danger" className="absolute -end-0.5 -top-0.5 min-w-5 justify-center px-1.5">{unread > 99 ? '99+' : unread}</Badge>}
            </Link>
          </Button>
          <ThemeToggle onToggle={toggle} />
          <UserMenu user={user} />
        </header>
        <main className="min-w-0 flex-1 p-4 pb-24 md:p-6 md:pb-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <BottomTabs tabs={tabs} more={more} />
    </div>
  );
}
