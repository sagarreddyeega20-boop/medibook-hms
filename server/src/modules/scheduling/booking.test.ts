/**
 * Patients, scheduling and reception: booking race (reception vs patient portal), holds, cancel/reschedule,
 * check-in, walk-ins, duplicate detection, calculated doctor status and live Socket.IO updates.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { isUniqueViolation } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { initSocket } from '../../lib/socket.js';
import { addDays, atLocalMinute, localDateKey } from '../../lib/time.js';
import { captureNotifications, cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, trackUser, type Fixture } from '../../test/helpers.js';
import { socketRooms } from '../auth/socket.js';
import { calculateStatus } from '../reception/reception.service.js';

const app = createApp();
let notes: ReturnType<typeof captureNotifications>;

let doctor: Fixture;
let reception1: string; // cookies
let reception2: string;
let adminCookie: string;
let patientCookie: string;
let patientId: string;
let otherPatientId: string;
const extraPatientIds: string[] = [];

const futureDate = addDays(localDateKey(), 3);
const slotAt = (minute: number, date = futureDate) => atLocalMinute(date, minute).toISOString();

async function makePatient(withAccount: boolean) {
  const t = tag();
  let userId: string | undefined;
  if (withAccount) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'PATIENT' } });
    const u = await prisma.user.create({ data: { email: `p-${t}@test.medibook.local`, roles: { create: { roleId: role.id } } } });
    trackUser(u.id);
    userId = u.id;
  }
  const p = await prisma.patient.create({
    data: { mrn: `T-${t}`, userId, firstName: 'Test', lastName: `Patient ${t}`, gender: 'FEMALE', dateOfBirth: new Date('1990-01-01T00:00:00Z'), phone: `+91 90000 ${t.slice(0, 5).replace(/\D/g, '1').padEnd(5, '1')}`, email: `p-${t}@test.medibook.local` },
  });
  extraPatientIds.push(p.id);
  return { patient: p, userId };
}

/** hold → book, the same two calls the reception screen, patient portal and chatbot make. */
async function holdAndBook(cookie: string, slotStart: string, pid: string) {
  const hold = await request(app).post('/api/scheduling/holds').set('Cookie', cookie).send({ doctorId: doctor.staffId, slotStart });
  if (hold.status !== 201) return hold;
  return request(app).post('/api/scheduling/appointments').set('Cookie', cookie).send({ holdId: hold.body.hold.holdId, patientId: pid, reason: 'Test' });
}

beforeAll(async () => {
  await setupInfra();
  doctor = await createStaff('DOCTOR');
  const gen = await prisma.department.findUniqueOrThrow({ where: { code: 'GEN' } });
  await prisma.staff.update({ where: { id: doctor.staffId }, data: { departmentId: gen.id, specialty: 'Test medicine' } });
  // Open every day, all day, 15-minute slots — so tests never depend on the clock.
  await prisma.doctorSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: doctor.staffId, dayOfWeek, startMinute: 0, endMinute: 1440, slotMinutes: 15 })) });

  const [r1, r2, admin] = [await createStaff('RECEPTIONIST'), await createStaff('RECEPTIONIST'), await createStaff('ADMIN')];
  reception1 = await sessionCookieFor(r1.userId);
  reception2 = await sessionCookieFor(r2.userId);
  adminCookie = await sessionCookieFor(admin.userId);

  const p = await makePatient(true);
  patientId = p.patient.id;
  patientCookie = await sessionCookieFor(p.userId!, 'PATIENT');
  otherPatientId = (await makePatient(false)).patient.id;
});

beforeEach(() => {
  notes = captureNotifications();
});

afterAll(async () => {
  const keys = await redis.keys(`hold:slot:${doctor.staffId}:*`);
  if (keys.length) await redis.del(...keys);
  await prisma.queueEvent.deleteMany({ where: { doctorId: doctor.staffId } });
  await prisma.charge.deleteMany({ where: { visit: { doctorId: doctor.staffId } } }); // consultation charges from finished visits
  await prisma.visit.deleteMany({ where: { doctorId: doctor.staffId } });
  await prisma.appointment.updateMany({ where: { doctorId: doctor.staffId }, data: { rescheduledFromId: null } });
  await prisma.appointment.deleteMany({ where: { doctorId: doctor.staffId } });
  await prisma.auditLog.deleteMany({ where: { patientId: { in: extraPatientIds } } });
  await prisma.patient.deleteMany({ where: { id: { in: extraPatientIds }, userId: null } });
  await cleanupFixtures();
});

