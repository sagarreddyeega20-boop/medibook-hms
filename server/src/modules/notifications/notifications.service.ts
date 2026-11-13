import { env } from '../../config/env.js';
import { sendMail, type MailInput } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { emailTemplates, type TemplateData, type TemplateName } from './templates.js';

/**
 * Notifications service — every outgoing message goes through notify(recipient, template, data).
 * Channels: EMAIL today (Nodemailer + Gmail SMTP); SMS/WhatsApp plug in here later.
 * Owns: notifications, settings. Other modules call this service, never these tables directly.
 */
export interface Recipient {
  userId?: string | null;
  email?: string | null;
  // phone?: string — reserved for SMS/WhatsApp channels
}

/** Templates whose rendered body must never be stored in the notifications table. */
const SECRET_TEMPLATES: TemplateName[] = ['otp', 'staff-invite'];

export const notificationsService = {
  async notify<T extends TemplateName>(recipient: Recipient, template: T, data: TemplateData[T]) {
    if (template === 'otp' && env.NODE_ENV === 'development') {
      const d = data as TemplateData['otp'];
      console.log(`[otp:dev] ${recipient.email} → ${d.code} (expires in ${d.minutes} min)`);
    }
    if (template === 'staff-invite' && env.NODE_ENV === 'development') {
      console.log(`[invite:dev] ${recipient.email} → ${(data as TemplateData['staff-invite']).link}`);
    }

    const results = [];
    if (recipient.email) {
      const rendered = emailTemplates[template](data as never);
      results.push(
        await this.sendEmail({
          userId: recipient.userId ?? undefined,
          to: recipient.email,
          ...rendered,
          storeBody: SECRET_TEMPLATES.includes(template) ? `[${template}]` : rendered.text,
          template,
        }),
      );
    }
    return results;
  },

  /** Records the email in `notifications`, sends it, and stores the outcome. */
  async sendEmail(input: MailInput & { userId?: string; storeBody?: string; template?: string }) {
    const { userId, storeBody, template, ...mail } = input;
    const row = await prisma.notification.create({
      data: {
        userId,
        channel: 'EMAIL',
        recipient: mail.to,
        subject: template === 'otp' ? 'Verification code' : mail.subject, // the OTP subject contains the code
        body: storeBody ?? mail.text,
        data: template ? { template } : undefined,
      },
    });
    try {
      await sendMail(mail);
      return prisma.notification.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date() } });
    } catch (err) {
      console.error(`[mail] failed to send "${template ?? mail.subject}" to ${mail.to}: ${err instanceof Error ? err.message : err}`);
      return prisma.notification.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
      });
    }
  },
};
