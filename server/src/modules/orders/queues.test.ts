/**
 * Department queues: the ECG flows lab queue → result → doctor timeline + notification → charge;
 * a prescription is dispensed (partial, then full) and stock goes down with exact margin; low stock is flagged;
 * technicians and pharmacists never reach clinical notes, and result files are served only to authorised users.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { removeUpload, UPLOAD_ROOT } from '../../lib/uploads.js';
import { pharmacyService } from '../pharmacy/pharmacy.service.js';
import { captureNotifications, cleanupFixtures, createStaff, sessionCookieFor, setupInfra, tag, type Fixture } from '../../test/helpers.js';

const app = createApp();

let cardio: Fixture;
let stranger: Fixture;
let lab: Fixture;
let rad: Fixture;
let pharm: Fixture;
const cookie: Record<string, string> = {};
let patientId: string;
let visitId: string;
let ecgOrderId: string;
let cxrOrderId: string;
let rxId: string;
let resultId: string;
let medId: string; // a fresh medicine so stock assertions are exact
let atorName: string; // second test-owned medicine, prescribed as free text (matched by name); never touch seed stock
const createdMedicineIds: string[] = [];

const api = (who: string) => ({
  get: (url: string) => request(app).get(url).set('Cookie', cookie[who]!),
  post: (url: string, body: object = {}) => request(app).post(url).set('Cookie', cookie[who]!).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('Cookie', cookie[who]!).send(body),
});

type Item = { id: string; medicineName: string };
/** The three prescription items by what the doctor wrote (item order is not significant). */
const byName = <T extends Item>(items: T[]) => ({
  q: items.find((i) => i.medicineName === 'Queuemycin')!,
  ator: items.find((i) => i.medicineName === atorName.toUpperCase())!,
  tonic: items.find((i) => i.medicineName === 'Unlisted herbal tonic')!,
});

