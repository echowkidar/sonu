import fp from 'fastify-plugin';
import proxyAddr from 'proxy-addr';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errorBody } from '../errors.js';
import { SESSION_COOKIE, loadSession } from './session.js';

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'sonu';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type TrustFn = (addr: string, i: number) => boolean;

export function trustFn(tp: boolean | string): TrustFn {
  if (tp === true) return () => true;
  if (!tp) return () => false;
  return proxyAddr.compile(tp.split(',').map((s) => s.trim()).filter(Boolean));
}

/** CF-Connecting-IP only when the direct peer is a trusted proxy (TRUST_PROXY); else Fastify's request.ip. */
function clientIpOf(request: FastifyRequest, trusted: TrustFn): string {
  const peer = request.raw.socket?.remoteAddress;
  if (peer && trusted(peer, 0)) {
    const cf = request.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
  }
  return request.ip;
}

/**
 * - request.clientIp (CF-Connecting-IP when TRUST_PROXY is on)
 * - CSRF: every mutating /api request must carry  X-Requested-With: sonu
 * - request.auth from the session cookie (null when signed out)
 */
async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('auth', null);
  app.decorateRequest('clientIp', '');
  const trusted = trustFn(app.config.trustProxy);

  app.addHook('onRequest', async (request, reply) => {
    request.clientIp = clientIpOf(request, trusted);
    const isApi = request.url.startsWith('/api/');
    if (!isApi) return;

    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      return reply.status(403).send(errorBody('csrf', `Missing header ${'X-Requested-With'}: ${CSRF_VALUE}.`));
    }

    const token = request.cookies?.[SESSION_COOKIE];
    if (token) {
      const found = await loadSession(app.db, token);
      if (found) request.auth = { user: found.user, sessionId: found.sessionId };
    }
  });
}

export default fp(authPlugin, { name: 'sonu-auth', dependencies: ['@fastify/cookie'] });
