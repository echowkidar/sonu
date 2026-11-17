import crypto from 'node:crypto';

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Human-friendly one-time code, e.g. "K7QF-2M9X-HV4C" (no 0/O/1/I). */
export function setupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += alphabet[bytes[i]! % alphabet.length];
    if (i === 3 || i === 7) s += '-';
  }
  return s;
}
