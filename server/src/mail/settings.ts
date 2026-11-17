import type { Queryable } from '../db.js';
import { deleteSecret, hasSecret, putSecret } from '../secrets.js';
import type { MailDriverName } from './types.js';
import { z } from 'zod';

export interface MailSettingsRow {
  id: string;
  contractor_id: string | null;
  driver: MailDriverName;
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  signature: string | null;
  footer: string | null;
  purchasing_from_address: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password_secret_id: string | null;
  oauth_provider: 'microsoft' | 'google' | null;
  oauth_user: string | null;
  oauth_client_id: string | null;
  oauth_tenant: string | null;
  oauth_client_secret_id: string | null;
  oauth_refresh_token_secret_id: string | null;
  notification_mailbox: string | null;
  updated_at: Date;
}

export async function getMailSettingsRow(db: Queryable, contractorId: string | null): Promise<MailSettingsRow | undefined> {
  const r = await db.query<MailSettingsRow>(
    'SELECT * FROM mail_settings WHERE contractor_id IS NOT DISTINCT FROM $1',
    [contractorId],
  );
  return r.rows[0];
}

/** API view: never contains a secret, only has* flags. */
export async function mailSettingsView(db: Queryable, contractorId: string | null) {
  const row = await getMailSettingsRow(db, contractorId);
  return {
    scope: contractorId ? 'contractor' : 'platform',
    contractorId,
    driver: row?.driver ?? 'log',
    fromAddress: row?.from_address ?? null,
    fromName: row?.from_name ?? null,
    replyTo: row?.reply_to ?? null,
    signature: row?.signature ?? null,
    footer: row?.footer ?? null,
    purchasingFromAddress: row?.purchasing_from_address ?? null,
    smtpHost: row?.smtp_host ?? null,
    smtpPort: row?.smtp_port ?? null,
    smtpSecure: row?.smtp_secure ?? false,
    smtpUser: row?.smtp_user ?? null,
    hasPassword: await hasSecret(db, row?.smtp_password_secret_id),
    oauthProvider: row?.oauth_provider ?? null,
    oauthUser: row?.oauth_user ?? null,
    oauthClientId: row?.oauth_client_id ?? null,
    oauthTenant: row?.oauth_tenant ?? null,
    hasClientSecret: await hasSecret(db, row?.oauth_client_secret_id),
    hasRefreshToken: await hasSecret(db, row?.oauth_refresh_token_secret_id),
    notificationMailbox: row?.notification_mailbox ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

const optStr = z.string().trim().max(500).nullish();
const optEmail = z.union([z.string().trim().email(), z.literal(''), z.null()]).optional();

export const mailSettingsInput = z
  .object({
    driver: z.enum(['log', 'smtp', 'oauth2']),
    fromAddress: optEmail,
    fromName: optStr,
    replyTo: optEmail,
    signature: z.string().max(5000).nullish(),
    footer: z.string().max(5000).nullish(),
    purchasingFromAddress: optEmail,
    smtpHost: optStr,
    smtpPort: z.coerce.number().int().min(1).max(65535).nullish(),
    smtpSecure: z.boolean().optional(),
    smtpUser: optStr,
    /** Write-only. Empty/absent = keep the stored one. */
    password: z.string().max(1000).optional(),
    clearPassword: z.boolean().optional(),
    oauthProvider: z.enum(['microsoft', 'google']).nullish(),
    oauthUser: optEmail,
    oauthClientId: optStr,
    oauthTenant: optStr,
    /** Write-only. */
    oauthClientSecret: z.string().max(4000).optional(),
    /** Write-only. */
    oauthRefreshToken: z.string().max(8000).optional(),
    notificationMailbox: optEmail,
  })
  .strict();

export type MailSettingsInput = z.infer<typeof mailSettingsInput>;

const nz = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);

export async function saveMailSettings(
  db: Queryable,
  contractorId: string | null,
  input: MailSettingsInput,
  userId: string | null,
): Promise<{ changedSecrets: string[] }> {
  const existing = await getMailSettingsRow(db, contractorId);
  const changedSecrets: string[] = [];

  let smtpSecretId = existing?.smtp_password_secret_id ?? null;
  if (input.clearPassword) {
    await deleteSecret(db, smtpSecretId);
    smtpSecretId = null;
    changedSecrets.push('password(cleared)');
  } else if (input.password) {
    smtpSecretId = await putSecret(db, { contractorId, purpose: 'mail.smtp_password', value: input.password, id: smtpSecretId });
    changedSecrets.push('password');
  }
  let clientSecretId = existing?.oauth_client_secret_id ?? null;
  if (input.oauthClientSecret) {
    clientSecretId = await putSecret(db, { contractorId, purpose: 'mail.oauth_client_secret', value: input.oauthClientSecret, id: clientSecretId });
    changedSecrets.push('oauthClientSecret');
  }
  let refreshId = existing?.oauth_refresh_token_secret_id ?? null;
  if (input.oauthRefreshToken) {
    refreshId = await putSecret(db, { contractorId, purpose: 'mail.oauth_refresh_token', value: input.oauthRefreshToken, id: refreshId });
    changedSecrets.push('oauthRefreshToken');
  }

  const values = [
    contractorId,
    input.driver,
    nz(input.fromAddress),
    nz(input.fromName),
    nz(input.replyTo),
    nz(input.signature),
    nz(input.footer),
    nz(input.purchasingFromAddress),
    nz(input.smtpHost),
    input.smtpPort ?? null,
    input.smtpSecure ?? false,
    nz(input.smtpUser),
    smtpSecretId,
    input.oauthProvider ?? null,
    nz(input.oauthUser),
    nz(input.oauthClientId),
    nz(input.oauthTenant),
    clientSecretId,
    refreshId,
    nz(input.notificationMailbox),
    userId,
  ];
  if (existing) {
    await db.query(
      `UPDATE mail_settings SET driver=$2, from_address=$3, from_name=$4, reply_to=$5, signature=$6, footer=$7,
         purchasing_from_address=$8, smtp_host=$9, smtp_port=$10, smtp_secure=$11, smtp_user=$12,
         smtp_password_secret_id=$13, oauth_provider=$14, oauth_user=$15, oauth_client_id=$16, oauth_tenant=$17,
         oauth_client_secret_id=$18, oauth_refresh_token_secret_id=$19, notification_mailbox=$20, updated_by=$21,
         updated_at=now()
       WHERE contractor_id IS NOT DISTINCT FROM $1`,
      values,
    );
  } else {
    await db.query(
      `INSERT INTO mail_settings (contractor_id, driver, from_address, from_name, reply_to, signature, footer,
         purchasing_from_address, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password_secret_id,
         oauth_provider, oauth_user, oauth_client_id, oauth_tenant, oauth_client_secret_id,
         oauth_refresh_token_secret_id, notification_mailbox, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      values,
    );
  }
  return { changedSecrets };
}
