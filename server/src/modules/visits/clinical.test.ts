/**
 * Doctor workspace + clinical core: the two access layers (role, then care relationship / break-glass),
 * audit of every clinical VIEW, and the cardiologist → nutritionist referral end to end.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { addDays, atLocalMinute, localDateKey } from '../../lib/time.js';
import { captureNotifications, cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, type Fixture } from '../../test/helpers.js';

const app = createApp();
let notes: ReturnType<typeof captureNotifications>;

let cardio: Fixture;
let nutri: Fixture;
let stranger: Fixture; // a doctor with no relationship to the patient
let admin: Fixture;
const cookie: Record<string, string> = {};
let patientId: string;
let cardioVisitId: string;
let referralOrderId: string;

const api = (who: string) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookie[who]!),
  post: (url: string, body: object = {}) => request(app).post(url).set('Cookie', cookie[who]!).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('Cookie', cookie[who]!).send(body),
});

const since = new Date(Date.now() - 1000);
const audits = (action: string, extra: { actorId?: string; entity?: string } = {}) =>
  prisma.auditLog.findMany({ where: { action, patientId, createdAt: { gte: since }, ...extra }, orderBy: { id: 'desc' } });

beforeAll(async () => {
  await setupInfra();
  cardio = await createStaff('DOCTOR', { department: 'CARD', name: 'Dr. Test Cardio' });
  nutri = await createStaff('DOCTOR', { department: 'NUTR', name: 'Dr. Test Nutrition' });
  stranger = await createStaff('DOCTOR', { department: 'DERM', name: 'Dr. Test Stranger' });
  admin = await createStaff('ADMIN');
  const others = { reception: await createStaff('RECEPTIONIST'), accounts: await createStaff('ACCOUNTS'), pharmacist: await createStaff('PHARMACIST'), lab: await createStaff('LAB_TECH') };
  // Nutritionist open all day, every day, so the referral can be booked whatever the clock says.
  await prisma.doctorSchedule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ doctorId: nutri.staffId, dayOfWeek, startMinute: 0, endMinute: 1440, slotMinutes: 30 })) });

  for (const [k, f] of Object.entries({ cardio, nutri, stranger, admin, ...others })) cookie[k] = await sessionCookieFor(f.userId);

  const t = tag();
  const p = await prisma.patient.create({
    data: { mrn: `T-${t}`, firstName: 'Clinical', lastName: `Patient ${t}`, gender: 'MALE', dateOfBirth: new Date('1970-05-10T00:00:00Z'), phone: '+91 90000 00000', allergies: 'Penicillin' },
  });
  patientId = p.id;
});

beforeEach(() => {
  notes = captureNotifications();
});

afterAll(async () => {
  const keys = await redis.keys(`hold:slot:${nutri.staffId}:*`);
  if (keys.length) await redis.del(...keys);
  const visitIds = (await prisma.visit.findMany({ where: { patientId }, select: { id: true } })).map((v) => v.id);
  await prisma.invoice.deleteMany({ where: { visitId: { in: visitIds } } }); // one bill per visit, created with the first charge
  await prisma.charge.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.prescription.deleteMany({ where: { patientId } });
  await prisma.referral.deleteMany({ where: { patientId } });
  await prisma.order.deleteMany({ where: { patientId } });
  await prisma.queueEvent.deleteMany({ where: { patientId } });
  await prisma.visit.deleteMany({ where: { patientId } });
  await prisma.appointment.deleteMany({ where: { patientId } });
  await prisma.accessOverride.deleteMany({ where: { patientId } });
  // break-glass alerts went to every admin in the database, not only the fixture admin
  await prisma.notification.deleteMany({ where: { data: { path: ['patientId'], equals: patientId } } });
  await prisma.auditLog.deleteMany({ where: { patientId } });
  await prisma.doctorSchedule.deleteMany({ where: { doctorId: nutri.staffId } });
  await prisma.patient.delete({ where: { id: patientId } });
  await cleanupFixtures();
});

describe('layer 1 — role: non-clinical roles never reach clinical notes', () => {
  it.each(['reception', 'accounts', 'pharmacist', 'lab', 'admin'])('%s gets 403 from the clinical-notes endpoints', async (who) => {
    expect((await api(who).get(`/api/visits/patients/${patientId}/notes`)).status).toBe(403);
    expect((await api(who).get(`/api/visits/patients/${patientId}/timeline`)).status).toBe(403);
    expect((await api(who).post(`/api/visits/patients/${patientId}/break-glass`, { reason: 'Trying to get in as non-doctor' })).status).toBe(403);
  });
});

describe('cardiologist consultation', () => {
  it('reception registers a walk-in; it shows on the cardiologist’s queue; start consult', async () => {
    const w = await api('reception').post('/api/reception/walk-ins', { patientId, doctorId: cardio.staffId, complaint: 'Chest pain on exertion' });
    expect(w.status).toBe(201);
    cardioVisitId = w.body.visit.id;

    const dash = await api('cardio').get('/api/visits/dashboard');
    expect(dash.status).toBe(200);
    const row = dash.body.rows.find((r: { visitId: string }) => r.visitId === cardioVisitId);
    expect(row).toMatchObject({ status: 'CHECKED_IN', kind: 'WALK_IN', reason: 'Chest pain on exertion' });
    expect(dash.body.stats.waiting).toBeGreaterThanOrEqual(1);

    expect((await api('stranger').post(`/api/visits/${cardioVisitId}/start`)).status).toBe(403); // not their patient
    const start = await api('cardio').post(`/api/visits/${cardioVisitId}/start`);
    expect(start.status).toBe(200);
    expect(start.body.visit.status).toBe('IN_CONSULTATION');
  });

  it('opening the consultation is audited as a VIEW with the patient id', async () => {
    const r = await api('cardio').get(`/api/visits/${cardioVisitId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ access: 'VISIT', canEdit: true, patient: { id: patientId, allergies: 'Penicillin', age: expect.any(Number) } });
    const views = await audits('VIEW', { actorId: cardio.userId, entity: 'visits' });
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views[0]!.metadata).toMatchObject({ basis: 'VISIT' });
  });

  it('records notes, orders an ECG, refers to Nutrition and prescribes', async () => {
    const n = await api('cardio').put(`/api/visits/${cardioVisitId}/notes`, {
      complaint: 'Chest pain on exertion for 2 weeks', findings: 'BP 150/95, BMI 31', diagnosis: 'Stable angina; obesity', advice: 'Low-fat diet, walk 30 min daily',
    });
    expect(n.status).toBe(200);
    expect(n.body.note.diagnosis).toBe('Stable angina; obesity');

    const { body: cat } = await api('cardio').get('/api/orders/catalogue?type=LAB');
    const ecg = cat.items.find((i: { code: string }) => i.code === 'LAB-ECG');
    const o = await api('cardio').post('/api/orders/investigations', { visitId: cardioVisitId, catalogueItemId: ecg.id, priority: 'URGENT', notes: 'Rule out ischaemia' });
    expect(o.status).toBe(201);
    expect(o.body.order).toMatchObject({ type: 'LAB', status: 'ORDERED', targetDepartment: { code: 'LAB' } });

    const nutr = await prisma.department.findUniqueOrThrow({ where: { code: 'NUTR' } });
    const ref = await api('cardio').post('/api/orders/referrals', { visitId: cardioVisitId, toDepartmentId: nutr.id, reason: 'Weight loss and cardiac diet plan', priority: 'ROUTINE' });
    expect(ref.status).toBe(201);
    expect(ref.body.order).toMatchObject({ type: 'REFERRAL', status: 'ORDERED', targetDoctorId: null, referral: { reason: 'Weight loss and cardiac diet plan' } });
    referralOrderId = ref.body.order.id;

    const rx = await api('cardio').post('/api/orders/prescriptions', {
      visitId: cardioVisitId, items: [{ medicineName: 'Atorvastatin 10 mg', dose: '1 tablet', frequency: '0-0-1', durationDays: 30, instructions: 'After dinner' }],
    });
    expect(rx.status).toBe(201);
    expect(rx.body.order.prescription.items[0]).toMatchObject({ medicineName: 'Atorvastatin 10 mg', quantity: 30 });
  });

  it('another doctor cannot write to the cardiologist’s visit', async () => {
    expect((await api('nutri').put(`/api/visits/${cardioVisitId}/notes`, { diagnosis: 'x' })).status).toBe(403);
  });

  it('complete visit closes it and creates one consultation charge for Cardiology', async () => {
    const c = await api('cardio').post(`/api/visits/${cardioVisitId}/complete`);
    expect(c.status).toBe(200);
    expect(c.body.visit.status).toBe('COMPLETED');
    const charges = await prisma.charge.findMany({ where: { visitId: cardioVisitId }, include: { department: true, catalogueItem: true } });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ totalPaise: 80000, department: { code: 'CARD' }, catalogueItem: { category: 'CONSULTATION' } });
    // closed: no more writes
    expect((await api('cardio').put(`/api/visits/${cardioVisitId}/notes`, { diagnosis: 'late edit' })).status).toBe(409);
  });
});

describe('referral: cardiologist → nutritionist', () => {
  it('the nutritionist has no access before the referral is booked with them', async () => {
    const r = await api('nutri').get(`/api/visits/patients/${patientId}/timeline`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NO_CARE_RELATIONSHIP');
  });

  it('appears on the reception board as "to book" — without the clinical reason', async () => {
    const r = await api('reception').get('/api/reception/referrals');
    expect(r.status).toBe(200);
    const item = r.body.referrals.find((x: { orderId: string }) => x.orderId === referralOrderId);
    expect(item).toMatchObject({ patient: { id: patientId }, toDepartment: { code: 'NUTR' }, fromDoctor: { name: 'Dr. Test Cardio' } });
    expect(JSON.stringify(item)).not.toContain('Weight loss');
  });

  it('reception books it with the nutritionist → SCHEDULED, nutritionist becomes the target', async () => {
    const slotStart = atLocalMinute(addDays(localDateKey(), 1), 10 * 60).toISOString();
    const hold = await api('reception').post('/api/scheduling/holds', { doctorId: nutri.staffId, slotStart });
    expect(hold.status).toBe(201);
    // the wrong department is refused
    const wrong = await api('reception').post('/api/scheduling/appointments', { holdId: hold.body.hold.holdId, patientId, referralOrderId: cardioVisitId });
    expect(wrong.status).toBe(404);
    const book = await api('reception').post('/api/scheduling/appointments', { holdId: hold.body.hold.holdId, patientId, referralOrderId });
    expect(book.status).toBe(201);
    expect(book.body.appointment.reason).toBe('Referral from Dr. Test Cardio');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: referralOrderId }, include: { referral: true } });
    expect(order).toMatchObject({ status: 'SCHEDULED', targetDoctorId: nutri.staffId, referral: { toDoctorId: nutri.staffId } });
    expect((await api('reception').get('/api/reception/referrals')).body.referrals.some((x: { orderId: string }) => x.orderId === referralOrderId)).toBe(false);
  });

  it('the nutritionist now sees the full timeline: cardiologist’s notes, the referral reason and the ECG order', async () => {
    const r = await api('nutri').get(`/api/visits/patients/${patientId}/timeline`);
    expect(r.status).toBe(200);
    expect(r.body.access).toBe('ORDER');
    const types = r.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['VISIT', 'NOTE', 'LAB', 'REFERRAL', 'PRESCRIPTION']));
    const note = r.body.events.find((e: { type: string }) => e.type === 'NOTE');
    expect(note).toMatchObject({ doctor: 'Dr. Test Cardio', department: 'Cardiology' });
    expect(note.lines).toEqual(expect.arrayContaining([['Diagnosis', 'Stable angina; obesity']]));
    const referral = r.body.events.find((e: { type: string }) => e.type === 'REFERRAL');
    expect(referral.lines).toEqual(expect.arrayContaining([['Reason', 'Weight loss and cardiac diet plan']]));
    // newest first
    const ats = r.body.events.map((e: { at: string }) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    // filter by type
    const onlyNotes = await api('nutri').get(`/api/visits/patients/${patientId}/timeline?type=NOTE`);
    expect(onlyNotes.body.events.every((e: { type: string }) => e.type === 'NOTE')).toBe(true);

    const allNotes = await api('nutri').get(`/api/visits/patients/${patientId}/notes`);
    expect(allNotes.status).toBe(200);
    expect(allNotes.body.notes[0]).toMatchObject({ author: 'Dr. Test Cardio', diagnosis: 'Stable angina; obesity', advice: 'Low-fat diet, walk 30 min daily' });

    const views = await audits('VIEW', { actorId: nutri.userId });
    expect(views.map((v) => v.entity)).toEqual(expect.arrayContaining(['timeline', 'clinical_notes']));
    expect(views.every((v) => (v.metadata as { basis: string }).basis === 'ORDER')).toBe(true);
  });

  it('the patient arrives: the visit links to the referral; the consult shows the reason; completing it closes the referral', async () => {
    const w = await api('reception').post('/api/reception/walk-ins', { patientId, doctorId: nutri.staffId });
    expect(w.status).toBe(201);
    const visitId = w.body.visit.id;
    expect((await prisma.order.findUniqueOrThrow({ where: { id: referralOrderId } })).status).toBe('IN_PROGRESS');

    const dash = await api('nutri').get('/api/visits/dashboard');
    expect(dash.body.rows.find((r: { visitId: string }) => r.visitId === visitId)).toMatchObject({ referral: true });

    await api('nutri').post(`/api/visits/${visitId}/start`).expect(200);
    const c = await api('nutri').get(`/api/visits/${visitId}`);
    expect(c.status).toBe(200);
    expect(c.body.referral).toMatchObject({ id: referralOrderId, referral: { reason: 'Weight loss and cardiac diet plan' }, orderingDoctor: { name: 'Dr. Test Cardio' } });

    await api('nutri').put(`/api/visits/${visitId}/notes`, { diagnosis: 'Obesity (BMI 31)', advice: '1600 kcal DASH diet' }).expect(200);
    await api('nutri').post(`/api/visits/${visitId}/complete`).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: referralOrderId } })).status).toBe('COMPLETED');
    const charge = await prisma.charge.findFirstOrThrow({ where: { visitId }, include: { department: true } });
    expect(charge).toMatchObject({ totalPaise: 40000, department: { code: 'NUTR' } });
  });
});

describe('layer 2 — an unrelated doctor needs break-glass', () => {
  it('is refused (403) and the refusal is audited with the patient id', async () => {
    const r = await api('stranger').get(`/api/visits/patients/${patientId}/timeline`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NO_CARE_RELATIONSHIP');
    expect((await api('stranger').get(`/api/visits/${cardioVisitId}`)).status).toBe(403);
    expect((await api('stranger').get(`/api/visits/${cardioVisitId}/notes`)).status).toBe(403);
    const denied = await audits('ACCESS_DENIED', { actorId: stranger.userId });
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied[0]!.metadata).toMatchObject({ reason: 'NO_CARE_RELATIONSHIP' });
    expect((await api('stranger').get(`/api/visits/patients/${patientId}/access`)).body.basis).toBeNull();
  });

  it('break-glass needs a real reason', async () => {
    const r = await api('stranger').post(`/api/visits/patients/${patientId}/break-glass`, { reason: 'urgent' });
    expect(r.status).toBe(400);
  });

  it('break-glass grants 60 minutes, alerts every admin (email + in-app) and is audited', async () => {
    const r = await api('stranger').post(`/api/visits/patients/${patientId}/break-glass`, { reason: 'Unconscious in casualty, cardiac history needed' });
    expect(r.status).toBe(201);
    const minutes = (new Date(r.body.override.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThanOrEqual(60);

    const row = await prisma.accessOverride.findUniqueOrThrow({ where: { id: r.body.override.id } });
    expect(row).toMatchObject({ userId: stranger.userId, patientId, reason: 'Unconscious in casualty, cardiac history needed' });
    expect(row.adminNotifiedAt).not.toBeNull();

    const emailed = notes.spy.mock.calls.filter((c) => c[1] === 'break-glass-alert');
    expect(emailed.map((c) => (c[0] as { email: string }).email)).toContain(admin.email);
    expect(emailed[0]![2]).toMatchObject({ doctor: 'Dr. Test Stranger', reason: 'Unconscious in casualty, cardiac history needed' });
    const inApp = await prisma.notification.findFirst({ where: { userId: admin.userId, channel: 'IN_APP' }, orderBy: { createdAt: 'desc' } });
    expect(inApp?.data).toMatchObject({ kind: 'BREAK_GLASS', patientId });
    const inbox = await api('admin').get('/api/notifications?unread=true');
    expect(inbox.body.items.some((n: { id: string }) => n.id === inApp!.id)).toBe(true);

    const bg = await audits('BREAK_GLASS', { actorId: stranger.userId });
    expect(bg).toHaveLength(1);
    expect(bg[0]!.reason).toBe('Unconscious in casualty, cardiac history needed');
  });

  it('with the override the timeline opens, each view audited with basis BREAK_GLASS; the admin sees it in the audit log', async () => {
    const r = await api('stranger').get(`/api/visits/patients/${patientId}/timeline`);
    expect(r.status).toBe(200);
    expect(r.body.access).toBe('BREAK_GLASS');
    expect(r.body.override.reason).toBe('Unconscious in casualty, cardiac history needed');
    const view = (await audits('VIEW', { actorId: stranger.userId }))[0]!;
    expect(view).toMatchObject({ entity: 'timeline', reason: 'Unconscious in casualty, cardiac history needed' });
    expect(view.metadata).toMatchObject({ basis: 'BREAK_GLASS' });

    const log = await api('admin').get('/api/audit?action=BREAK_GLASS');
    expect(log.status).toBe(200);
    expect(log.body.entries.find((e: { patient: { id: string } | null }) => e.patient?.id === patientId)).toMatchObject({ actor: { name: 'Dr. Test Stranger' }, reason: 'Unconscious in casualty, cardiac history needed' });
  });

  it('break-glass reads, but never lets them write to another doctor’s visit', async () => {
    expect((await api('stranger').put(`/api/visits/${cardioVisitId}/notes`, { diagnosis: 'x' })).status).toBe(403);
  });

  it('access ends when the override expires', async () => {
    await prisma.accessOverride.updateMany({ where: { userId: stranger.userId, patientId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await api('stranger').get(`/api/visits/patients/${patientId}/timeline`);
    expect(r.status).toBe(403);
  });
});
