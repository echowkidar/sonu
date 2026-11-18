/**
 * Single source of truth for navigation, route access and role homes.
 * Add a screen: add one entry here, one lazy route in App.tsx.
 */
import {
  LayoutDashboard, ClipboardList, Wrench, Users, FileUp, Bell, UserCircle, Building2, UserCog, Network,
  FileSpreadsheet, Receipt, Wallet, ShoppingCart, PackageSearch, Mail, MessageSquare, PlugZap, SlidersHorizontal, ListChecks, ScrollText, Briefcase,
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
  /** Tab priority for single roles that differ from `tab` (Procurement is a phone tab for purchasing only). */
  tabFor?: Partial<Record<Role, number>>;
  group: 'main' | 'admin';
}

const WORK_ROLES: Role[] = ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman', 'technician'];

export const NAV: readonly NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, roles: ['contractor_admin', 'manager', 'coordinator'], tab: 1, group: 'main' },
  { id: 'my-work', label: 'My work', to: '/my-work', icon: Briefcase, roles: ['supervisor'], tab: 1, group: 'main' },
  { id: 'my-jobs', label: 'My jobs', to: '/my-jobs', icon: Wrench, roles: ['technician', 'foreman'], tab: 1, group: 'main' },
  { id: 'team-jobs', label: 'Team jobs', to: '/team-jobs', icon: Users, roles: ['foreman', 'supervisor'], tab: 2, group: 'main' },
  // Foreman can own work requests (server OWNER_ROLES), so he needs the list and detail too.
  { id: 'procurement', label: 'Procurement', to: '/procurement', icon: ShoppingCart, roles: ['purchasing', 'coordinator', 'manager', 'contractor_admin'], tabFor: { purchasing: 1 }, group: 'main' },
  // Field staff see their own requests and those of their zone; the list opens with the "Mine" filter.
  { id: 'my-mrs', label: 'My MRs', to: '/procurement/mr?mine=1', icon: PackageSearch, roles: ['supervisor', 'foreman'], group: 'main' },
  { id: 'work-requests', label: 'Work requests', to: '/work-requests', icon: ClipboardList, roles: ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman'], tab: 3, group: 'main' },
  { id: 'imports', label: 'Imports', to: '/imports', icon: FileUp, roles: ['contractor_admin', 'coordinator', 'manager'], tab: 3, group: 'main' },
  // Low priority (no tab): it sits under "More" on the phone so the tab bar keeps its four main places.
  { id: 'zero-rfe', label: '0 RFE report', to: '/zero-rfe', icon: Receipt, roles: ['supervisor', 'foreman', 'purchasing', 'coordinator', 'manager', 'contractor_admin'], group: 'main' },
  // No tab: under "More" on the phone. Supervisor, coordinator and manager prepare claims, the admin reviews, the manager approves, purchasing views.
  { id: 'petty-cash', label: 'Petty cash', to: '/petty-cash', icon: Wallet, roles: ['supervisor', 'coordinator', 'manager', 'contractor_admin', 'purchasing'], group: 'main' },
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
  // Procurement list, request form and request pages; the server decides which requests each person sees.
  { prefix: '/procurement/mr', roles: ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman'] },
  // Petty cash claim form and claim pages; the server decides which claims each person sees.
  { prefix: '/petty-cash/', roles: ['supervisor', 'coordinator', 'manager', 'contractor_admin', 'purchasing'] },
  { prefix: '/work-requests/', roles: ['contractor_admin', 'manager', 'coordinator', 'purchasing', 'supervisor', 'foreman'] },
  // Same roles the server lets view a job (ops/jobs.ts jobAccess); the server still checks each job.
  { prefix: '/my-jobs/', roles: ['technician', 'foreman', 'supervisor', 'coordinator', 'manager', 'contractor_admin'] },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((n) => n.roles.includes(role));
}

/** Phone bottom bar: first four by priority; the rest are reachable under "More". */
export function tabsForRole(role: Role, max = 4): { tabs: NavItem[]; more: NavItem[] } {
  const items = navForRole(role);
  const prio = (i: NavItem) => i.tabFor?.[role] ?? i.tab;
  const ranked = items.filter((i) => prio(i) !== undefined).sort((a, b) => (prio(a)! - prio(b)!));
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
    case 'purchasing': return '/procurement';
    default: return '/dashboard';
  }
}

export function canAccess(role: Role, pathname: string): boolean {
  // "/" only redirects to the role's home page, so every signed-in role may open it.
  if (pathname === '/') return true;
  const exact = NAV.find((n) => n.to === pathname);
  if (exact) return exact.roles.includes(role);
  const extra = EXTRA_ACCESS.find((e) => pathname.startsWith(e.prefix));
  return extra ? extra.roles.includes(role) : false;
}
