/**
 * Online prepayment of the consultation: hold → order → simulated gateway → signed webhook.
 *  - a failed attempt followed by a successful one records exactly ONE payment and books once (retries are idempotent,
 *    duplicate webhooks are ignored, forged ones refused, card numbers never accepted);
 *  - no double charging: at the visit the prepaid consultation stays one paid line; tests are added to the same bill;
 *  - cancelling a prepaid booking refunds it at once (REFUNDED, audited, visible to accounts);
 *  - a hold that expires before payment gives "Slot expired, pick another time".
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { addDays, atLocalMinute, localDateKey } from '../../lib/time.js';
import { removeUpload, UPLOAD_ROOT } from '../../lib/uploads.js';
import { captureNotifications, cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, trackUser, type Fixture } from '../../test/helpers.js';
import { signWebhook } from './provider.js';

const app = createApp();
const cookie: Record<string, string> = {};
const api = (who: string) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookie[who]!),
  post: (url: string, body: object = {}) => request(app).post(url).set('Cookie', cookie[who]!).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('Cookie', cookie[who]!).send(body),
});
const key = () => `test-${tag()}${tag()}${tag()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

let doctor: Fixture;
let patientId: string;
const later = addDays(localDateKey(), 2);
let minute = 8 * 60;
const nextSlot = () => atLocalMinute(later, (minute += 15)).toISOString();

const UPI_OK = { method: 'UPI', provider: 'Google Pay', upiId: 'rahul@okicici' };

async function holdSlot() {
  const r = await api('patient').post('/api/scheduling/holds', { doctorId: doctor.staffId, slotStart: nextSlot() });
  expect(r.status).toBe(201);
  return r.body.hold.holdId as string;
}

async function newOrder(holdId: string, idempotencyKey = key()) {
  const r = await api('patient').post('/api/payments/orders', { holdId, patientId, idempotencyKey });
  expect(r.status).toBe(201);
  return r.body.order as { id: string; status: string; amountPaise: number };
}

/** Polls the order until the gateway webhook has settled it. */
async function settled(orderId: string) {
  for (let i = 0; i < 200; i++) {
    const o = (await api('patient').get(`/api/payments/orders/${orderId}`)).body.order;
    if (o.status !== 'PROCESSING') return o;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('payment never settled');
}

async function payAndSettle(orderId: string, instrument: object = UPI_OK) {
  const r = await api('patient').post(`/api/payments/orders/${orderId}/pay`, { idempotencyKey: key(), instrument });
  expect(r.status).toBe(200);
  return settled(orderId);
}

const onlinePayments = () => prisma.payment.count({ where: { patientId, channel: 'ONLINE' } });

beforeAll(async () => {
  await setupInfra();
  captureNotifications();
  doctor = await createStaff('DOCTOR', { department: 'CARD', name: 'Dr. Prepaid Cardio' });
  await prisma.doctorSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: doctor.staffId, dayOfWeek, startMinute: 0, endMinute: 1440, slotMinutes: 15 })) });
  const lab = await createStaff('LAB_TECH', { department: 'LAB' });
  const reception = await createStaff('RECEPTIONIST', { department: 'FRONT' });
  const accounts = await createStaff('ACCOUNTS', { department: 'BILL' });
  for (const [k, f] of Object.entries({ doctor, lab, reception, accounts })) cookie[k] = await sessionCookieFor(f.userId);

  const t = tag();
  const patientRole = await prisma.role.findUniqueOrThrow({ where: { code: 'PATIENT' } });
  const user = await prisma.user.create({
    data: {
      email: `t-${t}-prepaid@test.medibook.local`,
      roles: { create: { roleId: patientRole.id } },
      patient: { create: { mrn: `T-${t}`, firstName: 'Prepaid', lastName: `Patient ${t}`, gender: 'FEMALE', dateOfBirth: new Date('1988-08-08T00:00:00Z') } },
    },
    include: { patient: true },
  });
  trackUser(user.id);
  patientId = user.patient!.id;
  cookie.patient = await sessionCookieFor(user.id, 'PATIENT');
});

