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

/** Routes that do not need a session (also used to avoid redirect loops on 401). */
export const PUBLIC_PATHS = ['/login', '/setup', '/accept-invite', '/forgot-password', '/reset-password'] as const;
