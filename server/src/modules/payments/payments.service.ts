import type { OnlinePaymentOrder, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { billingService } from '../billing/billing.service.js';
import { patientsService } from '../patients/patients.service.js';
import { schedulingService } from '../scheduling/scheduling.service.js';
import { staffService } from '../staff/staff.service.js';
import type { Instrument, PaymentProvider, WebhookEvent } from './provider.js';
import { SimulatedProvider } from './simulated.provider.js';

/**
 * Payments service — online prepayment of the consultation for a held slot (patient portal and chatbot "Pay now").
 * Owns: online_payment_orders. The ledger (charges, invoices, payments, allocations, refunds) stays in billing.
 *
 *   hold (scheduling, 10 min) → createOrder → pay(attempt) → gateway webhook
 *     captured → book the appointment + record charge, invoice, ONLINE payment and allocation in ONE transaction
 *     failed   → order FAILED; the patient retries (the hold keeps running)
 *     hold gone before capture → order EXPIRED, any captured amount is refunded
 *
 * Payments are confirmed only by the (signed) webhook, never by the browser. Exactly one payment per order:
 * its idempotency key is `online:<order id>`, however many attempts or webhook deliveries there are.
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

const provider: PaymentProvider = new SimulatedProvider((body, signature) => paymentsService.handleWebhook('simulated', body, signature));

/** The webhook books on behalf of the patient who holds the slot (same checks as booking in the portal). */
const patientActor = (userId: string) => ({
  session: { userId, kind: 'PATIENT', role: 'PATIENT', permissions: ['self:book'], name: '', createdAt: Date.now(), idleSeconds: 0 } as SessionData,
  ip: null,
});

const SLOT_GONE = new Set(['HOLD_EXPIRED', 'SLOT_TAKEN', 'SLOT_HELD', 'SLOT_PAST', 'SLOT_INVALID']);
const EXPIRED_MESSAGE = 'Slot expired, pick another time.';

async function assertMayBookFor(userId: string, patientId: string) {
  if (!(await patientsService.accessiblePatientIds(userId)).includes(patientId)) {
    throw AppError.forbidden('You can only book for yourself and your family members');
  }
}

async function loadOwn(actor: Actor, id: string) {
  const o = await prisma.onlinePaymentOrder.findUnique({ where: { id } });
  if (!o || o.userId !== actor.session.userId) throw AppError.notFound('Payment not found');
  return o;
}

/** CREATED / FAILED orders whose hold ran out become EXPIRED (the slot is free again). */
async function expireIfHoldGone(o: OnlinePaymentOrder) {
  if (o.status !== 'CREATED' && o.status !== 'FAILED') return o;
  if (await schedulingService.holdInfo(o.holdId, o.userId)) return o;
  await prisma.onlinePaymentOrder.updateMany({ where: { id: o.id, status: o.status }, data: { status: 'EXPIRED', failureReason: EXPIRED_MESSAGE } });
  return prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id: o.id } });
}

async function present(o: OnlinePaymentOrder) {
  const [doctor, patient, hold] = await Promise.all([
    staffService.doctorById(o.doctorId),
    patientsService.getSummary(o.patientId),
    o.status === 'PAID' || o.status === 'EXPIRED' ? null : schedulingService.holdInfo(o.holdId, o.userId),
  ]);
  const [appointment, receipt] = await Promise.all([
    o.appointmentId ? schedulingService.view(o.appointmentId) : null,
    o.paymentId ? billingService.receipt(o.paymentId) : null,
  ]);
  return {
    id: o.id,
    status: o.status,
    amountPaise: o.amountPaise,
    attempts: o.attempts,
    method: o.method,
    instrument: o.instrument,
    last4: o.last4,
    failureReason: o.failureReason,
    slotStart: o.slotStart,
    holdExpiresAt: hold?.expiresAt ?? null,
    doctor: { id: doctor.id, name: doctor.fullName, specialty: doctor.specialty, department: doctor.department?.name ?? null },
    patient: { id: patient.id, name: patient.name, mrn: patient.mrn },
    appointment,
    receipt: receipt ? { paymentId: receipt.id, receiptNumber: receipt.receiptNumber, transactionId: o.providerPaymentId, paidAt: receipt.receivedAt, method: receipt.method, provider: receipt.provider, last4: receipt.last4 } : null,
  };
}
export type OrderView = Awaited<ReturnType<typeof present>>;

/** One finalisation at a time per order (webhooks may be delivered twice or race each other). */
async function withOrderLock<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
  const key = `payorder:lock:${id}`;
  if ((await redis.set(key, '1', 'EX', 30, 'NX')) !== 'OK') return null;
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}

