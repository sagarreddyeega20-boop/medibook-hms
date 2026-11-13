import { sendMail, type MailInput } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Notifications service — email (Nodemailer) and in-app notifications; system settings.
 * Owns: notifications, settings. Other modules call this service, never these tables directly.
 */
export const notificationsService = {
  /** Records the email in `notifications`, sends it, and stores the outcome. */
  async sendEmail(input: MailInput & { userId?: string }) {
    const row = await prisma.notification.create({
      data: { userId: input.userId, channel: 'EMAIL', recipient: input.to, subject: input.subject, body: input.text },
    });
    try {
      await sendMail(input);
      return prisma.notification.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date() } });
    } catch (err) {
      return prisma.notification.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err) },
      });
    }
  },
};
