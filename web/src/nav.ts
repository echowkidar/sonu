/**
 * Single source of truth for navigation, route access and role homes.
 * Add a screen: add one entry here, one lazy route in App.tsx.
 */
import {
  LayoutDashboard, ClipboardList, Wrench, Users, FileUp, Bell, UserCircle, Building2, UserCog, Network,
  FileSpreadsheet, Mail, MessageSquare, PlugZap, SlidersHorizontal, ListChecks, ScrollText, Briefcase,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './lib/roles';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /** Priority on the phone tab bar (lower first). Items without it go under "More". */
  tab?: number;
  group: 'main' | 'admin';
}

const WORK_ROLES: Role[] = ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman', 'technician'];

export const NAV: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, roles: ['contractor_admin', 'manager', 'coordinator'], tab: 1, group: 'main' },
  { id: 'my-work', label: 'My work', to: '/my-work', icon: Briefcase, roles: ['supervisor'], tab: 1, group: 'main' },
  { id: 'my-jobs', label: 'My jobs', to: '/my-jobs', icon: Wrench, roles: ['technician', 'foreman'], tab: 1, group: 'main' },
  { id: 'team-jobs', label: 'Team jobs', to: '/team-jobs', icon: Users, roles: ['foreman', 'supervisor'], tab: 2, group: 'main' },
  { id: 'work-requests', label: 'Work requests', to: '/work-requests', icon: ClipboardList, roles: ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor'], tab: 2, group: 'main' },
  { id: 'imports', label: 'Imports', to: '/imports', icon: FileUp, roles: ['contractor_admin', 'coordinator'], tab: 3, group: 'main' },
  { id: 'notifications', label: 'Notifications', to: '/notifications', icon: Bell, roles: WORK_ROLES, tab: 4, group: 'main' },
  { id: 'profile', label: 'Profile', to: '/profile', icon: UserCircle, roles: ['platform_admin', ...WORK_ROLES], group: 'main' },

  { id: 'a-contractors', label: 'Contractors', to: '/admin/contractors', icon: Building2, roles: ['platform_admin'], tab: 1, group: 'admin' },
  { id: 'a-users', label: 'Users', to: '/admin/users', icon: UserCog, roles: ['platform_admin', 'contractor_admin'], tab: 2, group: 'admin' },
  { id: 'a-teams', label: 'Work teams', to: '/admin/teams', icon: Network, roles: ['contractor_admin'], group: 'admin' },
  { id: 'a-bulk', label: 'Bulk import', to: '/admin/bulk-import', icon: FileSpreadsheet, roles: ['contractor_admin'], group: 'admin' },
  { id: 'a-email', label: 'E-mail', to: '/admin/email', icon: Mail, roles: ['platform_admin', 'contractor_admin'], group: 'admin' },
  { id: 'a-messaging', label: 'Messaging', to: '/admin/messaging', icon: MessageSquare, roles: ['platform_admin', 'contractor_admin'], group: 'admin' },
  { id: 'a-marafiq', label: 'Marafiq connection', to: '/admin/marafiq', icon: PlugZap, roles: ['contractor_admin'], group: 'admin' },
  { id: 'a-rules', label: 'Rules', to: '/admin/rules', icon: SlidersHorizontal, roles: ['contractor_admin'], group: 'admin' },
  { id: 'a-lookups', label: 'Lookups', to: '/admin/lookups', icon: ListChecks, roles: ['contractor_admin'], group: 'admin' },
  { id: 'a-audit', label: 'Audit log', to: '/admin/audit', icon: ScrollText, roles: ['platform_admin', 'contractor_admin'], group: 'admin' },
];

/** Routes that are not menu items but still need a role rule (detail pages). */
const EXTRA_ACCESS: { prefix: string; roles: readonly Role[] }[] = [
  { prefix: '/work-requests/', roles: ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor'] },
  { prefix: '/my-jobs/', roles: ['technician', 'foreman', 'supervisor'] },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}

/** Phone bottom bar: first four by priority; the rest are reachable under "More". */
export function tabsForRole(role: Role, max = 4): { tabs: NavItem[]; more: NavItem[] } {
  const items = navForRole(role);
  const ranked = items.filter((i) => i.tab !== undefined).sort((a, b) => (a.tab! - b.tab!));
  const tabs = ranked.slice(0, max);
  const more = items.filter((i) => !tabs.includes(i));
  return { tabs, more };
}

export function homeForRole(role: Role): string {
  switch (role) {
    case 'platform_admin': return '/admin/contractors';
    case 'technician': return '/my-jobs';
    case 'foreman': return '/team-jobs';
    case 'supervisor': return '/my-work';
    case 'purchasing': return '/work-requests';
    default: return '/dashboard';
  }
}

export function canAccess(role: Role, pathname: string): boolean {
  const exact = NAV.find((n) => n.to === pathname);
  if (exact) return exact.roles.includes(role);
  const extra = EXTRA_ACCESS.find((e) => pathname.startsWith(e.prefix));
  return extra ? extra.roles.includes(role) : false;
}
