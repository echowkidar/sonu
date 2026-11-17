import { createHmac } from 'node:crypto';
import type { PaceOptions } from './pace.js';

export const VERSION = '0.1.0';
export const USER_AGENT_SUFFIX = `SONU-connector/${VERSION} (read-only)`;

export interface WorkerConfig {
  appUrl: string;
  token: string;
  pollSeconds: number;
  headless: boolean;
  /** Only for the local mock portal: allow http:// to localhost / 127.0.0.1 / a compose service name. */
  allowInsecurePortal: boolean;
  pace: PaceOptions;
  maxDownloadBytes: number;
  navTimeoutMs: number;
  stepTimeoutMs: number;
}

/** token = hex(HMAC-SHA256(key = ENCRYPTION_KEY bytes (base64-decoded), "sonu-worker-v1")) — ARCHITECTURE.md. */
export function workerToken(encryptionKeyB64: string): string {
  const key = Buffer.from(encryptionKeyB64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return createHmac('sha256', key).update('sonu-worker-v1').digest('hex');
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const appUrl = env.APP_URL;
  if (!appUrl) throw new Error('APP_URL is required');
  const key = env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is required');
  return {
    appUrl: appUrl.replace(/\/+$/, ''),
    token: workerToken(key),
    pollSeconds: Math.max(1, num(env.POLL_SECONDS, 15)),
    headless: env.HEADLESS !== '0' && env.HEADLESS !== 'false',
    allowInsecurePortal: env.ALLOW_INSECURE_PORTAL === '1',
    pace: {
      minMs: num(env.PACE_MIN_MS, 1500),
      maxMs: num(env.PACE_MAX_MS, 4000),
      maxBackoffMs: num(env.PACE_MAX_BACKOFF_MS, 60_000),
    },
    maxDownloadBytes: num(env.MAX_DOWNLOAD_BYTES, 50 * 1024 * 1024),
    navTimeoutMs: num(env.NAV_TIMEOUT_MS, 45_000),
    stepTimeoutMs: num(env.STEP_TIMEOUT_MS, 60_000),
  };
}

/**
 * The portal address must be https. Plain http is accepted only with ALLOW_INSECURE_PORTAL=1 AND a
 * host that is localhost, 127.0.0.1 or a single-label compose service name (e.g. "mock-portal").
 * Returns an error message, or null when acceptable.
 */
export function checkPortalAddress(baseUrl: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return 'portal address is not a valid URL';
  }
  if (u.username || u.password) return 'portal address must not contain credentials';
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return 'portal address must be https';
  const host = u.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(host);
  if (allowInsecure && local) return null;
  return 'portal address must be https (http only for the local mock with ALLOW_INSECURE_PORTAL=1)';
}
