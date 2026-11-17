import type { Transporter } from 'nodemailer';

export type MailDriverName = 'log' | 'smtp' | 'oauth2';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface MailResult {
  driver: MailDriverName;
  messageId?: string;
}

/** The ONE interface every part of SONU uses to send e-mail. */
export interface MailSender {
  readonly driver: MailDriverName;
  readonly from: string | undefined;
  send(msg: MailMessage): Promise<MailResult>;
}

/** nodemailer transport options as built by the smtp / oauth2 drivers. */
export type TransportOptions = Record<string, unknown>;

/** Lets tests (or a future queue) replace the real nodemailer transport. */
export type TransportFactory = (options: TransportOptions) => Transporter;
