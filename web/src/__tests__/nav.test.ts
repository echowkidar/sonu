import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/roles';
import { canAccess, homeForRole, navForRole, tabsForRole } from '@/nav';

describe('nav config', () => {
  it('every role has a home that it may open', () => {
    for (const r of ROLES) expect(canAccess(r, homeForRole(r)), r).toBe(true);
  });

  it('technician sees jobs, not admin or dashboards', () => {
    const ids = navForRole('technician').map((n) => n.to);
    expect(ids).toContain('/my-jobs');
    expect(ids.some((p) => p.startsWith('/admin'))).toBe(false);
    expect(ids).not.toContain('/dashboard');
    expect(canAccess('technician', '/my-jobs/42')).toBe(true);
    expect(canAccess('technician', '/work-requests/WR-1')).toBe(false);
  });

  it('platform admin sees only platform screens (no work data)', () => {
    const ids = navForRole('platform_admin').map((n) => n.to);
    expect(ids).toContain('/admin/contractors');
    expect(ids).not.toContain('/work-requests');
    expect(canAccess('platform_admin', '/work-requests')).toBe(false);
  });

  it('contractor admin gets the admin pages except contractors', () => {
    const ids = navForRole('contractor_admin').map((n) => n.to);
    for (const p of ['/admin/users', '/admin/teams', '/admin/bulk-import', '/admin/email', '/admin/messaging', '/admin/marafiq', '/admin/rules', '/admin/lookups', '/admin/audit']) expect(ids).toContain(p);
    expect(ids).not.toContain('/admin/contractors');
  });

  it('supervisor home is My work and only coordinator-level roles import', () => {
    expect(homeForRole('supervisor')).toBe('/my-work');
    expect(canAccess('coordinator', '/imports')).toBe(true);
    expect(canAccess('supervisor', '/imports')).toBe(false);
  });

  it('phone tab bar shows at most 4 tabs and the rest sit under More', () => {
    for (const r of ROLES) {
      const { tabs, more } = tabsForRole(r);
      expect(tabs.length).toBeLessThanOrEqual(4);
      expect(tabs.length + more.length).toBe(navForRole(r).length);
    }
  });

  it('every role can open its profile except none are locked out', () => {
    for (const r of ROLES) expect(canAccess(r, '/profile')).toBe(true);
  });
});
