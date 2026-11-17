import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../db.js';
import type { MailMessage, MailResult, MailSender, TransportFactory, TransportOptions } from './types.js';

const defaultFactory: TransportFactory = (options) => nodemailer.createTransport(options as never);

function formatFrom(address: string | undefined, name: string | undefined): string | undefined {
  if (!address) return undefined;
  return name ? `"${name.replace(/"/g, "'")}" <${address}>` : address;
}

function nodemailerSender(
  driver: 'smtp' | 'oauth2',
  options: TransportOptions,
  from: string | undefined,
  defaults: { replyTo?: string },
  factory: TransportFactory | undefined,
): MailSender {
  const transport = (factory ?? defaultFactory)(options);
  return {
    driver,
    from,
    async send(msg: MailMessage): Promise<MailResult> {
      const info = await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        replyTo: msg.replyTo ?? defaults.replyTo,
      });
      return { driver, messageId: (info as { messageId?: string }).messageId };
    },
  };
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  /** App password from the mail provider (decrypted just before use, never stored in clear). */
  password?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
}

/** Plain SMTP: host / port / TLS / user + app password. */
export function createSmtpSender(o: SmtpOptions, factory?: TransportFactory): MailSender {
  const options: TransportOptions = {
    host: o.host,
    port: o.port,
    secure: o.secure,
    auth: o.user ? { user: o.user, pass: o.password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
  return nodemailerSender('smtp', options, formatFrom(o.fromAddress ?? o.user ?? undefined, o.fromName ?? undefined), {
    replyTo: o.replyTo ?? undefined,
  }, factory);
}

export interface OAuth2Options {
  provider: 'microsoft' | 'google';
  /** Mailbox that sends, e.g. maintenance@contractor.example */
  user: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Microsoft Entra tenant id (or "common"). */
  tenant?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
}

/**
 * OAuth2 (XOAUTH2) for Microsoft 365 and Google Workspace.
 *
 * THE ADMIN MUST FIRST REGISTER AN APPLICATION WITH THE MAIL PROVIDER:
 *  - Microsoft 365: Entra ID → App registrations → new app; add the delegated permission
 *    "SMTP.Send" (Office 365 Exchange Online) and "offline_access"; create a client secret;
 *    make sure "Authenticated SMTP" is allowed for the sending mailbox; obtain a refresh token
 *    for the mailbox (authorisation-code flow, scope "https://outlook.office.com/SMTP.Send offline_access").
 *  - Google Workspace: Google Cloud console → OAuth client (web); enable the Gmail API; scope
 *    "https://mail.google.com/"; obtain a refresh token for the mailbox.
 * Client id goes in mail settings; client secret and refresh token are stored only as encrypted
 * secrets (table `secret`) and are never returned by the API.
 */
export function createOAuth2Sender(o: OAuth2Options, factory?: TransportFactory): MailSender {
  const auth = {
    type: 'OAuth2',
    user: o.user,
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    refreshToken: o.refreshToken,
  } as Record<string, unknown>;
  let options: TransportOptions;
  if (o.provider === 'microsoft') {
    auth.accessUrl = `https://login.microsoftonline.com/${encodeURIComponent(o.tenant || 'common')}/oauth2/v2.0/token`;
    options = { host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth };
  } else {
    options = { host: 'smtp.gmail.com', port: 465, secure: true, auth };
  }
  return nodemailerSender('oauth2', options, formatFrom(o.fromAddress ?? o.user, o.fromName ?? undefined), {
    replyTo: o.replyTo ?? undefined,
  }, factory);
}

/**
 * Used when no mail is configured: the message goes to the server log and to table mail_outbox,
 * so invitation links can be copied in local runs. Not a real delivery.
 */
export function createLogSender(db: Queryable, log: FastifyBaseLogger, contractorId: string | null): MailSender {
  return {
    driver: 'log',
    from: undefined,
    async send(msg: MailMessage): Promise<MailResult> {
      const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
      const r = await db.query<{ id: string }>(
        `INSERT INTO mail_outbox (contractor_id, to_address, subject, body_text, body_html, driver)
         VALUES ($1, $2, $3, $4, $5, 'log') RETURNING id`,
        [contractorId, to, msg.subject, msg.text, msg.html ?? null],
      );
      log.info({ mail: { to, subject: msg.subject, outboxId: r.rows[0]?.id } }, `[mail:log] no mail configured — message kept in outbox:\n${msg.text}`);
      return { driver: 'log', messageId: r.rows[0]?.id };
    },
  };
}