/** A minimal, valid one-page PDF. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

beforeAll(async () => {
  await setupInfra();
  captureNotifications();
  cardio = await createStaff('DOCTOR', { department: 'CARD', name: 'Dr. Queue Cardio' });
  stranger = await createStaff('DOCTOR', { department: 'DERM', name: 'Dr. Queue Stranger' });
  lab = await createStaff('LAB_TECH', { department: 'LAB', name: 'Queue Lab Tech' });
  rad = await createStaff('RADIOLOGY_TECH', { department: 'RAD', name: 'Queue Radiographer' });
  pharm = await createStaff('PHARMACIST', { department: 'PHARM', name: 'Queue Pharmacist' });
  const reception = await createStaff('RECEPTIONIST');
  for (const [k, f] of Object.entries({ cardio, stranger, lab, rad, pharm, reception })) cookie[k] = await sessionCookieFor(f.userId);

  const t = tag();
  patientId = (await prisma.patient.create({ data: { mrn: `T-${t}`, firstName: 'Queue', lastName: `Patient ${t}`, gender: 'FEMALE', dateOfBirth: new Date('1980-02-02T00:00:00Z') } })).id;
});

beforeEach(() => {
  captureNotifications();
});

afterAll(async () => {
  const visitIds = (await prisma.visit.findMany({ where: { patientId }, select: { id: true } })).map((v) => v.id);
  const results = await prisma.orderResult.findMany({ where: { order: { patientId } }, select: { id: true } });
  const files = await readdir(path.join(UPLOAD_ROOT, 'results')).catch(() => [] as string[]);
  for (const r of results) for (const f of files.filter((n) => n.startsWith(r.id))) await removeUpload(path.join(UPLOAD_ROOT, 'results', f));
  await prisma.invoice.deleteMany({ where: { visitId: { in: visitIds } } }); // one bill per visit, created with the first charge
  await prisma.charge.deleteMany({ where: { visitId: { in: visitIds } } });
  const items = await prisma.prescriptionItem.findMany({ where: { prescription: { patientId } }, select: { id: true } });
  const disp = await prisma.dispensation.findMany({ where: { prescriptionItemId: { in: items.map((i) => i.id) } }, select: { id: true } });
  await prisma.stockMovement.deleteMany({ where: { OR: [{ dispensationId: { in: disp.map((d) => d.id) } }, { medicineId: { in: createdMedicineIds } }] } });
  await prisma.dispensation.deleteMany({ where: { id: { in: disp.map((d) => d.id) } } });
  await prisma.prescription.deleteMany({ where: { patientId } });
  await prisma.order.deleteMany({ where: { patientId } });
  await prisma.queueEvent.deleteMany({ where: { patientId } });
  await prisma.visit.deleteMany({ where: { patientId } });
  await prisma.notification.deleteMany({ where: { data: { path: ['patientId'], equals: patientId } } });
  await prisma.auditLog.deleteMany({ where: { patientId } });
  const meds = await prisma.medicine.findMany({ where: { id: { in: createdMedicineIds } }, select: { catalogueItemId: true } });
  await prisma.medicine.deleteMany({ where: { id: { in: createdMedicineIds } } });
  await prisma.serviceCatalogue.deleteMany({ where: { id: { in: meds.map((m) => m.catalogueItemId).filter((x): x is string => !!x) } } });
  await prisma.patient.delete({ where: { id: patientId } });
  await cleanupFixtures();
});

describe('setup: a cardiology consult orders an ECG, a chest X-ray and a prescription', () => {
  it('pharmacist adds a medicine and stocks it (purchase price stored on the movement)', async () => {
    const m = await api('pharm').post('/api/pharmacy/medicines', { name: `Queuemycin ${tag()} 250 mg`, strength: '250 mg', form: 'capsule', sellingPricePaise: 1200, purchasePricePaise: 700, reorderLevel: 10 });
    expect(m.status).toBe(201);
    medId = m.body.medicine.id;
    createdMedicineIds.push(medId);
    expect(m.body.medicine).toMatchObject({ stockQuantity: 0, level: 'OUT_OF_STOCK', marginPaise: 500 });

    const s = await api('pharm').post(`/api/pharmacy/medicines/${medId}/stock-in`, { quantity: 20, unitCostPaise: 750, reference: 'Invoice 42' });
    expect(s.status).toBe(201);
    expect(s.body.medicine).toMatchObject({ stockQuantity: 20, purchasePricePaise: 750, level: 'IN_STOCK' });
    atorName = `Testatorva ${tag()} 10 mg`;
    const a = await api('pharm').post('/api/pharmacy/medicines', { name: atorName, sellingPricePaise: 800, purchasePricePaise: 450, reorderLevel: 5 });
    createdMedicineIds.push(a.body.medicine.id);
    await api('pharm').post(`/api/pharmacy/medicines/${a.body.medicine.id}/stock-in`, { quantity: 50, unitCostPaise: 450 }).expect(201);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { medicineId: medId, type: 'PURCHASE' } });
    expect(mv).toMatchObject({ quantity: 20, unitCostPaise: 750 });
  });

  it('cardiologist sees a walk-in and places the orders', async () => {
    const w = await api('reception').post('/api/reception/walk-ins', { patientId, doctorId: cardio.staffId, complaint: 'Palpitations' });
    expect(w.status).toBe(201);
    visitId = w.body.visit.id;
    await api('cardio').post(`/api/visits/${visitId}/start`).expect(200);
    await request(app).put(`/api/visits/${visitId}/notes`).set('Cookie', cookie.cardio!).send({ diagnosis: 'Palpitations – query arrhythmia' }).expect(200);

    const cat = (await api('cardio').get('/api/orders/catalogue')).body.items as { id: string; code: string }[];
    const ecg = await api('cardio').post('/api/orders/investigations', { visitId, catalogueItemId: cat.find((i) => i.code === 'LAB-ECG')!.id, priority: 'URGENT', notes: 'SECRET-INDICATION rule out AF' });
    expect(ecg.status).toBe(201);
    ecgOrderId = ecg.body.order.id;
    const cxr = await api('cardio').post('/api/orders/investigations', { visitId, catalogueItemId: cat.find((i) => i.code === 'RAD-CXR')!.id, priority: 'ROUTINE' });
    cxrOrderId = cxr.body.order.id;

    const rx = await api('cardio').post('/api/orders/prescriptions', {
      visitId, notes: 'SECRET-RX-NOTE',
      items: [
        { medicineId: medId, medicineName: 'Queuemycin', dose: '1 capsule', frequency: '1-0-1', durationDays: 6, instructions: 'After food' }, // 12
        { medicineName: atorName.toUpperCase(), frequency: '0-0-1', durationDays: 5 }, // free text → matched by name (any case)
        { medicineName: 'Unlisted herbal tonic', quantity: 1 },
      ],
    });
    expect(rx.status).toBe(201);
    rxId = (await prisma.prescription.findFirstOrThrow({ where: { orderId: rx.body.order.id } })).id;
  });
});

describe('techs and pharmacists never see clinical notes', () => {
  it.each(['lab', 'rad', 'pharm'])('%s gets 403 on clinical notes, timeline and the consultation', async (who) => {
    expect((await api(who).get(`/api/visits/patients/${patientId}/notes`)).status).toBe(403);
    expect((await api(who).get(`/api/visits/patients/${patientId}/timeline`)).status).toBe(403);
    expect((await api(who).get(`/api/visits/${visitId}`)).status).toBe(403);
    expect((await api(who).get(`/api/visits/${visitId}/notes`)).status).toBe(403);
  });

  it('pharmacist cannot write or change prescriptions', async () => {
    expect((await api('pharm').post('/api/orders/prescriptions', { visitId, items: [{ medicineName: 'x', quantity: 1 }] })).status).toBe(403);
    expect((await api('pharm').post(`/api/orders/${ecgOrderId}/cancel`, { reason: 'nope' })).status).toBe(403);
  });
});

describe('lab queue → result → timeline → charge', () => {
  it('the ECG is in the lab queue (with patient, MRN, test, doctor, urgency) but not in radiology; no clinical notes', async () => {
    const q = await api('lab').get('/api/orders/lab/dashboard');
    expect(q.status).toBe(200);
    const row = q.body.items.find((i: { id: string }) => i.id === ecgOrderId);
    expect(row).toMatchObject({ title: 'ECG (12-lead)', status: 'ORDERED', priority: 'URGENT', patient: { id: patientId, mrn: expect.stringMatching(/^T-/) }, orderingDoctor: { name: 'Dr. Queue Cardio' } });
    expect(JSON.stringify(q.body)).not.toContain('SECRET-INDICATION');
    expect(q.body.items.some((i: { id: string }) => i.id === cxrOrderId)).toBe(false);

    const r = await api('rad').get('/api/orders/radiology/dashboard');
    expect(r.body.items.some((i: { id: string }) => i.id === cxrOrderId)).toBe(true);
    expect(r.body.items.some((i: { id: string }) => i.id === ecgOrderId)).toBe(false);
    expect((await api('lab').get('/api/orders/radiology/dashboard')).status).toBe(403);
    expect((await api('pharm').get('/api/orders/lab/dashboard')).status).toBe(403);
  });

  it('cannot upload before the sample is collected; radiology cannot touch a lab order', async () => {
    expect((await api('lab').post(`/api/orders/${ecgOrderId}/result`, { summary: 'Too early' })).status).toBe(409);
    expect((await api('rad').post(`/api/orders/${ecgOrderId}/start`)).status).toBe(403);
    expect((await api('cardio').post(`/api/orders/${ecgOrderId}/start`)).status).toBe(403);
  });

  it('mark sample collected → IN_PROGRESS; the doctor can no longer cancel it', async () => {
    const s = await api('lab').post(`/api/orders/${ecgOrderId}/start`);
    expect(s.status).toBe(200);
    expect(s.body.order.status).toBe('IN_PROGRESS');
    expect((await api('lab').post(`/api/orders/${ecgOrderId}/start`)).status).toBe(409);
    expect((await api('cardio').post(`/api/orders/${ecgOrderId}/cancel`, { reason: 'changed my mind' })).status).toBe(409);
  });

  it('rejects files that are not PDF / images', async () => {
    const bad = await api('lab').post(`/api/orders/${ecgOrderId}/result`, { summary: 'Sinus rhythm', file: { name: 'x.exe', base64: Buffer.from('MZ not a pdf').toString('base64') } });
    expect(bad.status).toBe(415);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ecgOrderId } })).status).toBe('IN_PROGRESS');
  });

  it('upload result (findings + PDF) → RESULT_READY, one LAB charge from the catalogue, doctor notified', async () => {
    const r = await api('lab').post(`/api/orders/${ecgOrderId}/result`, { summary: 'Sinus rhythm, rate 88. No ST changes.', isAbnormal: false, file: { name: 'ecg.pdf', base64: PDF.toString('base64') } });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ status: 'RESULT_READY', result: { summary: 'Sinus rhythm, rate 88. No ST changes.', fileUrl: expect.stringMatching(/^\/api\/orders\/results\/.+\/file$/) } });
    resultId = r.body.order.result.id;

    const charges = await prisma.charge.findMany({ where: { orderId: ecgOrderId }, include: { department: true } });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ totalPaise: 30000, visitId, department: { code: 'LAB' } });

    const alert = await prisma.notification.findFirst({ where: { userId: cardio.userId, channel: 'IN_APP' }, orderBy: { createdAt: 'desc' } });
    expect(alert).toMatchObject({ subject: 'Result ready: ECG (12-lead)' });
    expect(alert!.data).toMatchObject({ kind: 'RESULT_READY', orderId: ecgOrderId, patientId });

    expect((await api('lab').post(`/api/orders/${ecgOrderId}/result`, { summary: 'again' })).status).toBe(409);
    expect(await prisma.charge.count({ where: { orderId: ecgOrderId } })).toBe(1);

    const q = await api('lab').get('/api/orders/lab/dashboard');
    expect(q.body.items.find((i: { id: string }) => i.id === ecgOrderId)).toMatchObject({ status: 'RESULT_READY' });
    expect(q.body.stats.readyToday).toBeGreaterThanOrEqual(1);
  });

  it('the result appears on the doctor’s timeline with the report link', async () => {
    const t = await api('cardio').get(`/api/visits/patients/${patientId}/timeline`);
    expect(t.status).toBe(200);
    const result = t.body.events.find((e: { type: string }) => e.type === 'RESULT');
    expect(result).toMatchObject({ title: 'Result · ECG (12-lead)', status: 'RESULT_READY', doctor: 'Queue Lab Tech', department: 'Laboratory' });
    expect(result.lines).toEqual(expect.arrayContaining([['Summary', 'Sinus rhythm, rate 88. No ST changes.'], ['Report', `/api/orders/results/${resultId}/file`]]));
    expect(t.body.events.find((e: { id: string }) => e.id === `order:${ecgOrderId}`)).toMatchObject({ status: 'RESULT_READY' });
  });

  it('the report file is served only to authorised users', async () => {
    const url = `/api/orders/results/${resultId}/file`;
    const doc = await api('cardio').get(url);
    expect(doc.status).toBe(200);
    expect(doc.headers['content-type']).toBe('application/pdf');
    expect(doc.headers['cache-control']).toContain('no-store');
    expect((await api('lab').get(url)).status).toBe(200);
    for (const who of ['rad', 'pharm', 'reception', 'stranger']) expect((await api(who).get(url)).status, who).toBe(403);
    expect((await request(app).get(url)).status).toBe(401);
    const views = await prisma.auditLog.count({ where: { action: 'VIEW', entity: 'order_results', actorId: cardio.userId, patientId } });
    expect(views).toBeGreaterThanOrEqual(1);
  });
});

describe('pharmacy: dispense, stock down, charge at selling price, exact margin', () => {
  it('the prescription is waiting; the dispense view shows stock and no doctor notes', async () => {
    const d = await api('pharm').get('/api/pharmacy/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.queue.find((r: { id: string }) => r.id === rxId)).toMatchObject({ status: 'ACTIVE', items: 3, patient: { id: patientId } });

    const v = await api('pharm').get(`/api/pharmacy/prescriptions/${rxId}`);
    expect(v.status).toBe(200);
    expect(JSON.stringify(v.body)).not.toContain('SECRET-RX-NOTE');
    const { q, ator, tonic } = byName(v.body.items);
    expect(q).toMatchObject({ quantity: 12, remaining: 12, instructions: 'After food', medicine: { id: medId, stockQuantity: 20, sellingPricePaise: 1200 } });
    expect(ator.medicine).toMatchObject({ name: atorName, stockQuantity: 50 });
    expect(tonic.medicine).toBeNull();
  });

  it('refuses more than in stock, more than prescribed, and items not in the formulary', async () => {
    const v = (await api('pharm').get(`/api/pharmacy/prescriptions/${rxId}`)).body;
    const { q, tonic } = byName(v.items);
    expect((await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: q.id, quantity: 13 }] })).status).toBe(409);
    expect((await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: tonic.id, quantity: 1 }] })).body.error.code).toBe('NOT_IN_FORMULARY');
    expect((await prisma.medicine.findUniqueOrThrow({ where: { id: medId } })).stockQuantity).toBe(20); // rolled back
  });

  it('partial dispense: stock 20 → 12, dispensation + movement store selling and purchase price, charge in Pharmacy', async () => {
    const v = (await api('pharm').get(`/api/pharmacy/prescriptions/${rxId}`)).body;
    const r = await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: byName(v.items).q.id, quantity: 8 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PARTIALLY_DISPENSED');
    expect((await prisma.medicine.findUniqueOrThrow({ where: { id: medId } })).stockQuantity).toBe(12);

    const disp = await prisma.dispensation.findFirstOrThrow({ where: { medicineId: medId }, include: { stockMovement: true, charge: { include: { department: true } } } });
    expect(disp).toMatchObject({ quantity: 8, unitPricePaise: 1200, unitCostPaise: 750 });
    expect(disp.stockMovement).toMatchObject({ type: 'DISPENSE', quantity: -8, unitCostPaise: 750 });
    expect(disp.charge).toMatchObject({ visitId, quantity: 8, unitPricePaise: 1200, totalPaise: 9600, department: { code: 'PHARM' } });
  });

  it('low stock is flagged once stock falls below the reorder level', async () => {
    await api('pharm').patch(`/api/pharmacy/medicines/${medId}`, { reorderLevel: 15 }).expect(200);
    const list = await api('pharm').get(`/api/pharmacy/medicines?q=Queuemycin`);
    expect(list.body.medicines.find((m: { id: string }) => m.id === medId)).toMatchObject({ stockQuantity: 12, reorderLevel: 15, level: 'LOW_STOCK' });
    const d = await api('pharm').get('/api/pharmacy/dashboard');
    expect(d.body.lowStock.some((m: { id: string }) => m.id === medId)).toBe(true);
    expect(d.body.stats.lowStock).toBeGreaterThanOrEqual(1);
  });

  it('a price change after a dispense keeps the earlier margin exact; the rest is dispensed → DISPENSED, order COMPLETED', async () => {
    await api('pharm').post(`/api/pharmacy/medicines/${medId}/stock-in`, { quantity: 10, unitCostPaise: 800 }).expect(201);
    const v = (await api('pharm').get(`/api/pharmacy/prescriptions/${rxId}`)).body;
    const it = byName(v.items);
    expect(it.q).toMatchObject({ remaining: 4, medicine: { stockQuantity: 22 } });

    // the free-text item nobody can dispense still blocks DISPENSED, so it stays partial…
    const r = await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: it.q.id, quantity: 4 }, { itemId: it.ator.id, quantity: 5 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PARTIALLY_DISPENSED');
    expect((await prisma.medicine.findFirstOrThrow({ where: { name: atorName } })).stockQuantity).toBe(45);
    expect((await prisma.medicine.findUniqueOrThrow({ where: { id: medId } })).stockQuantity).toBe(18);

    const margin = await pharmacyService.margin(new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000));
    const mine = margin.items.find((i) => i.medicineId === medId)!;
    // 8 × (1200 − 750) + 4 × (1200 − 800) = 3600 + 1600
    expect(mine).toMatchObject({ quantity: 12, salesPaise: 14400, costPaise: 9200, marginPaise: 5200 });
  });

  it('when every item is complete the prescription is DISPENSED and leaves the queue', async () => {
    // Simulate the last item being given (e.g. the doctor's free-text tonic added to the formulary and dispensed).
    const m = await api('pharm').post('/api/pharmacy/medicines', { name: 'Unlisted herbal tonic', sellingPricePaise: 5000, purchasePricePaise: 3000, reorderLevel: 2 });
    createdMedicineIds.push(m.body.medicine.id);
    await api('pharm').post(`/api/pharmacy/medicines/${m.body.medicine.id}/stock-in`, { quantity: 3, unitCostPaise: 3000 }).expect(201);
    const v = (await api('pharm').get(`/api/pharmacy/prescriptions/${rxId}`)).body;
    const r = await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: byName(v.items).tonic.id, quantity: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('DISPENSED');
    const rx = await prisma.prescription.findUniqueOrThrow({ where: { id: rxId }, include: { order: true } });
    expect(rx.order?.status).toBe('COMPLETED');
    expect((await api('pharm').get('/api/pharmacy/dashboard')).body.queue.some((q: { id: string }) => q.id === rxId)).toBe(false);
    expect((await api('pharm').post(`/api/pharmacy/prescriptions/${rxId}/dispense`, { items: [{ itemId: byName(v.items).q.id, quantity: 1 }] })).status).toBe(409);

    const charges = await prisma.charge.findMany({ where: { visitId, dispensationId: { not: null } } });
    expect(charges.reduce((n, c) => n + c.totalPaise, 0)).toBe(14400 + 5 * 800 + 5000);
  });

  it('stock screens are pharmacist-only', async () => {
    expect((await api('lab').get('/api/pharmacy/medicines')).status).toBe(403);
    expect((await api('cardio').post(`/api/pharmacy/medicines/${medId}/stock-in`, { quantity: 1, unitCostPaise: 1 })).status).toBe(403);
    expect((await api('reception').get('/api/pharmacy/dashboard')).status).toBe(403);
  });
});
