/**
 * Encrypted secrets (Marafiq password, mail password / OAuth tokens, VAPID private key).
 *
 * AES-256-GCM with ENCRYPTION_KEY (32 bytes, base64) from the environment — never stored in the
 * database. Rows live in table `secret`; other tables only keep `secret_id`.
 *
 * readSecret() is SERVER-INTERNAL: its result must never be put in an API response, a log line,
 * an audit row or an export. Routes report only `hasPassword: true/false` via hasSecret().
 */
import crypto from 'node:crypto';
import type { Queryable } from './db.js';

export const KEY_VERSION = 1;

export class EncryptionKeyError extends Error {}

/** Parses and validates ENCRYPTION_KEY; throws a clear error at startup when missing or wrong. */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || !raw.trim()) {
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY is missing. Generate one with:  openssl rand -base64 32  and set it in the environment.',
    );
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new EncryptionKeyError('ENCRYPTION_KEY must be base64 (openssl rand -base64 32).');
  }
  const key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) {
    throw new EncryptionKeyError(
      `ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with:  openssl rand -base64 32`,
    );
  }
  return key;
}

let activeKey: Buffer | null = null;

/** Called once at startup (buildApp). */
export function initSecrets(rawKey: string | undefined): void {
  activeKey = parseEncryptionKey(rawKey);
}

function key(): Buffer {
  if (!activeKey) throw new EncryptionKeyError('Secrets module not initialised (ENCRYPTION_KEY).');
  return activeKey;
}

function aad(id: string, purpose: string): Buffer {
  return Buffer.from(`sonu-secret-v1:${id}:${purpose}`, 'utf8');
}

export function encrypt(plain: string, id: string, purpose: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad(id, purpose));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decrypt(row: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, id: string, purpose: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), row.iv);
  decipher.setAAD(aad(id, purpose));
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}

export interface PutSecretInput {
  contractorId: string | null;
  purpose: string;
  value: string;
  /** Replace this existing secret in place (same id). */
  id?: string | null;
}

/** Stores (or replaces) a secret and returns its id. */
export async function putSecret(db: Queryable, input: PutSecretInput): Promise<string> {
  if (!input.value) throw new Error('putSecret: empty value');
  if (input.id) {
    const existing = await db.query<{ id: string; contractor_id: string | null }>(
      'SELECT id, contractor_id FROM secret WHERE id = $1',
      [input.id],
    );
    const row = existing.rows[0];
    if (row && row.contractor_id === input.contractorId) {
      const enc = encrypt(input.value, row.id, input.purpose);
      await db.query(
        `UPDATE secret SET purpose = $2, ciphertext = $3, iv = $4, tag = $5, key_version = $6, updated_at = now() WHERE id = $1`,
        [row.id, input.purpose, enc.ciphertext, enc.iv, enc.tag, KEY_VERSION],
      );
      return row.id;
    }
  }
  const id = crypto.randomUUID();
  const enc = encrypt(input.value, id, input.purpose);
  await db.query(
    `INSERT INTO secret (id, contractor_id, purpose, ciphertext, iv, tag, key_version) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.contractorId, input.purpose, enc.ciphertext, enc.iv, enc.tag, KEY_VERSION],
  );
  return id;
}

/**
 * SERVER-INTERNAL ONLY. Returns the clear text or null when absent.
 * Pass contractorId to make sure the secret belongs to that tenant (null = platform secret).
 */
export async function readSecret(db: Queryable, id: string | null | undefined, contractorId?: string | null): Promise<string | null> {
  if (!id) return null;
  const r = await db.query<{ id: string; contractor_id: string | null; purpose: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
    'SELECT id, contractor_id, purpose, ciphertext, iv, tag FROM secret WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (contractorId !== undefined && row.contractor_id !== contractorId) return null;
  return decrypt(row, row.id, row.purpose);
}

export async function hasSecret(db: Queryable, id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  const r = await db.query('SELECT 1 FROM secret WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteSecret(db: Queryable, id: string | null | undefined): Promise<void> {
  if (!id) return;
  await db.query('DELETE FROM secret WHERE id = $1', [id]);
}

/** Bearer token for the internal worker API: hex(HMAC-SHA256(ENCRYPTION_KEY bytes, "sonu-worker-v1")). */
export function workerToken(): string {
  return crypto.createHmac('sha256', key()).update('sonu-worker-v1').digest('hex');
}

/** Keys whose values must never leave the server (used by audit / log sanitising). */
export const SECRET_KEY_PATTERN = /pass(word)?|secret|token|refresh|private|api[-_]?key|authorization|cookie/i;

/** Deep copy with every secret-looking key replaced by "[redacted]". */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k) && !/^has[A-Z]/.test(k)) out[k] = '[redacted]';
      else out[k] = redactSecrets(v);
    }
    return out as T;
  }
  return value;
}
