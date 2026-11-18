import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

/**
 * Mail transport.
 * - smtp: real email through Nodemailer (Gmail SMTP by default).
 * - console: emails are serialised and printed to the server log ([mail:dev]); nothing leaves the machine.
 * MAIL_TRANSPORT picks one; unset → smtp when SMTP_USER + SMTP_PASS are set, otherwise console.
 * Tests always use console so they can never send real email.
 */
export type MailTransportKind = 'smtp' | 'console';

export const mailTransport: MailTransportKind =
  env.NODE_ENV === 'test' ? 'console' : (env.MAIL_TRANSPORT ?? (env.SMTP_USER && env.SMTP_PASS ? 'smtp' : 'console'));

const secure = env.SMTP_SECURE ?? env.SMTP_PORT === 465;

const transporter: Transporter =
  mailTransport === 'smtp'
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      })
    : nodemailer.createTransport({ jsonTransport: true });

/** One-line description for the startup log. Never includes the password. */
export function describeMailTransport(): string {
  return mailTransport === 'smtp'
    ? `[mail] transport=smtp via ${env.SMTP_HOST}:${env.SMTP_PORT}${secure ? ' (TLS)' : ' (STARTTLS)'} as ${env.SMTP_USER || '(no user)'}`
    : '[mail] transport=console (emails are printed to this log, not sent; set SMTP_USER + SMTP_PASS or MAIL_TRANSPORT=smtp to send)';
}

/** Turns a Nodemailer error into a message that says what to fix. */
export function explainMailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 'EAUTH' || e?.responseCode === 535 || e?.responseCode === 534) {
    return `EAUTH: SMTP login rejected (${e.responseCode ?? 'auth'}). For Gmail, SMTP_PASS must be a 16-character App Password (not your normal password) for ${env.SMTP_USER}, with 2-Step Verification on. — ${msg}`;
  }
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNREFUSED' || e?.code === 'ESOCKET' || e?.code === 'ECONNECTION' || e?.code === 'EDNS' || e?.code === 'ENOTFOUND') {
    return `${e.code}: cannot reach ${env.SMTP_HOST}:${env.SMTP_PORT}. Check your internet connection, firewall/antivirus or network blocking SMTP; try SMTP_PORT=587 with SMTP_SECURE=false. — ${msg}`;
  }
  return e?.code ? `${e.code}: ${msg}` : msg;
}

/** Errors that retrying cannot fix (wrong credentials, rejected recipient). */
export function isPermanentMailError(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number };
  return e?.code === 'EAUTH' || e?.code === 'EENVELOPE' || (typeof e?.responseCode === 'number' && e.responseCode >= 500);
}

/** Checks the SMTP login at boot. Logs the outcome; never throws, so the server keeps running. */
export async function verifyMailTransport(): Promise<boolean> {
  console.log(describeMailTransport());
  if (mailTransport !== 'smtp') return true;
  try {
    await transporter.verify();
    console.log(`[mail] SMTP login OK (${env.SMTP_HOST})`);
    return true;
  } catch (err) {
    console.error(`[mail] SMTP check FAILED — emails will not be delivered until this is fixed.\n[mail] ${explainMailError(err)}`);
    return false;
  }
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(input: MailInput): Promise<{ messageId: string }> {
  const info = await transporter.sendMail({ from: env.MAIL_FROM, ...input });
  if (mailTransport === 'console' && env.NODE_ENV === 'development') {
    console.log(`[mail:dev] to=${input.to} subject="${input.subject}"\n${input.text}`);
  }
  return { messageId: info.messageId };
}