describe('double-booking protection', () => {
  it('reception and the patient portal booking the same slot at the same moment: only one succeeds', async () => {
    const slot = slotAt(9 * 60);
    const [fromReception, fromPortal] = await Promise.all([holdAndBook(reception1, slot, otherPatientId), holdAndBook(patientCookie, slot, patientId)]);
    const statuses = [fromReception.status, fromPortal.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = fromReception.status === 409 ? fromReception : fromPortal;
    expect(['SLOT_HELD', 'SLOT_TAKEN']).toContain(loser.body.error.code);
    expect(await prisma.appointment.count({ where: { doctorId: doctor.staffId, slotStart: new Date(slot), status: { not: 'CANCELLED' } } })).toBe(1);

    // Trying again once it is booked is refused too.
    const again = await holdAndBook(reception2, slot, otherPatientId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SLOT_TAKEN');
  });

  it('many simultaneous attempts still produce exactly one appointment', async () => {
    const slot = slotAt(9 * 60 + 15);
    const results = await Promise.all([
      holdAndBook(reception1, slot, otherPatientId),
      holdAndBook(reception2, slot, otherPatientId),
      holdAndBook(patientCookie, slot, patientId),
      holdAndBook(adminCookie, slot, otherPatientId), // admin has no booking permission
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.appointment.count({ where: { doctorId: doctor.staffId, slotStart: new Date(slot), status: { not: 'CANCELLED' } } })).toBe(1);
  });

  it('the database index refuses a second active appointment even if Redis is bypassed', async () => {
    const slotStart = new Date(slotAt(9 * 60 + 30));
    const dept = await prisma.department.findUniqueOrThrow({ where: { code: 'GEN' } });
    const row = (ref: string, pid: string) =>
      prisma.appointment.create({ data: { ref, patientId: pid, doctorId: doctor.staffId, departmentId: dept.id, slotStart, slotEnd: new Date(slotStart.getTime() + 900_000) } });
    const t = tag();
    const results = await Promise.allSettled([row(`APT-T${t}1`, patientId), row(`APT-T${t}2`, otherPatientId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isUniqueViolation(rejected.reason)).toBe(true);

    // Cancelled rows don't count: after cancelling, the slot can be booked again.
    await prisma.appointment.updateMany({ where: { doctorId: doctor.staffId, slotStart }, data: { status: 'CANCELLED' } });
    await expect(row(`APT-T${t}3`, otherPatientId)).resolves.toBeTruthy();
  });

  it('a hold blocks others for 10 minutes, and only its owner can confirm it', async () => {
    const slot = slotAt(10 * 60);
    const hold = await request(app).post('/api/scheduling/holds').set('Cookie', reception1).send({ doctorId: doctor.staffId, slotStart: slot });
    expect(hold.status).toBe(201);
    expect(hold.body.hold.holdSeconds).toBe(600);
    const ttl = await redis.ttl(`hold:slot:${doctor.staffId}:${slot}`);
    expect(ttl).toBeGreaterThan(590);

    const other = await request(app).post('/api/scheduling/holds').set('Cookie', patientCookie).send({ doctorId: doctor.staffId, slotStart: slot });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('SLOT_HELD');

    const stolen = await request(app).post('/api/scheduling/appointments').set('Cookie', reception2).send({ holdId: hold.body.hold.holdId, patientId: otherPatientId });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('HOLD_EXPIRED');

    await request(app).delete(`/api/scheduling/holds/${hold.body.hold.holdId}`).set('Cookie', reception1).expect(204);
    const now = await request(app).post('/api/scheduling/holds').set('Cookie', patientCookie).send({ doctorId: doctor.staffId, slotStart: slot });
    expect(now.status).toBe(201);
    await request(app).delete(`/api/scheduling/holds/${now.body.hold.holdId}`).set('Cookie', patientCookie).expect(204);
  });

  it('refuses times outside the schedule and slots in the past', async () => {
    const off = await request(app).post('/api/scheduling/holds').set('Cookie', reception1).send({ doctorId: doctor.staffId, slotStart: atLocalMinute(futureDate, 9 * 60 + 7).toISOString() });
    expect(off.body.error.code).toBe('SLOT_INVALID');
    const past = await request(app).post('/api/scheduling/holds').set('Cookie', reception1).send({ doctorId: doctor.staffId, slotStart: atLocalMinute(addDays(localDateKey(), -1), 600).toISOString() });
    expect(past.body.error.code).toBe('SLOT_PAST');
  });
});

describe('cancel and reschedule', () => {
  it('patients book for themselves, cancel with a reason, and the slot frees up; emails and audit are written', async () => {
    const slot = slotAt(11 * 60);
    const booked = await holdAndBook(patientCookie, slot, patientId);
    expect(booked.status).toBe(201);
    const appt = booked.body.appointment;
    expect(appt.ref).toMatch(/^APT-\d{6}$/);
    expect(appt.source).toBe('ONLINE');
    await vi.waitFor(() => expect(notes.spy.mock.calls.some((c) => c[1] === 'appointment-booked')).toBe(true)); // sent after the response

    // Cannot book for an unrelated patient.
    const notMine = await holdAndBook(patientCookie, slotAt(11 * 60 + 15), otherPatientId);
    expect(notMine.status).toBe(403);

    const noReason = await request(app).post(`/api/scheduling/appointments/${appt.id}/cancel`).set('Cookie', patientCookie).send({ reason: '' });
    expect(noReason.status).toBe(400);
    const cancelled = await request(app).post(`/api/scheduling/appointments/${appt.id}/cancel`).set('Cookie', patientCookie).send({ reason: 'Feeling better' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.appointment.status).toBe('CANCELLED');
    expect(cancelled.body.appointment.cancelReason).toBe('Feeling better');
    await vi.waitFor(() => expect(notes.spy.mock.calls.some((c) => c[1] === 'appointment-cancelled')).toBe(true));

    const rebook = await holdAndBook(reception1, slot, otherPatientId);
    expect(rebook.status).toBe(201);

    const audit = await prisma.auditLog.findMany({ where: { entityId: { in: [appt.id, rebook.body.appointment.id] } }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(['APPOINTMENT_BOOKED', 'APPOINTMENT_BOOKED', 'APPOINTMENT_CANCELLED']);
  });

  it('reschedule cancels the old booking and links the new one to it', async () => {
    const first = await holdAndBook(reception1, slotAt(12 * 60), otherPatientId);
    const hold = await request(app).post('/api/scheduling/holds').set('Cookie', reception1).send({ doctorId: doctor.staffId, slotStart: slotAt(12 * 60 + 30) });
    const moved = await request(app).post(`/api/scheduling/appointments/${first.body.appointment.id}/reschedule`).set('Cookie', reception1).send({ holdId: hold.body.hold.holdId });
    expect(moved.status).toBe(200);
    expect(moved.body.appointment.rescheduledFromId).toBe(first.body.appointment.id);
    const old = await prisma.appointment.findUniqueOrThrow({ where: { id: first.body.appointment.id } });
    expect(old.status).toBe('CANCELLED');
    expect(old.cancelReason).toBe(`Rescheduled to ${moved.body.appointment.ref}`);
    await vi.waitFor(() => expect(notes.spy.mock.calls.some((c) => c[1] === 'appointment-rescheduled')).toBe(true));
    expect(await prisma.auditLog.count({ where: { action: 'APPOINTMENT_RESCHEDULED', entityId: moved.body.appointment.id } })).toBe(1);
  });

  it('the chatbot can look a booking up by its ref, but never someone else’s', async () => {
    const b = await holdAndBook(reception1, slotAt(13 * 60), otherPatientId);
    const ref = b.body.appointment.ref;
    expect((await request(app).get(`/api/scheduling/appointments/by-ref/${ref}`).set('Cookie', reception2)).status).toBe(200);
    expect((await request(app).get(`/api/scheduling/appointments/by-ref/${ref}`).set('Cookie', patientCookie)).status).toBe(404);
  });
});

describe('check-in, walk-ins and the queue', () => {
  let nth = 0;
  async function todaysAppointment(pid: string) {
    // Inserted directly (a slot already started today) so the test doesn't depend on the clock.
    const dept = await prisma.department.findUniqueOrThrow({ where: { code: 'GEN' } });
    nth += 1;
    const start = new Date(Math.floor(Date.now() / 900_000) * 900_000 - nth * 900_000);
    if (localDateKey(start) !== localDateKey()) start.setTime(atLocalMinute(localDateKey(), 0).getTime() + 300_000 * nth);
    return prisma.appointment.create({ data: { ref: `APT-T${tag()}`, patientId: pid, doctorId: doctor.staffId, departmentId: dept.id, slotStart: start, slotEnd: new Date(start.getTime() + 900_000) } });
  }

  it('check-in creates an OPD visit with a queue token; walk-ins get the next token and no appointment', async () => {
    const appt = await todaysAppointment(patientId);
    const checkIn = await request(app).post('/api/reception/check-in').set('Cookie', reception1).send({ appointmentId: appt.id });
    expect(checkIn.status).toBe(201);
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: checkIn.body.visit.id } });
    expect(visit.type).toBe('OPD');
    expect(visit.appointmentId).toBe(appt.id);
    expect(visit.tokenNumber).toBeGreaterThan(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('CHECKED_IN');

    const twice = await request(app).post('/api/reception/check-in').set('Cookie', reception2).send({ appointmentId: appt.id });
    expect(twice.status).toBe(409);

    const walkIn = await request(app).post('/api/reception/walk-ins').set('Cookie', reception1).send({ patientId: otherPatientId, doctorId: doctor.staffId, complaint: 'Fever' });
    expect(walkIn.status).toBe(201);
    expect(walkIn.body.token).toBe(visit.tokenNumber! + 1);
    const w = await prisma.visit.findUniqueOrThrow({ where: { id: walkIn.body.visit.id } });
    expect(w.type).toBe('WALK_IN');
    expect(w.appointmentId).toBeNull();
    expect(await prisma.appointment.count({ where: { patientId: otherPatientId, doctorId: doctor.staffId, createdAt: { gte: w.createdAt } } })).toBe(0);
    expect(await prisma.queueEvent.count({ where: { visitId: w.id, type: 'TOKEN_ISSUED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: { in: [visit.id, w.id] }, action: { in: ['CHECKED_IN', 'WALK_IN_REGISTERED'] } } })).toBe(2);

    // Calling a patient in puts the doctor IN_CONSULTATION on the board.
    await request(app).post(`/api/reception/visits/${visit.id}/call`).set('Cookie', reception1).expect(200);
    const busy = await request(app).post(`/api/reception/visits/${w.id}/call`).set('Cookie', reception1);
    expect(busy.body.error.code).toBe('DOCTOR_BUSY');
    const board = await request(app).get('/api/reception/board').set('Cookie', reception1);
    const me = board.body.doctors.find((d: { id: string }) => d.id === doctor.staffId);
    expect(['IN_CONSULTATION', 'RUNNING_LATE']).toContain(me.status);
    expect(me.current.token).toBe(visit.tokenNumber);
    expect(me.queue.map((q: { visitId: string }) => q.visitId)).toContain(w.id);
    await request(app).post(`/api/reception/visits/${visit.id}/finish`).set('Cookie', reception1).expect(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe('COMPLETED');
    await request(app).post(`/api/reception/visits/${w.id}/call`).set('Cookie', reception1).expect(200);
    await request(app).post(`/api/reception/visits/${w.id}/finish`).set('Cookie', reception1).expect(200);
  });

  it('only reception can check patients in', async () => {
    const appt = await todaysAppointment(otherPatientId);
    expect((await request(app).post('/api/reception/check-in').set('Cookie', patientCookie).send({ appointmentId: appt.id })).status).toBe(403);
    expect((await request(app).post('/api/reception/check-in').set('Cookie', adminCookie).send({ appointmentId: appt.id })).status).toBe(403);
  });
});

describe('calculated doctor status', () => {
  const now = new Date('2026-11-13T06:00:00Z');
  const base = { onLeave: false, onDuty: true, inConsultation: false, oldestWaitingSlotStart: null, now };
  it('derives the status from schedule, leave, open visits and queue delay', () => {
    expect(calculateStatus({ ...base, onDuty: false }).status).toBe('OFF_DUTY');
    expect(calculateStatus({ ...base, onLeave: true, inConsultation: true }).status).toBe('ON_LEAVE');
    expect(calculateStatus(base).status).toBe('AVAILABLE');
    expect(calculateStatus({ ...base, inConsultation: true }).status).toBe('IN_CONSULTATION');
    expect(calculateStatus({ ...base, oldestWaitingSlotStart: new Date(now.getTime() - 15 * 60_000) }).status).toBe('AVAILABLE');
    const late = calculateStatus({ ...base, inConsultation: true, oldestWaitingSlotStart: new Date(now.getTime() - 22 * 60_000) });
    expect(late).toEqual({ status: 'RUNNING_LATE', lateByMinutes: 22 });
  });
});

describe('patients: search, duplicate detection, family', () => {
  it('warns on same name + date of birth + phone, and registers when reception confirms it is a different person', async () => {
    const t = tag();
    const body = { fullName: `Asha Dup${t}`, gender: 'FEMALE', dateOfBirth: '1992-05-17', phone: '+91 91234 56789' };
    const first = await request(app).post('/api/patients').set('Cookie', reception1).send(body);
    expect(first.status).toBe(201);
    extraPatientIds.push(first.body.patient.id);
    expect(first.body.patient.mrn).toMatch(/^MB-\d{4}-\d{6}$/);

    // Same person typed differently: case and phone formatting don't matter.
    const dup = await request(app).post('/api/patients').set('Cookie', reception2).send({ ...body, fullName: `asha DUP${t}`, phone: '9123456789' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PATIENT');
    expect(dup.body.error.details.matches[0].id).toBe(first.body.patient.id);

    const live = await request(app).post('/api/patients/duplicates').set('Cookie', reception2).send(body);
    expect(live.body.matches).toHaveLength(1);

    const forced = await request(app).post('/api/patients').set('Cookie', reception2).send({ ...body, confirmNotDuplicate: true });
    expect(forced.status).toBe(201);
    extraPatientIds.push(forced.body.patient.id);
    expect(await prisma.auditLog.count({ where: { action: 'PATIENT_REGISTERED', entityId: forced.body.patient.id } })).toBe(1);

    for (const q of [first.body.patient.mrn, `Dup${t}`, '56789']) {
      const found = await request(app).get('/api/patients/search').query({ q }).set('Cookie', reception1);
      expect(found.body.patients.map((p: { id: string }) => p.id)).toContain(first.body.patient.id);
    }
    expect((await request(app).get('/api/patients/search').query({ q: 'asha' }).set('Cookie', patientCookie)).status).toBe(403);
  });

  it('family members are linked to one account, which can book for them', async () => {
    const added = await request(app).post('/api/patients/me/family').set('Cookie', patientCookie).send({ fullName: 'Kid Test', gender: 'MALE', dateOfBirth: '2018-02-02', relationship: 'Son' });
    expect(added.status).toBe(201);
    extraPatientIds.push(added.body.member.patient.id);
    const household = await request(app).get('/api/patients/me/family').set('Cookie', patientCookie);
    expect(household.body.household.map((h: { relationship: string }) => h.relationship)).toEqual(['Self', 'Son']);

    const booked = await holdAndBook(patientCookie, slotAt(14 * 60), added.body.member.patient.id);
    expect(booked.status).toBe(201);
    const mine = await request(app).get('/api/scheduling/appointments/mine').set('Cookie', patientCookie);
    expect(mine.body.appointments.map((a: { id: string }) => a.id)).toContain(booked.body.appointment.id);

    // Reception links an existing patient to an account.
    const link = await request(app).post(`/api/patients/${patientId}/family`).set('Cookie', reception1).send({ memberPatientId: otherPatientId, relationship: 'Spouse' });
    expect(link.status).toBe(201);
    const dupLink = await request(app).post(`/api/patients/${patientId}/family`).set('Cookie', reception1).send({ memberPatientId: otherPatientId, relationship: 'Spouse' });
    expect(dupLink.status).toBe(409);
  });
});

describe('live updates (Socket.IO)', () => {
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    server = createServer(app);
    initSocket(server, socketRooms);
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await new Promise((r) => server.close(r));
  });

  const connect = (cookie: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = ioClient(url, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, forceNew: true });
      sockets.push(s);
      s.on('ready', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket did not become ready')), 5000);
    });

  it('two receptionists both see a booking within a second', async () => {
    const [a, b] = await Promise.all([connect(reception1), connect(reception2)]);
    const seen = (s: Socket) =>
      new Promise<{ doctorId: string; kind: string; ms: number }>((resolve) => {
        const t0 = Date.now();
        s.on('board:changed', (e: { doctorId: string; kind: string }) => {
          if (e.doctorId === doctor.staffId && e.kind === 'booked') resolve({ ...e, ms: Date.now() - t0 });
        });
      });
    const waits = [seen(a), seen(b)];
    const booked = await holdAndBook(patientCookie, slotAt(15 * 60), patientId);
    expect(booked.status).toBe(201);
    const [ea, eb] = await Promise.all(waits);
    expect(ea.ms).toBeLessThan(1000);
    expect(eb.ms).toBeLessThan(1000);
  });

  it('patients get slot updates but never join the reception room; anonymous sockets are refused', async () => {
    const p = await connect(patientCookie);
    let leaked = false;
    p.on('board:changed', () => (leaked = true));
    const slotsChanged = new Promise((resolve) => p.on('slots:changed', resolve));
    await holdAndBook(reception1, slotAt(15 * 60 + 15), otherPatientId);
    await slotsChanged;
    expect(leaked).toBe(false);

    await expect(
      new Promise((resolve, reject) => {
        const s = ioClient(url, { transports: ['websocket'], forceNew: true });
        sockets.push(s);
        s.on('ready', () => reject(new Error('anonymous socket was accepted')));
        s.on('disconnect', () => resolve('disconnected'));
        s.on('unauthorized', () => resolve('refused'));
      }),
    ).resolves.toBeDefined();
  });
});
