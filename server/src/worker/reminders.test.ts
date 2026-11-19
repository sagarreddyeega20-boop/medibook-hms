/**
 * Reminder emails run by the worker, on a fake clock:
 *   - 1-hour appointment reminder: exactly one, also across a worker restart and with two workers running;
 *     none for cancelled appointments or ones booked less than an hour ahead.
 *   - referral created → email at once; referral still not booked after 48 hours → one reminder.
 * Emails go through notify() and the notifications table; the mailer is forced to console in tests (no real email).
 * The fake clock runs in 2031 so the jobs never touch the seed data (dated from today).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { mailTransport } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { formatLocal } from '../lib/time.js';
import { schedulingService } from '../modules/scheduling/scheduling.service.js';
import { cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, type Fixture } from '../test/helpers.js';
import { createWorker } from './worker.js';

const app = createApp();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DIAGNOSIS = 'SECRET-DIAGNOSIS-TEXT';

let doctor: Fixture;
let otherDoctor: Fixture;
let patientId: string;
let email: string;
const patientIds: string[] = [];
let T0: Date; // fake "now" at the start of each scenario

const at = (ms: number) => new Date(T0.getTime() + ms);

async function makePatient(first: string) {
  const t = tag();
  const p = await prisma.patient.create({ data: { mrn: `T-${t}`, firstName: first, lastName: `Reminder ${t}`, email: `t-${t}-reminder@test.medibook.local` } });
  patientIds.push(p.id);
  return p;
}

/** Inserts an appointment directly (booking rules are tested elsewhere); `bookedAt` is its created_at. */
async function appointment(doctorId: string, slotStart: Date, bookedAt: Date, status: 'BOOKED' | 'CANCELLED' = 'BOOKED', forPatient = patientId) {
  const dept = await prisma.staff.findUniqueOrThrow({ where: { id: doctorId }, select: { departmentId: true } });
  return prisma.appointment.create({
    data: {
      ref: `APT-T${tag()}`, patientId: forPatient, doctorId, departmentId: dept.departmentId!, slotStart, slotEnd: new Date(slotStart.getTime() + 15 * MIN),
      status, createdAt: bookedAt, ...(status === 'CANCELLED' ? { cancelledAt: bookedAt } : {}),
    },
  });
}

async function emailsTo(to: string, template: string) {
  const rows = await prisma.notification.findMany({ where: { channel: 'EMAIL', recipient: to }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => (r.data as { template?: string } | null)?.template === template);
}

/** A worker on the fake clock: `run(from, to)` ticks once a minute (like the real one). */
function fakeClockWorker(clock: { now: Date }) {
  return createWorker({ clock: () => clock.now });
}

beforeAll(async () => {
  await setupInfra();
  doctor = await createStaff('DOCTOR', { department: 'CARD', name: 'Dr. Reminder Cardio' });
  otherDoctor = await createStaff('DOCTOR', { department: 'NUTR', name: 'Dr. Reminder Nutrition' });
  const p = await makePatient('Asha');
  patientId = p.id;
  email = p.email!;
});

afterAll(async () => {
  const visitIds = (await prisma.visit.findMany({ where: { patientId: { in: patientIds } }, select: { id: true } })).map((v) => v.id);
  const emails = (await prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { email: true } })).map((p) => p.email!);
  await prisma.notification.deleteMany({ where: { recipient: { in: emails } } });
  await prisma.referral.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.appointment.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.order.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.clinicalNote.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visit.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.auditLog.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.patient.deleteMany({ where: { id: { in: patientIds } } });
  await cleanupFixtures();
});

it('tests never send real email', () => {
  expect(mailTransport).toBe('console');
});

