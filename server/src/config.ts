import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Folder that holds server/package.json (works from src/ under tsx and from dist/ after build). */
export function serverRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const name = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name;
        if (name === '@sonu/server') return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** false, true (trust every peer) or a proxy-addr list such as 'loopback,linklocal,uniquelocal' or '10.0.0.0/8'. */
export type TrustProxy = boolean | string;

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  /** Raw base64 string; validated by secrets.ts (32 bytes). */
  encryptionKey: string;
  publicUrl: string;
  trustProxy: TrustProxy;
  uploadDir: string;
  webDist: string;
  assetsDir: string;
  migrationsDir: string;
  logLevel: string;
  sessionDays: number;
  inviteDays: number;
  resetHours: number;
  maxUploadBytes: number;
}

function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'no') return false;
  if (v === 'true' || v === 'yes') return true;
  // "1" (compose default): trust the proxy directly in front of us when it is on a private network —
  // cloudflared on the host (Docker gateway) or in a container. Fastify refuses bare hop counts.
  if (/^\d+$/.test(v)) return 'loopback,linklocal,uniquelocal';
  return raw!.trim(); // comma-separated list of trusted addresses / CIDRs
}

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres://user:pass@host:5432/db)'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required: 32 random bytes, base64 (openssl rand -base64 32)'),
  PUBLIC_URL: z.string().url().optional(),
  TRUST_PROXY: z.string().optional(),
  UPLOAD_DIR: z.string().optional(),
  WEB_DIST: z.string().optional(),
  ASSETS_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(200).default(25),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const root = serverRoot();
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    encryptionKey: e.ENCRYPTION_KEY,
    publicUrl: (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    uploadDir: e.UPLOAD_DIR ?? (e.NODE_ENV === 'production' ? '/data/uploads' : path.join(root, '.data', 'uploads')),
    webDist: e.WEB_DIST ?? path.resolve(root, '..', 'web', 'dist'),
    assetsDir: e.ASSETS_DIR ?? path.resolve(root, '..', 'assets'),
    migrationsDir: path.join(root, 'migrations'),
    logLevel: e.LOG_LEVEL,
    sessionDays: e.SESSION_DAYS,
    inviteDays: 7,
    resetHours: 2,
    maxUploadBytes: Math.round(e.MAX_UPLOAD_MB * 1024 * 1024),
  };
}
