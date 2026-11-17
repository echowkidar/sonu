import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import { createPool, type Pool } from './db.js';
import { errorBody, registerErrorHandling } from './errors.js';
import { initSecrets } from './secrets.js';
import { LoginRateLimiter, type RateLimitOptions } from './auth/rateLimit.js';
import authPlugin from './auth/plugin.js';
import authRoutes from './auth/routes.js';
import contractorRoutes from './contractors/routes.js';
import userRoutes from './users/routes.js';
import teamRoutes from './admin/teams.js';
import ruleRoutes from './admin/rules.js';
import settingsRoutes from './admin/settings.js';
import bulkRoutes from './bulk/routes.js';
import { notificationRoutes } from './notifications/index.js';
import commPlugin from './comm/index.js';
import connectionPlugin from './connection/index.js';
import type { TransportFactory } from './mail/types.js';
import './types.js';

export interface BuildOptions {
  config: Config;
  /** Use an existing pool (tests); otherwise one is created from config.databaseUrl. */
  pool?: Pool;
  mailTransportFactory?: TransportFactory;
  logger?: FastifyServerOptions['logger'];
  rateLimit?: RateLimitOptions;
}

/** Log redaction: cookies, auth headers and anything password / token / secret shaped. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.secret',
  '*.clientSecret',
  '*.oauthClientSecret',
  '*.refreshToken',
  '*.oauthRefreshToken',
  '*.encryptionKey',
  '*.databaseUrl',
];

export function defaultLogger(level: string): FastifyServerOptions['logger'] {
  return {
    level,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req(req) {
        // Never log query strings (a token could be in one).
        const url = (req.url ?? '').split('?')[0];
        return { method: req.method, url, remoteAddress: req.ip };
      },
    },
  };
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  initSecrets(config.encryptionKey); // throws a clear error when ENCRYPTION_KEY is missing / wrong length

  const fastifyOptions: FastifyServerOptions = {
    logger: opts.logger ?? defaultLogger(config.logLevel),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  };
  const app: FastifyInstance = Fastify(fastifyOptions);

  const pool = opts.pool ?? createPool(config.databaseUrl);
  app.decorate('db', pool);
  app.decorate('config', config);
  app.decorate('mailTransportFactory', opts.mailTransportFactory);
  app.decorate('loginLimiter', new LoginRateLimiter(opts.rateLimit));
  app.decorate('setupState', { code: null as string | null });
  if (!opts.pool) app.addHook('onClose', async () => pool.end());

  registerErrorHandling(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  // Proxies such as Cloudflare Tunnel forward a body-less POST without Content-Length (chunked),
  // which Fastify would reject as an unknown media type. Accept an empty body of any/no type;
  // keep rejecting real bodies of unsupported types.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    if ((body as Buffer).length === 0) return done(null, undefined);
    const err = new Error('Unsupported Media Type') as Error & { statusCode: number; code: string };
    err.statusCode = 415;
    err.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    done(err, undefined);
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });
  await app.register(authPlugin);

  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'error', db: 'unreachable', time: new Date().toISOString() });
    }
  });

  await app.register(authRoutes);
  await app.register(contractorRoutes);
  await app.register(userRoutes);
  await app.register(teamRoutes);
  await app.register(ruleRoutes);
  await app.register(settingsRoutes);
  await app.register(bulkRoutes);
  await app.register(notificationRoutes);
  await app.register(commPlugin);
  await app.register(connectionPlugin);
  const ops = await import('./ops/index.js');
  await app.register(ops.default);
  // The worker's file hand-over (server/src/connection) uses the same import path as manual upload.
  if (!app.hasDecorator('importRunner')) app.decorate('importRunner', ops.runImport);

  // ───── Web app (built by web/, served from ../web/dist). Starts fine when it does not exist yet. ─────
  const indexHtml = path.join(config.webDist, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      index: false,
      setHeaders(res, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
    // Static files by path; anything else falls through to the SPA handler below.
    app.get('/*', async (request, reply) => {
      const rel = decodeURIComponent((request.params as { '*': string })['*'] ?? '');
      const full = path.join(config.webDist, rel);
      if (rel && full.startsWith(config.webDist) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        return reply.sendFile(rel);
      }
      return reply.callNotFound();
    });
  } else {
    app.log.info({ webDist: config.webDist }, 'web app not built yet (no index.html) — serving the API only');
  }

  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    const isApi = url.startsWith('/api/') || url === '/api' || url.startsWith('/internal/');
    if (!isApi && hasWeb && (request.method === 'GET' || request.method === 'HEAD') && !path.extname(url)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('not_found', `No route ${request.method} ${url}.`));
  });

  return app;
}