describe('appointment reminder, 1 hour before', () => {
  it('booked for 70 minutes from now → exactly one reminder at ~60 minutes before, across a worker restart and two workers', async () => {
    T0 = new Date(Date.UTC(2031, 2, 10, 4, 30) + Math.floor(Math.random() * 1000) * 24 * HOUR); // ~10:00 IST, a random day
    const appt = await appointment(doctor.staffId, at(70 * MIN), T0);
    const clock = { now: T0 };

    // Worker #1 runs from the booking for 8 minutes: the appointment is still more than an hour away.
    let w1 = fakeClockWorker(clock);
    for (let m = 0; m <= 8; m++) {
      clock.now = at(m * MIN);
      await w1.tick();
    }
    expect(await emailsTo(email, 'appointment-reminder')).toHaveLength(0);

    // Restart mid-way, and a second worker joins: both tick every minute until after the appointment.
    await w1.stop();
    w1 = fakeClockWorker(clock);
    const w2 = fakeClockWorker(clock);
    for (let m = 9; m <= 75; m++) {
      clock.now = at(m * MIN);
      await Promise.all([w1.tick(), w2.tick()]);
    }

    const sent = await emailsTo(email, 'appointment-reminder');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe('SENT');
    // First tick inside the hour: 70 − 60 = 10 minutes after booking.
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.reminderSentAt?.toISOString()).toBe(at(10 * MIN).toISOString());

    // Logistics only: doctor, department, time, where, check-in, link.
    const body = sent[0]!.body;
    expect(sent[0]!.subject).toContain('Dr. Reminder Cardio');
    expect(body).toContain('Doctor: Dr. Reminder Cardio');
    expect(body).toContain('Department: Cardiology');
    expect(body).toContain('Where: Cardiology OPD');
    expect(body).toContain(appt.ref);
    expect(body).toMatch(/check in at the reception desk/i);
    expect(body).toContain('View appointment: http://localhost:5173/patient/appointments');
    // 04:30 UTC + 70 min = 11:10 am in Asia/Kolkata.
    expect(body).toContain(`When: ${formatLocal(appt.slotStart)}`);
    expect(formatLocal(appt.slotStart)).toMatch(/11:10\s?am$/i);
  });

  it('a worker that dies after queuing the email but before sending it: the next worker sends it, still once', async () => {
    T0 = new Date(Date.UTC(2031, 5, 1, 5, 0) + Math.floor(Math.random() * 1000) * 24 * HOUR);
    const p = await makePatient('Ravi');
    await appointment(doctor.staffId, at(2 * HOUR), at(-HOUR), 'BOOKED', p.id);

    // "Worker" queues the reminder (job only), then crashes before its outbox pass.
    expect((await schedulingService.sendDueReminders(at(HOUR))).queued).toBe(1);
    const queued = await emailsTo(p.email!, 'appointment-reminder');
    expect(queued.map((r) => r.status)).toEqual(['QUEUED']);

    const clock = { now: at(HOUR + MIN) };
    const w = fakeClockWorker(clock);
    await w.tick();
    clock.now = at(HOUR + 2 * MIN);
    await w.tick();
    const rows = await emailsTo(p.email!, 'appointment-reminder');
    expect(rows.map((r) => r.status)).toEqual(['SENT']);
  });

  it('no reminder for a cancelled appointment, or one booked less than an hour before it starts', async () => {
    T0 = new Date(Date.UTC(2031, 8, 1, 5, 0) + Math.floor(Math.random() * 1000) * 24 * HOUR);
    const cancelledFor = await makePatient('Meena');
    const lateFor = await makePatient('Kiran');
    await appointment(doctor.staffId, at(70 * MIN), T0, 'CANCELLED', cancelledFor.id);
    await appointment(otherDoctor.staffId, at(30 * MIN), T0, 'BOOKED', lateFor.id); // booked 30 minutes ahead

    const clock = { now: T0 };
    const w = fakeClockWorker(clock);
    for (let m = 0; m <= 75; m += 1) {
      clock.now = at(m * MIN);
      await w.tick();
    }
    expect(await emailsTo(cancelledFor.email!, 'appointment-reminder')).toHaveLength(0);
    expect(await emailsTo(lateFor.email!, 'appointment-reminder')).toHaveLength(0);
  });
});

