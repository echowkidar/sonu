export const ROLES = [
  'platform_admin',
  'contractor_admin',
  'manager',
  'coordinator',
  'purchasing',
  'supervisor',
  'foreman',
  'technician',
] as const;

export type Role = (typeof ROLES)[number];
export type ContractorRole = Exclude<Role, 'platform_admin'>;

export const CONTRACTOR_ROLES: readonly ContractorRole[] = ROLES.filter((r): r is ContractorRole => r !== 'platform_admin');

/** Roles that see everything of their contractor (not limited by work team). */
export const ALL_TEAMS_ROLES: readonly Role[] = ['contractor_admin', 'manager', 'coordinator', 'purchasing'];

/** Roles limited to their work teams (zones). */
export const TEAM_SCOPED_ROLES: readonly Role[] = ['supervisor', 'foreman', 'technician'];

/** Captions used in the Excel templates / UI → role keys. */
export const ROLE_LABELS: Record<ContractorRole, string> = {
  contractor_admin: 'Contractor Admin',
  manager: 'Manager',
  coordinator: 'Coordinator',
  purchasing: 'Purchasing',
  supervisor: 'Supervisor',
  foreman: 'Foreman',
  technician: 'Technician',
};

export function roleFromLabel(label: string): ContractorRole | undefined {
  const norm = label.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  for (const [key, l] of Object.entries(ROLE_LABELS) as [ContractorRole, string][]) {
    if (l.toLowerCase() === norm || key.replace(/_/g, ' ') === norm) return key;
  }
  return undefined;
}

export function isContractorRole(r: string): r is ContractorRole {
  return (CONTRACTOR_ROLES as readonly string[]).includes(r);
}