async function refundAtGateway(providerPaymentId: string, amountPaise: number, reason: string) {
  try {
    return (await provider.refund({ providerPaymentId, amountPaise, reason })).providerRefundId;
  } catch (err) {
    console.error(`[payments] gateway refund of ${providerPaymentId} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function onCaptured(o: OnlinePaymentOrder, event: WebhookEvent) {
  if (o.status === 'PAID') return; // duplicate delivery
  if (event.amountPaise !== o.amountPaise) {
    await refundAtGateway(event.providerPaymentId, event.amountPaise, 'Amount mismatch');
    await prisma.onlinePaymentOrder.update({ where: { id: o.id }, data: { status: 'FAILED', failureReason: 'The gateway reported a different amount. Nothing was charged; please try again.' } });
    return;
  }
  const doctor = await staffService.doctorById(o.doctorId);
  const expire = async () => {
    // Money was captured but the slot is gone: give it back and tell the patient to pick another time.
    await refundAtGateway(event.providerPaymentId, o.amountPaise, 'Slot expired before the payment completed');
    await prisma.onlinePaymentOrder.updateMany({
      where: { id: o.id, status: { not: 'PAID' } },
      data: { status: 'EXPIRED', providerPaymentId: event.providerPaymentId, failureReason: `${EXPIRED_MESSAGE} Your payment was refunded.` },
    });
  };
  if (!(await schedulingService.holdInfo(o.holdId, o.userId))) return expire();
  try {
    await schedulingService.book(
      patientActor(o.userId),
      { holdId: o.holdId, patientId: o.patientId, reason: o.reason },
      {
        afterCreate: async (a, tx: Prisma.TransactionClient) => {
          const claimed = await tx.onlinePaymentOrder.updateMany({
            where: { id: o.id, status: { not: 'PAID' } },
            data: { status: 'PAID', appointmentId: a.id, providerPaymentId: event.providerPaymentId, failureReason: null },
          });
          if (!claimed.count) throw new AppError(409, 'ALREADY_PAID', 'This payment was already recorded');
          const p = await billingService.recordOnlinePrepayment({
            appointmentId: a.id, patientId: o.patientId, catalogueItemId: o.catalogueItemId, description: `Consultation – ${doctor.fullName}`,
            amountPaise: o.amountPaise, method: o.method ?? 'UPI', provider: o.instrument, last4: o.last4, reference: event.providerPaymentId,
            idempotencyKey: `online:${o.id}`, actorUserId: o.userId,
          }, tx);
          await tx.onlinePaymentOrder.update({ where: { id: o.id }, data: { paymentId: p.paymentId } });
        },
      },
    );
  } catch (err) {
    const now = await prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id: o.id } });
    if (now.status === 'PAID') return;
    if (err instanceof AppError && SLOT_GONE.has(err.code)) return expire();
    await refundAtGateway(event.providerPaymentId, o.amountPaise, 'Booking failed');
    await prisma.onlinePaymentOrder.update({ where: { id: o.id }, data: { status: 'FAILED', failureReason: 'We could not confirm the booking, so your payment was refunded. Please try again.' } });
    throw err;
  }
  billingService.notifyCharged(o.patientId);
}

async function onFailed(o: OnlinePaymentOrder, event: WebhookEvent) {
  const reason = event.error || 'The payment was declined.';
  const r = await prisma.onlinePaymentOrder.updateMany({ where: { id: o.id, status: 'PROCESSING' }, data: { status: 'FAILED', failureReason: reason } });
  if (!r.count) return;
  await auditService.recordSafe({
    actorId: o.userId, action: AuditAction.ONLINE_PAYMENT_FAILED, entity: 'online_payment_orders', entityId: o.id, patientId: o.patientId,
    reason, metadata: { attempt: o.attempts, method: o.method, provider: o.instrument },
  });
}

export const paymentsService = {
  providerName: () => provider.name,

  /** What the payment page shows before anything is charged: doctor, slot, patient, fee from the catalogue, hold timer. */
  async checkout(actor: Actor, input: { holdId: string; patientId: string }) {
    await assertMayBookFor(actor.session.userId, input.patientId);
    const hold = await schedulingService.holdInfo(input.holdId, actor.session.userId);
    if (!hold) throw new AppError(409, 'HOLD_EXPIRED', EXPIRED_MESSAGE);
    const [doctor, patient] = await Promise.all([staffService.doctorById(hold.doctorId), patientsService.getSummary(input.patientId)]);
    const item = await billingService.consultationItemFor({ staffCode: doctor.staffCode, departmentCode: doctor.department?.code ?? null });
    return {
      holdId: hold.holdId,
      slotStart: hold.slotStart,
      slotEnd: hold.slotEnd,
      holdExpiresAt: hold.expiresAt,
      doctor: { id: doctor.id, name: doctor.fullName, specialty: doctor.specialty, department: doctor.department?.name ?? null },
      patient: { id: patient.id, name: patient.name, mrn: patient.mrn },
      /** Null when the doctor has no consultation price: the booking can only be paid at the hospital. */
      fee: item ? { label: item.name, amountPaise: item.amountPaise } : null,
    };
  },

  /** Starts online checkout for a held slot. Same key → same order; an open order for the hold is reused. */
  async createOrder(actor: Actor, input: { holdId: string; patientId: string; reason?: string | null; idempotencyKey: string }) {
    const userId = actor.session.userId;
    const prior = await prisma.onlinePaymentOrder.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (prior.userId !== userId || prior.holdId !== input.holdId || prior.patientId !== input.patientId) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment key was already used for a different booking. Start again.');
      }
      return present(await expireIfHoldGone(prior));
    }
    const summary = await this.checkout(actor, input);
    if (!summary.fee) throw new AppError(409, 'NO_ONLINE_FEE', 'This doctor’s fee is not set for online payment. Choose “Pay at hospital”.');
    const open = await prisma.onlinePaymentOrder.findFirst({ where: { userId, holdId: input.holdId, patientId: input.patientId, status: { in: ['CREATED', 'PROCESSING', 'FAILED', 'PAID'] } } });
    if (open) return present(open);

    const doctor = await staffService.doctorById(summary.doctor.id);
    const item = (await billingService.consultationItemFor({ staffCode: doctor.staffCode, departmentCode: doctor.department?.code ?? null }))!;
    const { providerOrderId } = await provider.createOrder({ orderId: input.idempotencyKey, amountPaise: item.amountPaise });
    try {
      const o = await prisma.onlinePaymentOrder.create({
        data: {
          provider: provider.name, providerOrderId, idempotencyKey: input.idempotencyKey, userId, patientId: input.patientId, holdId: input.holdId,
          doctorId: summary.doctor.id, slotStart: new Date(summary.slotStart), reason: input.reason?.trim() || null,
          catalogueItemId: item.id, amountPaise: item.amountPaise, expiresAt: summary.holdExpiresAt,
        },
      });
      return present(o);
    } catch (err) {
      const raced = await prisma.onlinePaymentOrder.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (raced && raced.userId === userId) return present(raced);
      throw err;
    }
  },

  async order(actor: Actor, id: string) {
    return present(await expireIfHoldGone(await loadOwn(actor, id)));
  },

  /**
   * One payment attempt. `idempotencyKey` identifies the attempt: a retried request returns the same attempt instead
   * of paying twice. A new attempt is allowed after a failure, while the hold lasts.
   */
  async pay(actor: Actor, id: string, input: { idempotencyKey: string; instrument: Instrument }) {
    let o = await expireIfHoldGone(await loadOwn(actor, id));
    if (o.attemptKey === input.idempotencyKey || o.status === 'PAID') return present(o);
    if (o.status === 'EXPIRED') throw new AppError(409, 'HOLD_EXPIRED', EXPIRED_MESSAGE);
    if (o.status === 'PROCESSING') throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this booking is already being processed.');
    const ins = input.instrument;
    const started = await prisma.onlinePaymentOrder.updateMany({
      where: { id, status: { in: ['CREATED', 'FAILED'] } },
      data: {
        status: 'PROCESSING', attemptKey: input.idempotencyKey, attempts: { increment: 1 }, failureReason: null,
        method: ins.method, instrument: ins.provider.slice(0, 40), last4: ins.method === 'CARD' ? (ins.last4 ?? null) : null,
      },
    });
    o = await prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id } });
    if (!started.count) {
      if (o.attemptKey === input.idempotencyKey || o.status === 'PAID') return present(o);
      throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this booking is already being processed.');
    }
    try {
      await provider.confirm({ providerOrderId: o.providerOrderId, amountPaise: o.amountPaise, instrument: ins });
    } catch (err) {
      await prisma.onlinePaymentOrder.update({ where: { id }, data: { status: 'FAILED', failureReason: 'The payment gateway did not respond. No money was taken; please try again.' } });
      console.error('[payments] gateway confirm failed:', err instanceof Error ? err.message : err);
    }
    return present(await prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id } }));
  },

  /** Gateway webhook (POST /api/payments/webhook/:provider and the simulated gateway's in-process delivery). */
  async handleWebhook(providerName: string, body: unknown, signature: string | undefined) {
    if (providerName.toUpperCase() !== provider.name) throw AppError.notFound('Unknown payment provider');
    const event = provider.verifyWebhook(body, signature);
    const o = await prisma.onlinePaymentOrder.findUnique({ where: { providerOrderId: event.providerOrderId } });
    if (!o) throw AppError.notFound('Unknown order');
    await withOrderLock(o.id, async () => {
      const fresh = await prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id: o.id } });
      if (event.type === 'payment.captured') await onCaptured(fresh, event);
      else await onFailed(fresh, event);
    });
  },

  /**
   * A prepaid booking was cancelled: refund through the gateway, then record it (REFUNDED, audited). If the gateway
   * refund fails, a REQUESTED refund goes to accounts instead. No-op for pay-at-hospital bookings. Never throws.
   */
  async refundCancelledBooking(input: { appointmentId: string; ref: string; reason: string; actorUserId: string; ip?: string | null }) {
    try {
      const r = await billingService.prepaidRefundable(input.appointmentId);
      if (!r) return null;
      const gatewayRefundId = r.providerPaymentId ? await refundAtGateway(r.providerPaymentId, r.amountPaise, input.reason) : null;
      return await billingService.recordOnlineRefund({
        appointmentId: input.appointmentId, gatewayRefundId, reason: `Booking ${input.ref} cancelled: ${input.reason}`, actorUserId: input.actorUserId, ip: input.ip,
      });
    } catch (err) {
      console.error(`[payments] refund for cancelled ${input.ref} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  },
};