afterAll(async () => {
  const keys = await redis.keys(`hold:slot:${doctor.staffId}:*`);
  if (keys.length) await redis.del(...keys);
  await prisma.onlinePaymentOrder.deleteMany({ where: { patientId } });
  await prisma.refund.deleteMany({ where: { payment: { patientId } } });
  await prisma.payment.deleteMany({ where: { patientId } });
  await prisma.invoice.deleteMany({ where: { patientId } });
  await prisma.charge.deleteMany({ where: { OR: [{ visit: { patientId } }, { appointment: { patientId } }] } });
  const results = await prisma.orderResult.findMany({ where: { order: { patientId } }, select: { id: true } });
  const files = await readdir(path.join(UPLOAD_ROOT, 'results')).catch(() => [] as string[]);
  for (const r of results) for (const f of files.filter((n) => n.startsWith(r.id))) await removeUpload(path.join(UPLOAD_ROOT, 'results', f));
  await prisma.orderResult.deleteMany({ where: { order: { patientId } } });
  await prisma.order.deleteMany({ where: { patientId } });
  await prisma.queueEvent.deleteMany({ where: { patientId } });
  await prisma.visit.deleteMany({ where: { patientId } });
  await prisma.appointment.updateMany({ where: { patientId }, data: { rescheduledFromId: null } });
  await prisma.appointment.deleteMany({ where: { patientId } });
  await prisma.auditLog.deleteMany({ where: { patientId } });
  await cleanupFixtures();
});

let paidAppointmentId: string;
let paidAmount: number;

describe('online prepayment: exactly one payment', () => {
  it('a failed payment followed by a successful one books once and records exactly one payment', async () => {
    const holdId = await holdSlot();
    const checkout = (await api('patient').get(`/api/payments/checkout?holdId=${holdId}&patientId=${patientId}`)).body.checkout;
    expect(checkout.fee.amountPaise).toBeGreaterThan(0); // the cardiology consultation price from the service catalogue

    const k = key();
    const order = await newOrder(holdId, k);
    expect(order).toMatchObject({ status: 'CREATED', amountPaise: checkout.fee.amountPaise });
    expect((await newOrder(holdId, k)).id).toBe(order.id); // same key → same order

    // Attempt 1: UPI fail@upi → declined. The retried request (same key) is the same attempt.
    const attempt = key();
    const first = await api('patient').post(`/api/payments/orders/${order.id}/pay`, { idempotencyKey: attempt, instrument: { method: 'UPI', provider: 'UPI ID', upiId: 'fail@upi' } });
    expect(first.body.order.status).toBe('PROCESSING');
    const replay = await api('patient').post(`/api/payments/orders/${order.id}/pay`, { idempotencyKey: attempt, instrument: { method: 'UPI', provider: 'UPI ID', upiId: 'fail@upi' } });
    expect(replay.status).toBe(200);
    const failed = await settled(order.id);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, appointment: null });
    expect(failed.failureReason).toMatch(/declined/);
    expect(failed.holdExpiresAt).not.toBeNull(); // the hold keeps running

    // Attempt 2: card ending 0002 → declined. Card numbers are never accepted, only brand + last 4.
    expect((await api('patient').post(`/api/payments/orders/${order.id}/pay`, { idempotencyKey: key(), instrument: { method: 'CARD', provider: 'Visa', last4: '0002', cardNumber: '4000000000000002' } })).status).toBe(400);
    expect((await payAndSettle(order.id, { method: 'CARD', provider: 'Visa', last4: '0002' })).status).toBe('FAILED');
    expect(await onlinePayments()).toBe(0);

    // Attempt 3: succeeds.
    const paid = await payAndSettle(order.id);
    expect(paid).toMatchObject({ status: 'PAID', attempts: 3, appointment: { status: 'BOOKED', source: 'ONLINE', payment: 'PAID_ONLINE' } });
    expect(paid.receipt.receiptNumber).toMatch(/^RCPT-/);
    paidAppointmentId = paid.appointment.id;
    paidAmount = paid.amountPaise;

    // Paying again, or a duplicate webhook delivery, changes nothing.
    expect((await api('patient').post(`/api/payments/orders/${order.id}/pay`, { idempotencyKey: key(), instrument: UPI_OK })).body.order.status).toBe('PAID');
    const row = await prisma.onlinePaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    const event = { type: 'payment.captured', providerOrderId: row.providerOrderId, providerPaymentId: row.providerPaymentId!, amountPaise: row.amountPaise };
    expect((await request(app).post('/api/payments/webhook/simulated').set('x-medibook-signature', signWebhook(event)).send(event)).status).toBe(200);
    expect((await request(app).post('/api/payments/webhook/simulated').set('x-medibook-signature', 'ab'.repeat(32)).send(event)).status).toBe(401);

    expect(await onlinePayments()).toBe(1);
    expect(await prisma.appointment.count({ where: { patientId, status: 'BOOKED' } })).toBe(1);
    const pay = await prisma.payment.findFirstOrThrow({ where: { patientId, channel: 'ONLINE' }, include: { allocations: { include: { invoice: true } } } });
    expect(pay).toMatchObject({ method: 'UPI', provider: 'Google Pay', last4: null, amountPaise: paidAmount, status: 'CONFIRMED' });
    expect(pay.allocations).toHaveLength(1);
    expect(pay.allocations[0]!.invoice).toMatchObject({ appointmentId: paidAppointmentId, visitId: null, status: 'PAID', paidPaise: paidAmount, totalPaise: paidAmount });
    expect(await prisma.charge.count({ where: { appointmentId: paidAppointmentId } })).toBe(1);
  });

  it('My appointments and the reception board show the booking as paid online', async () => {
    const mine = (await api('patient').get('/api/scheduling/appointments/mine')).body.appointments;
    expect(mine.find((a: { id: string }) => a.id === paidAppointmentId).payment).toBe('PAID_ONLINE');
    const board = (await api('reception').get(`/api/reception/board?date=${later}`)).body;
    const slot = board.doctors.find((d: { id: string }) => d.id === doctor.staffId).slots.find((s: { appointment?: { id: string } }) => s.appointment?.id === paidAppointmentId);
    expect(slot).toMatchObject({ state: 'BOOKED', payment: 'PAID_ONLINE' });
  });
});

