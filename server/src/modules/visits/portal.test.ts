/**
 * Patient portal: referrals in Upcoming ("Book now" → linked booking), the visit detail page (patient-facing fields only,
 * results only once RESULT_READY), the journey across referrals, and the server-side own-data rule (403 + audit).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { addDays, atLocalMinute, localDateKey } from '../../lib/time.js';
import { captureNotifications, cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, trackUser, type Fixture } from '../../test/helpers.js';

const app = createApp();
let cardio: Fixture;
let nutri: Fixture;
const cookie: Record<string, string> = {};
let patientId: string;
let patientUserId: string;
let otherPatientId: string;
let cardioVisitId: string;
let nutriVisitId: string;
let referralOrderId: string;
let ecgOrderId: string;

const api = (who: string) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookie[who]!),
  post: (url: string, body: object = {}) => request(app).post(url).set('Cookie', cookie[who]!).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('Cookie', cookie[who]!).send(body),
});

async function patientUser(first: string) {
  const t = tag();
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'PATIENT' } });
  const user = await prisma.user.create({
    data: {
      email: `t-${t}-portal@test.medibook.local`,
      roles: { create: { roleId: role.id } },
      patient: { create: { mrn: `T-${t}`, firstName: first, lastName: `Portal ${t}`, gender: 'MALE', dateOfBirth: new Date('1970-05-10T00:00:00Z') } },
    },
    include: { patient: true },
  });
  trackUser(user.id);
  return { userId: user.id, patientId: user.patient!.id };
}

beforeAll(async () => {
  await setupInfra();
  captureNotifications();
  cardio = await createStaff('DOCTOR', { department: 'CARD', name: 'Dr. Portal Cardio' });
  nutri = await createStaff('DOCTOR', { department: 'NUTR', name: 'Dr. Portal Nutrition' });
  const lab = await createStaff('LAB_TECH', { department: 'LAB' });
  const reception = await createStaff('RECEPTIONIST');
  await prisma.doctorSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: nutri.staffId, dayOfWeek, startMinute: 0, endMinute: 1440, slotMinutes: 30 })) });
  for (const [k, f] of Object.entries({ cardio, nutri, lab, reception })) cookie[k] = await sessionCookieFor(f.userId);

  const me = await patientUser('Journey');
  patientId = me.patientId;
  patientUserId = me.userId;
  cookie.patient = await sessionCookieFor(me.userId, 'PATIENT');
  const other = await patientUser('Other');
  otherPatientId = other.patientId;
  cookie.other = await sessionCookieFor(other.userId, 'PATIENT');
});

afterAll(async () => {
  const keys = await redis.keys(`hold:slot:${nutri.staffId}:*`);
  if (keys.length) await redis.del(...keys);
  const ids = [patientId, otherPatientId];
  const visitIds = (await prisma.visit.findMany({ where: { patientId: { in: ids } }, select: { id: true } })).map((v) => v.id);
  await prisma.invoiceLine.deleteMany({ where: { invoice: { patientId: { in: ids } } } });
  await prisma.invoice.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.charge.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.prescription.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.referral.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.queueEvent.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.appointment.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.orderResult.deleteMany({ where: { order: { patientId: { in: ids } } } });
  await prisma.order.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.visit.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { data: { path: ['patientId'], equals: patientId } } });
  await prisma.auditLog.deleteMany({ where: { patientId: { in: ids } } });
  await prisma.doctorSchedule.deleteMany({ where: { doctorId: nutri.staffId } });
  await cleanupFixtures();
});

describe('cardiology visit: notes, ECG, referral to nutrition, prescription', () => {
  it('the cardiologist sees a walk-in and records everything', async () => {
    const w = await api('reception').post('/api/reception/walk-ins', { patientId, doctorId: cardio.staffId, complaint: 'Chest pain on exertion' });
    expect(w.status).toBe(201);
    cardioVisitId = w.body.visit.id;
    await api('cardio').post(`/api/visits/${cardioVisitId}/start`).expect(200);
    await api('cardio').put(`/api/visits/${cardioVisitId}/notes`, {
      complaint: 'INTERNAL-COMPLAINT pain 2 weeks', findings: 'INTERNAL-FINDINGS BP 150/95', diagnosis: 'Stable angina', advice: 'Low-fat diet, walk 30 min daily',
    }).expect(200);
    const { body: cat } = await api('cardio').get('/api/orders/catalogue?type=LAB');
    const ecg = cat.items.find((i: { code: string }) => i.code === 'LAB-ECG');
    const o = await api('cardio').post('/api/orders/investigations', { visitId: cardioVisitId, catalogueItemId: ecg.id, priority: 'ROUTINE', notes: 'INTERNAL-INDICATION rule out ischaemia' });
    expect(o.status).toBe(201);
    ecgOrderId = o.body.order.id;
    const nutr = await prisma.department.findUniqueOrThrow({ where: { code: 'NUTR' } });
    const ref = await api('cardio').post('/api/orders/referrals', { visitId: cardioVisitId, toDepartmentId: nutr.id, reason: 'Cardiac diet plan', priority: 'ROUTINE' });
    expect(ref.status).toBe(201);
    referralOrderId = ref.body.order.id;
    await api('cardio').post('/api/orders/prescriptions', {
      visitId: cardioVisitId, notes: 'INTERNAL-RX-NOTE', items: [{ medicineName: 'Atorvastatin 10 mg', dose: '1 tablet', frequency: '0-0-1', durationDays: 30, instructions: 'After dinner' }],
    }).expect(201);
    await api('cardio').post(`/api/visits/${cardioVisitId}/complete`).expect(200);
  });
});

describe('A — referral in Upcoming, booked by the patient', () => {
  it('the referral is listed for the patient with the reason, referring doctor and department', async () => {
    const r = await api('patient').get('/api/visits/mine/referrals');
    expect(r.status).toBe(200);
    expect(r.body.referrals).toEqual([
      expect.objectContaining({ orderId: referralOrderId, reason: 'Cardiac diet plan', fromDoctor: expect.objectContaining({ name: 'Dr. Portal Cardio' }), toDepartment: expect.objectContaining({ code: 'NUTR' }), toDoctor: null }),
    ]);
    // another patient never sees it
    expect((await api('other').get('/api/visits/mine/referrals')).body.referrals).toEqual([]);
  });

  it('another patient cannot book my referral', async () => {
    const slotStart = atLocalMinute(addDays(localDateKey(), 1), 9 * 60).toISOString();
    const hold = await api('other').post('/api/scheduling/holds', { doctorId: nutri.staffId, slotStart });
    expect(hold.status).toBe(201);
    const r = await api('other').post('/api/scheduling/appointments', { holdId: hold.body.hold.holdId, patientId: otherPatientId, referralOrderId });
    expect(r.status).toBe(400); // "This referral is for a different patient"
    await request(app).delete(`/api/scheduling/holds/${hold.body.hold.holdId}`).set('Cookie', cookie.other!);
  });

  it('"Book now": the appointment links to the order (source_order_id), the order is SCHEDULED, Upcoming shows "Referred by"', async () => {
    const slotStart = atLocalMinute(addDays(localDateKey(), 1), 10 * 60).toISOString();
    const hold = await api('patient').post('/api/scheduling/holds', { doctorId: nutri.staffId, slotStart });
    expect(hold.status).toBe(201);
    const book = await api('patient').post('/api/scheduling/appointments', { holdId: hold.body.hold.holdId, patientId, referralOrderId });
    expect(book.status).toBe(201);
    expect(book.body.appointment).toMatchObject({ sourceOrderId: referralOrderId, referredBy: { name: 'Dr. Portal Cardio' }, source: 'ONLINE' });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: referralOrderId } });
    expect(order).toMatchObject({ status: 'SCHEDULED', targetDoctorId: nutri.staffId });
    const mine = await api('patient').get('/api/scheduling/appointments/mine');
    expect(mine.body.appointments.find((a: { id: string }) => a.id === book.body.appointment.id)).toMatchObject({ referredBy: { name: 'Dr. Portal Cardio' } });
    expect((await api('patient').get('/api/visits/mine/referrals')).body.referrals).toEqual([]);
  });
});

describe('B — visit detail: patient-facing fields only, results only when ready', () => {
  it('before the lab reports, the ECG shows its status but no result', async () => {
    const r = await api('patient').get(`/api/visits/mine/${cardioVisitId}`);
    expect(r.status).toBe(200);
    const ecg = r.body.tests.find((t: { id: string }) => t.id === ecgOrderId);
    expect(ecg).toMatchObject({ status: 'ORDERED', results: [] });
  });

  it('a result uploaded but not yet RESULT_READY is still hidden', async () => {
    const lab = await prisma.staff.findFirstOrThrow({ where: { department: { code: 'LAB' } } });
    // simulate a result row on an order that is not RESULT_READY (e.g. mid-correction)
    const row = await prisma.orderResult.create({ data: { orderId: ecgOrderId, reportedById: lab.id, summary: 'DRAFT-RESULT' } });
    const r = await api('patient').get(`/api/visits/mine/${cardioVisitId}`);
    expect(JSON.stringify(r.body)).not.toContain('DRAFT-RESULT');
    await prisma.orderResult.delete({ where: { id: row.id } });
  });

  it('the lab reports the ECG → the patient sees the findings', async () => {
    await api('lab').post(`/api/orders/${ecgOrderId}/start`).expect(200);
    await api('lab').post(`/api/orders/${ecgOrderId}/result`, { summary: 'Sinus rhythm, ST depression V4–V6', isAbnormal: true }).expect(201);
    const r = await api('patient').get(`/api/visits/mine/${cardioVisitId}`);
    expect(r.body.tests.find((t: { id: string }) => t.id === ecgOrderId)).toMatchObject({ status: 'RESULT_READY', results: [expect.objectContaining({ summary: 'Sinus rhythm, ST depression V4–V6', isAbnormal: true })] });
  });

  it('shows doctor, diagnosis, advice, prescription, referral and bill — and nothing internal', async () => {
    const r = await api('patient').get(`/api/visits/mine/${cardioVisitId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      visit: { id: cardioVisitId, doctor: { name: 'Dr. Portal Cardio' }, department: 'Cardiology' },
      diagnosis: 'Stable angina',
      advice: 'Low-fat diet, walk 30 min daily',
      prescriptions: [expect.objectContaining({ prescription: expect.objectContaining({ items: [expect.objectContaining({ medicineName: 'Atorvastatin 10 mg', dose: '1 tablet', frequency: '0-0-1', durationDays: 30, instructions: 'After dinner', dispensed: false })] }) })],
      referrals: [expect.objectContaining({ id: referralOrderId, status: 'SCHEDULED', referral: expect.objectContaining({ reason: 'Cardiac diet plan', toDoctor: expect.objectContaining({ name: 'Dr. Portal Nutrition' }) }) })],
      bill: expect.objectContaining({ totalPaise: expect.any(Number), status: expect.any(String) }),
    });
    const json = JSON.stringify(r.body);
    for (const secret of ['INTERNAL-COMPLAINT', 'INTERNAL-FINDINGS', 'INTERNAL-INDICATION', 'INTERNAL-RX-NOTE']) expect(json).not.toContain(secret);
  });

  it('every view is audited as a VIEW of the visit with the patient id', async () => {
    const views = await prisma.auditLog.findMany({ where: { actorId: patientUserId, action: 'VIEW', entity: 'visits', entityId: cardioVisitId } });
    expect(views.length).toBeGreaterThanOrEqual(4);
    expect(views[0]).toMatchObject({ patientId });
  });
});

describe('C — journey: cardiology → nutrition', () => {
  it('the nutritionist sees the patient and concludes (the booked referral is linked, not an older unbooked one)', async () => {
    // decoy: an older referral to the same nutritionist that was never booked
    const nutr = await prisma.department.findUniqueOrThrow({ where: { code: 'NUTR' } });
    const decoy = await prisma.order.create({
      data: {
        orderNumber: `ORD-T${tag()}`, visitId: cardioVisitId, patientId, type: 'REFERRAL', status: 'ORDERED', orderingDoctorId: cardio.staffId, targetDepartmentId: nutr.id, targetDoctorId: nutri.staffId,
        title: 'Older referral', createdAt: new Date(Date.now() - 86_400_000),
        referral: { create: { patientId, fromVisitId: cardioVisitId, fromDoctorId: cardio.staffId, toDepartmentId: nutr.id, toDoctorId: nutri.staffId, reason: 'Older unbooked referral', createdAt: new Date(Date.now() - 86_400_000) } },
      },
    });
    const w = await api('reception').post('/api/reception/walk-ins', { patientId, doctorId: nutri.staffId });
    expect(w.status).toBe(201);
    nutriVisitId = w.body.visit.id;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: referralOrderId } })).status).toBe('IN_PROGRESS');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: decoy.id } })).status).toBe('ORDERED');
    await prisma.order.delete({ where: { id: decoy.id } });
    await api('nutri').post(`/api/visits/${nutriVisitId}/start`).expect(200);
    await api('nutri').put(`/api/visits/${nutriVisitId}/notes`, { findings: 'INTERNAL-NUTRI-FINDINGS', diagnosis: 'Obesity (BMI 31)', advice: '1600 kcal DASH diet' }).expect(200);
    await api('nutri').post(`/api/visits/${nutriVisitId}/complete`).expect(200);
  });

  it('the cardiology visit shows the journey cardiology → nutrition with the nutritionist’s conclusion', async () => {
    const r = await api('patient').get(`/api/visits/mine/${cardioVisitId}`);
    expect(r.status).toBe(200);
    const steps = r.body.journey.steps;
    expect(steps.map((s: { id: string }) => s.id)).toEqual([cardioVisitId, nutriVisitId]);
    expect(steps[0]).toMatchObject({ current: true, department: 'Cardiology', diagnosis: 'Stable angina', results: [expect.objectContaining({ summary: 'Sinus rhythm, ST depression V4–V6' })], medicines: [expect.stringContaining('Atorvastatin')] });
    expect(steps[1]).toMatchObject({ current: false, department: 'Nutrition', diagnosis: 'Obesity (BMI 31)', advice: '1600 kcal DASH diet', via: { reason: 'Cardiac diet plan', fromDoctor: 'Dr. Portal Cardio' } });
    expect(r.body.referrals[0].toVisit).toMatchObject({ id: nutriVisitId, diagnosis: 'Obesity (BMI 31)', advice: '1600 kcal DASH diet' });
    expect(JSON.stringify(r.body)).not.toContain('INTERNAL-NUTRI-FINDINGS');

    const n = await api('patient').get(`/api/visits/mine/${nutriVisitId}`);
    expect(n.body.referredFrom).toMatchObject({ fromVisitId: cardioVisitId, fromDoctor: 'Dr. Portal Cardio', reason: 'Cardiac diet plan' });
    expect(n.body.journey.steps.map((s: { id: string }) => s.id)).toEqual([cardioVisitId, nutriVisitId]);
  });

  it('My visits groups both visits into one journey', async () => {
    const r = await api('patient').get('/api/visits/mine');
    expect(r.status).toBe(200);
    expect(r.body.journeys).toHaveLength(1);
    expect(r.body.journeys[0].visits.map((v: { id: string }) => v.id)).toEqual([cardioVisitId, nutriVisitId]);
  });
});

describe('own data only (server-enforced)', () => {
  it('a patient requesting another patient’s visit gets 403, and the refusal is audited', async () => {
    const r = await api('other').get(`/api/visits/mine/${cardioVisitId}`);
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('Stable angina');
    const denied = await prisma.auditLog.findFirst({ where: { action: 'ACCESS_DENIED', entity: 'visits', entityId: cardioVisitId, patientId } });
    expect(denied).not.toBeNull();
    expect((await api('other').get('/api/visits/mine')).body.journeys).toEqual([]);
  });

  it('staff cannot use the patient endpoints, and unknown visits are 404', async () => {
    expect((await api('cardio').get(`/api/visits/mine/${cardioVisitId}`)).status).toBe(403);
    expect((await api('patient').get(`/api/visits/mine/${otherPatientId}`)).status).toBe(404);
  });
});
