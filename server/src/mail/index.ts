/**
 * E-mail. Everything goes through ONE interface, MailSender { send(msg) }.
 *
 *   const sender = await getMailSender(app, contractorId);   // contractor settings → platform → log
 *   await sender.send({ to, subject, text, html });
 *   // or simply:
 *   await sendMail(app, contractorId, { to, subject, text });
 *
 * Drivers: smtp (host/port/TLS/user + app password), oauth2 (Microsoft 365 / Google Workspace,
 * XOAUTH2), log (nothing configured: server log + mail_outbox table).
 */
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db.js';
import { readSecret } from '../secrets.js';
import { createLogSender, createOAuth2Sender, createSmtpSender } from './drivers.js';
import { getMailSettingsRow, type MailSettingsRow } from './settings.js';
import type { MailMessage, MailResult, MailSender } from './types.js';

export type { MailMessage, MailResult, MailSender, MailDriverName, TransportFactory } from './types.js';
export { createSmtpSender, createOAuth2Sender, createLogSender } from './drivers.js';
export { mailSettingsView, saveMailSettings, mailSettingsInput, getMailSettingsRow } from './settings.js';
export * as mailTemplates from './templates.js';

function isConfigured(row: MailSettingsRow | undefined): row is MailSettingsRow {
  if (!row || row.driver === 'log') return false;
  if (row.driver === 'smtp') return !!row.smtp_host && !!row.smtp_port;
  return !!row.oauth_provider && !!row.oauth_user && !!row.oauth_client_id;
}

async function senderFromRow(app: FastifyInstance, db: Queryable, row: MailSettingsRow): Promise<MailSender> {
  const factory = app.mailTransportFactory;
  if (row.driver === 'smtp') {
    return createSmtpSender(
      {
        host: row.smtp_host!,
        port: row.smtp_port!,
        secure: row.smtp_secure,
        user: row.smtp_user,
        password: await readSecret(db, row.smtp_password_secret_id, row.contractor_id),
        fromAddress: row.from_address,
        fromName: row.from_name,
        replyTo: row.reply_to,
      },
      factory,
    );
  }
  const clientSecret = await readSecret(db, row.oauth_client_secret_id, row.contractor_id);
  const refreshToken = await readSecret(db, row.oauth_refresh_token_secret_id, row.contractor_id);
  if (!clientSecret || !refreshToken) {
    throw new Error('OAuth2 mail is selected but the client secret or refresh token has not been saved.');
  }
  return createOAuth2Sender(
    {
      provider: row.oauth_provider!,
      user: row.oauth_user!,
      clientId: row.oauth_client_id!,
      clientSecret,
      refreshToken,
      tenant: row.oauth_tenant,
      fromAddress: row.from_address,
      fromName: row.from_name,
      replyTo: row.reply_to,
    },
    factory,
  );
}

/**
 * Sender for a contractor (null = platform). Falls back to the platform settings
 * (mail_settings.contractor_id IS NULL) and then to the log driver.
 */
export async function getMailSender(app: FastifyInstance, contractorId: string | null, db: Queryable = app.db): Promise<MailSender> {
  if (contractorId) {
    const own = await getMailSettingsRow(db, contractorId);
    if (isConfigured(own)) return senderFromRow(app, db, own);
  }
  const platform = await getMailSettingsRow(db, null);
  if (isConfigured(platform)) return senderFromRow(app, db, platform);
  return createLogSender(db, app.log, contractorId);
}

export async function sendMail(app: FastifyInstance, contractorId: string | null, msg: MailMessage): Promise<MailResult> {
  const sender = await getMailSender(app, contractorId);
  return sender.send(msg);
}