describe('no double charging at the visit', () => {
  it('the prepaid consultation stays one paid line; the counter collects only the tests', async () => {
    // Bring the appointment to today so it can be checked in (the test must not depend on the clock).
    await prisma.appointment.update({ where: { id: paidAppointmentId }, data: { slotStart: new Date(Date.now() + 61_000), slotEnd: new Date(Date.now() + 61_000 + 15 * 60_000) } });
    const ci = await api('reception').post('/api/reception/check-in', { appointmentId: paidAppointmentId });
    expect(ci.status).toBe(201);
    const visitId = ci.body.visit.id as string;
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { appointmentId: paidAppointmentId } });
    expect(inv.visitId).toBe(visitId); // the prepaid bill is now the visit's bill

    await api('doctor').post(`/api/visits/${visitId}/start`).expect(200);
    const cat = (await api('doctor').get('/api/orders/catalogue')).body.items as { id: string; code: string; pricePaise: number }[];
    const ecg = await api('doctor').post('/api/orders/investigations', { visitId, catalogueItemId: cat.find((i) => i.code === 'LAB-ECG')!.id, priority: 'ROUTINE' });
    expect(ecg.status).toBe(201);
    await api('lab').post(`/api/orders/${ecg.body.order.id}/start`).expect(200);
    await api('lab').post(`/api/orders/${ecg.body.order.id}/result`, { summary: 'Normal', isAbnormal: false, file: { name: 'ecg.pdf', base64: PDF.toString('base64') } }).expect(201);
    await api('doctor').post(`/api/visits/${visitId}/complete`).expect(200);

    // Exactly one consultation charge for the visit, and still one bill.
    expect(await prisma.charge.count({ where: { visitId, catalogueItem: { category: 'CONSULTATION' }, status: { not: 'VOID' } } })).toBe(1);
    expect(await prisma.invoice.count({ where: { visitId } })).toBe(1);

    const bill = (await api('reception').get(`/api/billing/invoices/${inv.id}`)).body.invoice;
    const consult = bill.lines.find((l: { department: { code: string } }) => l.department.code === 'CARD');
    const test = bill.lines.find((l: { department: { code: string } }) => l.department.code === 'LAB');
    expect(bill.lines).toHaveLength(2);
    expect(consult).toMatchObject({ paidOnline: true, totalPaise: paidAmount });
    expect(test).toMatchObject({ paidOnline: false, totalPaise: 30000 });
    expect(bill).toMatchObject({ status: 'PARTIALLY_PAID', paidPaise: paidAmount, paidOnlinePaise: paidAmount, balancePaise: 30000 });
    expect(bill.payments).toEqual([expect.objectContaining({ channel: 'ONLINE', amountPaise: paidAmount })]);

    // Counter takings / cash reconciliation never include the online money.
    const recon = (await api('reception').get(`/api/billing/reconciliation?date=${localDateKey()}`)).body;
    const counter = await prisma.payment.aggregate({ where: { channel: 'COUNTER', status: 'CONFIRMED', receivedAt: { gte: atLocalMinute(localDateKey(), 0) } }, _sum: { amountPaise: true } });
    expect(recon.methods.reduce((n: number, m: { receivedPaise: number }) => n + m.receivedPaise, 0)).toBe(counter._sum.amountPaise ?? 0);
  });
});

