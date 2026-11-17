import type { MailMessage } from './types.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function wrap(lines: string[], link?: { href: string; label: string }): { text: string; html: string } {
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.href}`] : [])].join('\n');
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map((l) => (l ? `<p>${esc(l)}</p>` : '')).join('') +
    (link ? `<p><a href="${esc(link.href)}">${esc(link.label)}</a></p>` : '') +
    `</div>`;
  return { text, html };
}

export function invitation(p: { to: string; fullName: string; companyName: string | null; link: string; days: number }): MailMessage {
  const body = wrap(
    [
      `Hello ${p.fullName},`,
      `You have been invited to SONU${p.companyName ? ` for ${p.companyName}` : ''}.`,
      `Open the link below to confirm your e-mail address and choose a password. The link works once and expires in ${p.days} days.`,
      'If you did not expect this message you can ignore it.',
    ],
    { href: p.link, label: 'Accept the invitation' },
  );
  return { to: p.to, subject: 'Your SONU invitation', ...body };
}

export function passwordReset(p: { to: string; fullName: string; link: string; hours: number }): MailMessage {
  const body = wrap(
    [
      `Hello ${p.fullName},`,
      `Someone asked to reset the SONU password for this address. The link works once and expires in ${p.hours} hours.`,
      'If it was not you, ignore this message; your password stays the same.',
    ],
    { href: p.link, label: 'Choose a new password' },
  );
  return { to: p.to, subject: 'Reset your SONU password', ...body };
}

export function testMessage(p: { to: string; fullName: string; driver: string }): MailMessage {
  const body = wrap([
    `Hello ${p.fullName},`,
    `This is a test e-mail from SONU (connection type: ${p.driver}). If you can read it, the e-mail settings work.`,
  ]);
  return { to: p.to, subject: 'SONU test e-mail', ...body };
}

export function notification(p: { to: string; title: string; body: string | null; link: string | null }): MailMessage {
  const body = wrap([p.title, p.body ?? ''], p.link ? { href: p.link, label: 'Open in SONU' } : undefined);
  return { to: p.to, subject: p.title, ...body };
}
