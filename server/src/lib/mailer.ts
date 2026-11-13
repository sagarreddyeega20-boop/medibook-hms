import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

// With no SMTP_HOST (dev), emails are serialised and logged instead of sent.
const transporter: Transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(input: MailInput) {
  const info = await transporter.sendMail({ from: env.MAIL_FROM, ...input });
  if (!env.SMTP_HOST && env.NODE_ENV === 'development') {
    console.log(`[mail:dev] to=${input.to} subject="${input.subject}"\n${input.text}`);
  }
  return info;
}