describe('referral emails', () => {
  let orderId: string;
  let nutritionId: string;

  it('creating a referral emails the patient: who referred, where to, the reason and a "Book now" link', async () => {
    const dept = await prisma.staff.findUniqueOrThrow({ where: { id: doctor.staffId }, select: { departmentId: true } });
    nutritionId = (await prisma.department.findUniqueOrThrow({ where: { code: 'NUTR' } })).id;
    const visit = await prisma.visit.create({
      data: { visitNumber: `V-T${tag()}`, patientId, doctorId: doctor.staffId, departmentId: dept.departmentId!, type: 'WALK_IN', status: 'IN_CONSULTATION' },
    });
    await prisma.clinicalNote.create({ data: { visitId: visit.id, authorId: doctor.staffId, diagnosis: DIAGNOSIS, assessment: DIAGNOSIS } });

    const res = await request(app)
      .post('/api/orders/referrals')
      .set('Cookie', await sessionCookieFor(doctor.userId))
      .send({ visitId: visit.id, toDepartmentId: nutritionId, toDoctorId: otherDoctor.staffId, reason: 'Diet plan and weight review', priority: 'ROUTINE' });
    expect(res.status).toBe(201);
    orderId = res.body.order.id;

    let rows = await emailsTo(email, 'referral-created');
    for (let i = 0; i < 50 && rows[0]?.status !== 'SENT'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await emailsTo(email, 'referral-created');
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SENT');
    const body = rows[0]!.body;
    expect(body).toContain('Referred by: Dr. Reminder Cardio');
    expect(body).toContain('Department: Nutrition');
    expect(body).toContain('Doctor: Dr. Reminder Nutrition');
    expect(body).toContain('Reason: Diet plan and weight review');
    expect(body).toContain(`Book now: http://localhost:5173/patient/doctors?referral=${orderId}&department=${nutritionId}&doctor=${otherDoctor.staffId}`);
    expect(body).not.toContain(DIAGNOSIS);
  });

  it('still not booked after 48 hours → one reminder, also across a restart; never before 48 hours', async () => {
    T0 = new Date(Date.UTC(2031, 10, 1, 5, 0) + Math.floor(Math.random() * 1000) * 24 * HOUR);
    await prisma.order.update({ where: { id: orderId }, data: { createdAt: T0 } }); // the referral was made at fake T0

    const clock = { now: at(47 * HOUR + 58 * MIN) };
    let w = fakeClockWorker(clock);
    await w.tick();
    clock.now = at(47 * HOUR + 59 * MIN);
    await w.tick();
    expect(await emailsTo(email, 'referral-reminder')).toHaveLength(0);

    clock.now = at(48 * HOUR);
    await w.tick();
    await w.stop();
    w = fakeClockWorker(clock); // restart
    const w2 = fakeClockWorker(clock);
    for (const h of [48 * HOUR + MIN, 49 * HOUR, 72 * HOUR, 96 * HOUR]) {
      clock.now = at(h);
      await Promise.all([w.tick(), w2.tick()]);
    }

    const rows = await emailsTo(email, 'referral-reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SENT');
    expect(rows[0]!.body).toContain('Referred by: Dr. Reminder Cardio');
    expect(rows[0]!.body).toContain(`/patient/doctors?referral=${orderId}`);
    expect(rows[0]!.body).not.toContain(DIAGNOSIS);
    const ref = await prisma.referral.findUniqueOrThrow({ where: { orderId } });
    expect(ref.reminderSentAt?.toISOString()).toBe(at(48 * HOUR).toISOString());
  });

  it('a booked referral gets no reminder', async () => {
    const p = await makePatient('Lata');
    T0 = new Date(Date.UTC(2032, 0, 1, 5, 0) + Math.floor(Math.random() * 1000) * 24 * HOUR);
    const visit = await prisma.visit.create({
      data: { visitNumber: `V-T${tag()}`, patientId: p.id, doctorId: doctor.staffId, departmentId: nutritionId, type: 'WALK_IN', status: 'COMPLETED' },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-T${tag()}`, visitId: visit.id, patientId: p.id, type: 'REFERRAL', status: 'SCHEDULED', orderingDoctorId: doctor.staffId,
        targetDepartmentId: nutritionId, title: 'Referral to Nutrition', createdAt: T0,
      },
    });
    await prisma.referral.create({ data: { orderId: order.id, patientId: p.id, fromVisitId: visit.id, fromDoctorId: doctor.staffId, toDepartmentId: nutritionId, reason: 'Diet' } });

    const w = fakeClockWorker({ now: at(50 * HOUR) });
    await w.tick();
    expect(await emailsTo(p.email!, 'referral-reminder')).toHaveLength(0);
  });
});
