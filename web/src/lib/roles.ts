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

export const ROLE_LABELS: Record<Role, string> = {
  platform_admin: 'Platform admin',
  contractor_admin: 'Contractor admin',
  manager: 'Manager',
  coordinator: 'Coordinator',
  purchasing: 'Purchasing',
  supervisor: 'Supervisor',
  foreman: 'Foreman',
  technician: 'Technician',
};

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
