import { env } from '../../config/env.js';
import { explainMailError, isPermanentMailError, sendMail, type MailInput } from '../../lib/mailer.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { emitTo, Rooms } from '../../lib/socket.js';
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

  /**
   * Records the email in `notifications` (QUEUED) and returns at once; the send runs in the background so a slow
   * mail server never delays the HTTP response. The row ends as SENT (with the message ID) or FAILED (with the error).
   */
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
    void deliver(row.id, mail, template);
    return row;
  },

  /** In-app alert: stored, then pushed live to the user's socket room. */
  async inApp(userId: string, msg: { subject: string; body: string; data?: Prisma.InputJsonValue }) {
    const row = await prisma.notification.create({
      data: { userId, channel: 'IN_APP', status: 'SENT', sentAt: new Date(), subject: msg.subject, body: msg.body, data: msg.data },
      select: inAppSelect,
    });
    emitTo(Rooms.user(userId), 'notification', row);
    return row;
  },

  async inbox(userId: string, opts: { unreadOnly?: boolean } = {}) {
    const where = { userId, channel: 'IN_APP' as const, ...(opts.unreadOnly ? { readAt: null } : {}) };
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, select: inAppSelect }),
      prisma.notification.count({ where: { userId, channel: 'IN_APP', readAt: null } }),
    ]);
    return { items, unread };
  },

  async markRead(userId: string, id: string) {
    await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date(), status: 'READ' } });
  },
};

/** Backoff before retry 1 and retry 2. A failed send is retried up to 2 times unless the error is permanent (e.g. wrong App Password). */
const RETRY_DELAYS_MS = [2_000, 6_000];

async function deliver(id: string, mail: MailInput, template?: string) {
  const label = template ?? mail.subject;
  for (let attempt = 0; ; attempt++) {
    try {
      const { messageId } = await sendMail(mail);
      await prisma.notification.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), error: null, data: { ...(template ? { template } : {}), messageId, attempts: attempt + 1 } },
      });
      return;
    } catch (err) {
      const reason = explainMailError(err);
      const retry = attempt < RETRY_DELAYS_MS.length && !isPermanentMailError(err);
      console.error(`[mail] send "${label}" to ${mail.to} failed (attempt ${attempt + 1}${retry ? ', will retry' : ''}): ${reason}`);
      if (retry) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      await prisma.notification
        .update({ where: { id }, data: { status: 'FAILED', error: reason.slice(0, 2000), data: { ...(template ? { template } : {}), attempts: attempt + 1 } } })
        .catch((e) => console.error('[mail] could not record failure:', e instanceof Error ? e.message : e));
      return;
    }
  }
}

const inAppSelect ={ id: true, subject: true, body: true, data: true, readAt: true, createdAt: true } satisfies Prisma.NotificationSelect;
