import type { Config } from './config.js';
import type { Pool } from './db.js';
import type { TransportFactory } from './mail/types.js';
import type { Role } from './auth/roles.js';
import type { LoginRateLimiter } from './auth/rateLimit.js';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  /** null only for platform_admin. */
  contractorId: string | null;
  status: 'invited' | 'active' | 'inactive';
  language: string;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    config: Config;
    /** Overrides how nodemailer transports are created (tests use jsonTransport). */
    mailTransportFactory: TransportFactory | undefined;
    loginLimiter: LoginRateLimiter;
    /** Current first-run setup code, or null when setup is done. */
    setupState: { code: string | null };
  }
  interface FastifyRequest {
    /** Set by the auth plugin when a valid session cookie is present. */
    auth: AuthContext | null;
    /** Client address (CF-Connecting-IP when TRUST_PROXY is on, else request.ip). */
    clientIp: string;
  }
}
