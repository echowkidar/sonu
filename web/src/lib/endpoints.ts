/**
 * Every API path the web app calls, in one place. The server developer may rename any of these;
 * nothing else in the web code hard-codes an /api path.
 */
export const ENDPOINTS = {
  me: '/api/auth/me',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  setup: '/api/setup',
  acceptInvite: '/api/auth/accept-invite',
  forgotPassword: '/api/auth/forgot-password',
  resetPassword: '/api/auth/reset-password',
  pushPublicKey: '/api/push/public-key',
  pushSubscribe: '/api/push/subscribe',
  pushUnsubscribe: '/api/push/unsubscribe',
  health: '/api/health',
} as const;

/** Admin API (paths verified against server/src/**). Functions build paths with ids. */
export const ADMIN = {
  contractors: '/api/admin/contractors',
  contractor: (id: string) => `/api/admin/contractors/${id}`,
  users: '/api/admin/users',
  user: (id: string) => `/api/admin/users/${id}`,
  userDeactivate: (id: string) => `/api/admin/users/${id}/deactivate`,
  userActivate: (id: string) => `/api/admin/users/${id}/activate`,
  userResendInvite: (id: string) => `/api/admin/users/${id}/resend-invite`,
  userWorkTeams: (id: string) => `/api/admin/users/${id}/work-teams`,
  workTeams: '/api/admin/work-teams',
  workTeam: (id: string) => `/api/admin/work-teams/${id}`,
  deadlineRules: '/api/admin/deadline-rules',
  deadlineRule: (id: string) => `/api/admin/deadline-rules/${id}`,
  lookupSites: '/api/admin/lookups/sites',
  lookupProblemTypes: '/api/admin/lookups/problem-types',
  audit: '/api/admin/audit',
  mail: '/api/admin/mail',
  mailTest: '/api/admin/mail/test',
  messaging: '/api/admin/messaging',
  marafiqConnection: '/api/admin/marafiq-connection',
  bulkList: '/api/admin/bulk-import',
  bulkPreview: '/api/admin/bulk-import/preview',
  bulkJob: (id: string) => `/api/admin/bulk-import/${id}`,
  bulkConfirm: (id: string) => `/api/admin/bulk-import/confirm/${id}`,
  bulkCancel: (id: string) => `/api/admin/bulk-import/${id}/cancel`,
  bulkRejected: (id: string) => `/api/admin/bulk-import/${id}/rejected.xlsx`,
  /** The server exposes the plural form. */
  bulkTemplate: (kind: string) => `/api/admin/bulk-import/templates/${kind}`,
} as const;

export const ME = {
  profile: '/api/me/profile',
  password: '/api/auth/password',
} as const;

/** Routes that do not need a session (also used to avoid redirect loops on 401). */
export const PUBLIC_PATHS = ['/login', '/setup', '/accept-invite', '/forgot-password', '/reset-password'] as const;
