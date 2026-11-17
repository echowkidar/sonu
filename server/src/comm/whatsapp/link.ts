/** Click-to-chat: wa.me links and their QR code. No message is sent by the server. */
import QRCode from 'qrcode';
import { badRequest } from '../../errors.js';

/** Country code assumed for 8-digit local numbers (Qatar). */
export const DEFAULT_COUNTRY_CODE = '974';

/**
 * Normalises a phone number to the digits wa.me expects (country code + number, no "+", no "00").
 * "+974 5555-0199", "00974 55550199", "55550199" → "97455550199". Returns null when not plausible.
 */
export function normalizeNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).trim();
  if (!/^[+\d\s().-]+$/.test(d)) return null;
  d = d.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = DEFAULT_COUNTRY_CODE + d;
  if (d.length < 9 || d.length > 15 || d.startsWith('0')) return null;
  return d;
}

export function buildWaLink(to: string, text: string): string {
  const digits = normalizeNumber(to);
  if (!digits) throw badRequest('That is not a valid phone number (use the country code, e.g. +974 5555 0199).');
  const t = text ?? '';
  return t ? `https://wa.me/${digits}?text=${encodeURIComponent(t)}` : `https://wa.me/${digits}`;
}

/** QR code (SVG markup) of any text, e.g. a wa.me link or a linked-session pairing code. */
export async function qrSvg(value: string): Promise<string> {
  return QRCode.toString(value, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

/** "+974••••0199" — never the full number in admin status. */
export function maskNumber(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const d = digits.replace(/\D/g, '');
  if (d.length < 7) return '••••';
  return `+${d.slice(0, 3)}••••${d.slice(-4)}`;
}