describe('cancelling a prepaid booking', () => {
  it('refunds it at once (REFUNDED, audited) and accounts sees it', async () => {
    const order = await newOrder(await holdSlot());
    const paid = await payAndSettle(order.id, { method: 'CARD', provider: 'Mastercard', last4: '4444' });
    expect(paid.status).toBe('PAID');
    const apptId = paid.appointment.id as string;
    const since = new Date();

    const c = await api('patient').post(`/api/scheduling/appointments/${apptId}/cancel`, { reason: 'Feeling better' });
    expect(c.status).toBe(200);
    expect(c.body.appointment).toMatchObject({ status: 'CANCELLED', payment: 'REFUNDED' });

    const refund = await prisma.refund.findFirstOrThrow({ where: { payment: { patientId, last4: '4444' } } });
    expect(refund).toMatchObject({ status: 'REFUNDED', amountPaise: paid.amountPaise, method: 'CARD' });
    expect(refund.processedAt).not.toBeNull();
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { appointmentId: apptId } });
    expect(inv).toMatchObject({ status: 'VOID', paidPaise: 0 });
    expect(await prisma.charge.count({ where: { appointmentId: apptId, status: { not: 'VOID' } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'REFUND_PROCESSED', entityId: refund.id, createdAt: { gte: since } } })).toBe(1);

    // Cancelling twice never refunds twice.
    expect((await api('patient').post(`/api/scheduling/appointments/${apptId}/cancel`, { reason: 'Again' })).status).toBe(409);
    expect(await prisma.refund.count({ where: { invoiceId: inv.id } })).toBe(1);

    const dash = (await api('accounts').get(`/api/accounts/dashboard?from=${localDateKey()}&to=${localDateKey()}`)).body;
    expect(dash.refunds.list.find((r: { id: string }) => r.id === refund.id)).toMatchObject({ status: 'REFUNDED', amountPaise: paid.amountPaise });
    expect(dash.refunds.refunded.amountPaise).toBeGreaterThanOrEqual(paid.amountPaise);
    const online = dash.channels.find((c: { channel: string }) => c.channel === 'ONLINE');
    expect(online.amountPaise).toBeGreaterThanOrEqual(paidAmount + paid.amountPaise);
  });
});

describe('hold expiry and pay at hospital', () => {
  it('a hold that expires before payment releases the slot: "Slot expired, pick another time"', async () => {
    const holdId = await holdSlot();
    const order = await newOrder(holdId);
    // Simulate the 10-minute hold running out.
    const keys = await redis.keys(`hold:*`);
    for (const k of keys) if ((await redis.get(k))?.includes(holdId) || k === `hold:id:${holdId}`) await redis.del(k);

    const o = (await api('patient').get(`/api/payments/orders/${order.id}`)).body.order;
    expect(o).toMatchObject({ status: 'EXPIRED', failureReason: 'Slot expired, pick another time.' });
    const pay = await api('patient').post(`/api/payments/orders/${order.id}/pay`, { idempotencyKey: key(), instrument: UPI_OK });
    expect(pay.status).toBe(409);
    expect(pay.body.error).toMatchObject({ code: 'HOLD_EXPIRED', message: 'Slot expired, pick another time.' });
  });

  it('pay at hospital books immediately with no online payment', async () => {
    const holdId = await holdSlot();
    const before = await onlinePayments();
    const b = await api('patient').post('/api/scheduling/appointments', { holdId, patientId });
    expect(b.status).toBe(201);
    expect(b.body.appointment.payment).toBe('PAY_AT_HOSPITAL');
    expect(await onlinePayments()).toBe(before);
  });

  it('only the patient who holds the slot can pay for it', async () => {
    const holdId = await holdSlot();
    expect((await api('reception').post('/api/payments/orders', { holdId, patientId, idempotencyKey: key() })).status).toBe(403);
  });
});
