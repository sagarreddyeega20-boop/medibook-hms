import { randomUUID } from 'node:crypto';
import type { OrderPriority, OrderStatus, OrderType, PrescriptionStatus, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitTo, Rooms } from '../../lib/socket.js';
import { localDateKey, localDayRange } from '../../lib/time.js';
import { decodeUpload, removeUpload, saveUpload } from '../../lib/uploads.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { billingService } from '../billing/billing.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { patientsService } from '../patients/patients.service.js';
import { pharmacyService } from '../pharmacy/pharmacy.service.js';
import { staffService } from '../staff/staff.service.js';
import { EDITABLE_VISIT, visitsService } from '../visits/visits.service.js';

/**
 * Orders service — One order system (LAB, RADIOLOGY, REFERRAL, MEDICATION), department queues, results, referrals, prescriptions.
 * Owns: orders, order_results, referrals, prescriptions, prescription_items
 * Other modules must call this service, never these tables directly.
 *
 * Lifecycle for every type: ORDERED → SCHEDULED → IN_PROGRESS → COMPLETED → RESULT_READY (or CANCELLED).
 * Referral: ORDERED (reception "to book") → SCHEDULED (booked with the target doctor) → IN_PROGRESS (checked in) → COMPLETED (consult done).
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

const orderSelect = {
  id: true, orderNumber: true, visitId: true, patientId: true, type: true, status: true, priority: true,
  orderingDoctorId: true, targetDepartmentId: true, targetDoctorId: true, catalogueItemId: true, title: true, clinicalNotes: true,
  scheduledFor: true, startedAt: true, completedAt: true, resultReadyAt: true, cancelledAt: true, cancelReason: true, createdAt: true,
  targetDepartment: { select: { id: true, code: true, name: true } },
  results: { orderBy: { reportedAt: 'desc' }, select: { id: true, summary: true, values: true, fileUrl: true, isAbnormal: true, reportedAt: true, reportedById: true } },
  referral: { select: { id: true, fromVisitId: true, fromDoctorId: true, toDepartmentId: true, toDoctorId: true, toVisitId: true, reason: true, response: true, createdAt: true } },
  prescription: {
    select: {
      id: true, status: true, notes: true, createdAt: true,
      items: { select: { id: true, medicineId: true, medicineName: true, dose: true, frequency: true, durationDays: true, route: true, instructions: true, quantity: true, dispensedQuantity: true } },
    },
  },
} satisfies Prisma.OrderSelect;
export type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

/** Order with doctor names attached (other modules' data comes through their services). */
async function present(rows: OrderRow[]) {
  const staffIds = new Set<string>();
  for (const r of rows) {
    staffIds.add(r.orderingDoctorId);
    if (r.targetDoctorId) staffIds.add(r.targetDoctorId);
    for (const res of r.results) staffIds.add(res.reportedById);
  }
  const people = await staffService.doctorsByIds([...staffIds]);
  const name = (id: string | null | undefined) => (id ? (people.get(id)?.fullName ?? 'Staff') : null);
  return rows.map((r) => ({
    ...r,
    orderingDoctor: { id: r.orderingDoctorId, name: name(r.orderingDoctorId)!, department: people.get(r.orderingDoctorId)?.department ?? null },
    targetDoctor: r.targetDoctorId ? { id: r.targetDoctorId, name: name(r.targetDoctorId)! } : null,
    results: r.results.map((x) => ({ ...x, reportedBy: name(x.reportedById) })),
  }));
}
export type OrderView = Awaited<ReturnType<typeof present>>[number];

const formatOrderNumber = (n: number) => `ORD-${String(n).padStart(6, '0')}`;

/** Doctor's own staff record (orders are placed by staff IDs, sessions carry user IDs). */
async function doctorOf(actor: Actor) {
  const me = await staffService.profileByUserId(actor.session.userId);
  if (!me || !me.isActive) throw AppError.forbidden('Only active doctors can place orders');
  return me;
}

/** Orders hang from a visit the ordering doctor owns and is still working on. */
async function writableVisit(actor: Actor, visitId: string) {
  const me = await doctorOf(actor);
  const visit = await visitsService.get(visitId);
  if (visit.doctorId !== me.id) throw AppError.forbidden('You can only add orders to your own consultations');
  if (!EDITABLE_VISIT.includes(visit.status)) throw new AppError(409, 'VISIT_CLOSED', 'This visit is already closed.');
  return { me, visit };
}

async function createOrder(
  tx: Prisma.TransactionClient,
  data: { visitId: string; patientId: string; type: OrderType; priority: OrderPriority; orderingDoctorId: string; targetDepartmentId: string; targetDoctorId?: string | null; catalogueItemId?: string | null; title: string; clinicalNotes?: string | null },
) {
  const orderNumber = formatOrderNumber(await nextSequence('order', tx));
  return tx.order.create({ data: { ...data, orderNumber, status: 'ORDERED' }, select: { id: true, orderNumber: true } });
}

const CATEGORY_TO_TYPE = { LAB_TEST: 'LAB', RADIOLOGY_SCAN: 'RADIOLOGY' } as const;

/** "1-0-1" → 2 doses a day; "BD"/"TDS" etc. Falls back to 1. */
export function dosesPerDay(frequency: string | null | undefined): number {
  const f = (frequency ?? '').trim().toUpperCase();
  if (/^\d(-\d){1,3}$/.test(f)) return Math.max(1, f.split('-').reduce((n, x) => n + Number(x), 0));
  const named: Record<string, number> = { OD: 1, QD: 1, HS: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QID: 4, QDS: 4 };
  return named[f] ?? 1;
}

/* ---------------- Department queue helpers ---------------- */

export type QueueType = 'LAB' | 'RADIOLOGY';
const ACTIVE_QUEUE: OrderStatus[] = ['ORDERED', 'SCHEDULED', 'IN_PROGRESS'];
export const RESULTS_FOLDER = 'results';
export const resultFileUrl = (resultId: string) => `/api/orders/results/${resultId}/file`;

/** The permission that opens each queue. */
export const QUEUE_PERMISSION = { LAB: 'orders:lab', RADIOLOGY: 'orders:radiology' } as const;

const queueSelect = {
  id: true, orderNumber: true, type: true, status: true, priority: true, title: true, patientId: true, orderingDoctorId: true,
  createdAt: true, startedAt: true, resultReadyAt: true,
  targetDepartment: { select: { id: true, code: true, name: true } },
  results: { orderBy: { reportedAt: 'desc' }, take: 1, select: { id: true, summary: true, isAbnormal: true, fileUrl: true, reportedAt: true, reportedById: true } },
} satisfies Prisma.OrderSelect;

/** Departments whose queue of `type` this technician works. */
async function queueDepartments(actor: Actor, type: QueueType) {
  const mine = await staffService.departmentOfUser(actor.session.userId);
  if (!mine) throw AppError.forbidden('Only active staff have a department queue');
  if (mine.department?.kind === type) return [mine.department];
  return staffService.departmentsOfKind(type);
}

async function techOf(actor: Actor) {
  const me = await staffService.profileByUserId(actor.session.userId);
  if (!me || !me.isActive) throw AppError.forbidden('Only active staff can work the queue');
  return me;
}

/** A LAB/RADIOLOGY order the technician's role may work (type matches their queue permission and department). */
async function queueOrder(actor: Actor, orderId: string) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, type: true, status: true, title: true, visitId: true, patientId: true, orderingDoctorId: true, targetDepartmentId: true, catalogueItemId: true },
  });
  if (!o || (o.type !== 'LAB' && o.type !== 'RADIOLOGY')) throw AppError.notFound('Order not found');
  if (!actor.session.permissions.includes(QUEUE_PERMISSION[o.type])) throw AppError.forbidden(`This is a ${o.type === 'LAB' ? 'lab' : 'radiology'} order`);
  const depts = await queueDepartments(actor, o.type);
  if (!depts.some((d) => d.id === o.targetDepartmentId)) throw AppError.forbidden('This order belongs to another department');
  if (o.status === 'CANCELLED') throw new AppError(409, 'ORDER_CANCELLED', 'The doctor cancelled this order.');
  return o;
}

/* ---------------- Prescriptions as the pharmacy sees them ---------------- */

const rxSelect = {
  id: true, visitId: true, patientId: true, doctorId: true, orderId: true, status: true, createdAt: true, updatedAt: true,
  order: { select: { orderNumber: true, status: true } },
  items: {
    orderBy: { id: 'asc' },
    select: { id: true, medicineId: true, medicineName: true, dose: true, frequency: true, durationDays: true, route: true, instructions: true, quantity: true, dispensedQuantity: true },
  },
} satisfies Prisma.PrescriptionSelect;

/** No `notes`: the pharmacist sees what to dispense and how to take it, not the doctor's notes. */
const presentRx = (r: Prisma.PrescriptionGetPayload<{ select: typeof rxSelect }>) => ({
  id: r.id, visitId: r.visitId, patientId: r.patientId, doctorId: r.doctorId, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
  orderNumber: r.order?.orderNumber ?? null,
  items: r.items,
});
export type PrescriptionView = ReturnType<typeof presentRx>;

export const ordersService = {
  /* ---------------- Doctor: tests and scans ---------------- */

  async createInvestigation(actor: Actor, input: { visitId: string; catalogueItemId: string; priority: OrderPriority; notes?: string | null }) {
    const { me, visit } = await writableVisit(actor, input.visitId);
    const item = await billingService.catalogueItem(input.catalogueItemId);
    const type = CATEGORY_TO_TYPE[item.category as keyof typeof CATEGORY_TO_TYPE];
    if (!type) throw AppError.badRequest('Only lab tests and radiology scans can be ordered here');
    const order = await prisma.$transaction(async (tx) => {
      const o = await createOrder(tx, {
        visitId: visit.id, patientId: visit.patientId, type, priority: input.priority, orderingDoctorId: me.id,
        targetDepartmentId: item.department.id, catalogueItemId: item.id, title: item.name, clinicalNotes: input.notes?.trim() || null,
      });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.ORDER_CREATED, entity: 'orders', entityId: o.id, patientId: visit.patientId, ip: actor.ip, metadata: { orderNumber: o.orderNumber, type, item: item.code } },
        tx,
      );
      return o;
    });
    emitTo(Rooms.department(item.department.id), 'orders:changed', { type, orderId: order.id });
    return this.get(order.id);
  },

  /* ---------------- Doctor: referrals ---------------- */

  async createReferral(actor: Actor, input: { visitId: string; toDepartmentId: string; toDoctorId?: string | null; reason: string; priority: OrderPriority }) {
    const { me, visit } = await writableVisit(actor, input.visitId);
    const dept = await staffService.departmentById(input.toDepartmentId);
    if (dept.kind !== 'CLINICAL' || !dept.isActive) throw AppError.badRequest('Referrals go to a clinical department');
    let toDoctor: Awaited<ReturnType<typeof staffService.doctorById>> | null = null;
    if (input.toDoctorId) {
      if (input.toDoctorId === me.id) throw AppError.badRequest('You cannot refer a patient to yourself');
      toDoctor = await staffService.doctorById(input.toDoctorId);
      if (!toDoctor.isActive) throw AppError.badRequest('That doctor is not taking patients');
      if (toDoctor.department?.id !== dept.id) throw AppError.badRequest(`${toDoctor.fullName} is not in ${dept.name}`);
    }
    const order = await prisma.$transaction(async (tx) => {
      const o = await createOrder(tx, {
        visitId: visit.id, patientId: visit.patientId, type: 'REFERRAL', priority: input.priority, orderingDoctorId: me.id,
        targetDepartmentId: dept.id, targetDoctorId: toDoctor?.id ?? null, title: `Referral to ${toDoctor ? `${toDoctor.fullName} · ` : ''}${dept.name}`,
        clinicalNotes: input.reason.trim(),
      });
      await tx.referral.create({
        data: { orderId: o.id, patientId: visit.patientId, fromVisitId: visit.id, fromDoctorId: me.id, toDepartmentId: dept.id, toDoctorId: toDoctor?.id ?? null, reason: input.reason.trim() },
      });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.REFERRAL_CREATED, entity: 'referrals', entityId: o.id, patientId: visit.patientId, ip: actor.ip, metadata: { orderNumber: o.orderNumber, toDepartment: dept.code, toDoctor: toDoctor?.staffCode ?? null, priority: input.priority } },
        tx,
      );
      return o;
    });
    emitTo(Rooms.reception, 'board:changed', { kind: 'referral', orderId: order.id });
    return this.get(order.id);
  },

  /* ---------------- Doctor: prescriptions (MEDICATION orders) ---------------- */

  async createPrescription(
    actor: Actor,
    input: {
      visitId: string;
      notes?: string | null;
      items: { medicineId?: string | null; medicineName: string; dose?: string | null; frequency?: string | null; durationDays?: number | null; route?: string | null; instructions?: string | null; quantity?: number | null }[];
    },
  ) {
    const { me, visit } = await writableVisit(actor, input.visitId);
    const pharmacy = await staffService.departmentByCode('PHARM');
    const meds = await pharmacyService.medicinesByIds(input.items.map((i) => i.medicineId).filter((x): x is string => !!x));
    const items = input.items.map((i) => {
      if (i.medicineId && !meds.has(i.medicineId)) throw AppError.badRequest(`${i.medicineName} is not in the pharmacy formulary`);
      const days = i.durationDays ?? null;
      return {
        medicineId: i.medicineId ?? null,
        medicineName: i.medicineName.trim(),
        dose: i.dose?.trim() || null,
        frequency: i.frequency?.trim() || null,
        durationDays: days,
        route: i.route?.trim() || null,
        instructions: i.instructions?.trim() || null,
        quantity: i.quantity ?? Math.max(1, dosesPerDay(i.frequency) * (days ?? 1)),
      };
    });
    const order = await prisma.$transaction(async (tx) => {
      const o = await createOrder(tx, {
        visitId: visit.id, patientId: visit.patientId, type: 'MEDICATION', priority: 'ROUTINE', orderingDoctorId: me.id,
        targetDepartmentId: pharmacy.id, title: items.map((i) => i.medicineName).join(', ').slice(0, 200), clinicalNotes: input.notes?.trim() || null,
      });
      await tx.prescription.create({
        data: { visitId: visit.id, patientId: visit.patientId, doctorId: me.id, orderId: o.id, notes: input.notes?.trim() || null, items: { create: items } },
      });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.PRESCRIPTION_CREATED, entity: 'prescriptions', entityId: o.id, patientId: visit.patientId, ip: actor.ip, metadata: { orderNumber: o.orderNumber, items: items.length } },
        tx,
      );
      return o;
    });
    emitTo(Rooms.department(pharmacy.id), 'orders:changed', { type: 'MEDICATION', orderId: order.id });
    return this.get(order.id);
  },

  /** The ordering doctor may cancel an order nobody has acted on yet. */
  async cancel(actor: Actor, orderId: string, reason: string) {
    const me = await doctorOf(actor);
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, orderingDoctorId: true, status: true, patientId: true, type: true, orderNumber: true, prescription: { select: { id: true } } } });
    if (!o) throw AppError.notFound('Order not found');
    if (o.orderingDoctorId !== me.id) throw AppError.forbidden('Only the ordering doctor can cancel this order');
    await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({ where: { id: orderId, status: 'ORDERED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() } });
      if (!r.count) throw new AppError(409, 'ORDER_IN_PROGRESS', 'This order is already being worked on and can no longer be cancelled.');
      if (o.prescription) await tx.prescription.update({ where: { id: o.prescription.id }, data: { status: 'CANCELLED' } });
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.ORDER_CANCELLED, entity: 'orders', entityId: o.id, patientId: o.patientId, ip: actor.ip, reason, metadata: { orderNumber: o.orderNumber, type: o.type } }, tx);
    });
    if (o.type === 'REFERRAL') emitTo(Rooms.reception, 'board:changed', { kind: 'referral', orderId });
    return this.get(orderId);
  },

  /* ---------------- Reads ---------------- */

  async get(id: string) {
    const row = await prisma.order.findUnique({ where: { id }, select: orderSelect });
    if (!row) throw AppError.notFound('Order not found');
    return (await present([row]))[0]!;
  },

  /** Every order of a patient across all departments (timeline). Callers check access and audit. */
  async forPatient(patientId: string) {
    return present(await prisma.order.findMany({ where: { patientId }, orderBy: { createdAt: 'desc' }, select: orderSelect }));
  },

  async forVisit(visitId: string) {
    return present(await prisma.order.findMany({ where: { visitId }, orderBy: { createdAt: 'asc' }, select: orderSelect }));
  },

  /* ---------------- Care relationship (used by the access layer) ---------------- */

  /** True if a live order or referral for this patient is addressed to this doctor. */
  async isAddressedTo(staffId: string, patientId: string) {
    const [orders, referrals] = await Promise.all([
      prisma.order.count({ where: { patientId, targetDoctorId: staffId, status: { not: 'CANCELLED' } } }),
      prisma.referral.count({ where: { patientId, toDoctorId: staffId, order: { status: { not: 'CANCELLED' } } } }),
    ]);
    return orders + referrals > 0;
  },

  /* ---------------- Referral flow: reception books, the visit links back ---------------- */

  /** REFERRAL orders waiting for reception to book (no clinical reason — reception can't see clinical content). */
  async referralsToBook() {
    const rows = await prisma.order.findMany({
      where: { type: 'REFERRAL', status: 'ORDERED' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, orderNumber: true, patientId: true, priority: true, createdAt: true, orderingDoctorId: true, targetDoctorId: true, targetDepartment: { select: { id: true, code: true, name: true } } },
    });
    const doctors = await staffService.doctorsByIds([...new Set(rows.flatMap((r) => [r.orderingDoctorId, r.targetDoctorId].filter((x): x is string => !!x)))]);
    return rows.map((r) => ({
      orderId: r.id, orderNumber: r.orderNumber, patientId: r.patientId, priority: r.priority, createdAt: r.createdAt,
      fromDoctor: { id: r.orderingDoctorId, name: doctors.get(r.orderingDoctorId)?.fullName ?? 'Doctor', department: doctors.get(r.orderingDoctorId)?.department?.name ?? null },
      toDepartment: r.targetDepartment,
      toDoctor: r.targetDoctorId ? { id: r.targetDoctorId, name: doctors.get(r.targetDoctorId)?.fullName ?? 'Doctor' } : null,
    }));
  },

  /** Checks a referral can be booked for this patient with this doctor (before the hold is confirmed). */
  async assertReferralBookable(orderId: string, input: { patientId: string; doctorId: string; departmentId: string }) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { type: true, status: true, patientId: true, targetDepartmentId: true, targetDoctorId: true, orderingDoctorId: true } });
    if (!o || o.type !== 'REFERRAL') throw AppError.notFound('Referral not found');
    if (o.status !== 'ORDERED') throw new AppError(409, 'REFERRAL_BOOKED', 'This referral has already been booked or cancelled.');
    if (o.patientId !== input.patientId) throw AppError.badRequest('This referral is for a different patient');
    if (o.targetDepartmentId !== input.departmentId) throw AppError.badRequest('Book the referral with a doctor in the department it was sent to');
    if (o.targetDoctorId && o.targetDoctorId !== input.doctorId) throw AppError.badRequest('This referral names a specific doctor — book it with them');
    const from = await staffService.doctorsByIds([o.orderingDoctorId]);
    return { fromDoctorName: from.get(o.orderingDoctorId)?.fullName ?? 'a doctor' };
  },

  /** Inside the booking transaction: ORDERED → SCHEDULED, and the booked doctor becomes the target (gains access). */
  async markReferralBooked(orderId: string, appt: { id: string; ref: string; doctorId: string; slotStart: Date; patientId: string }, actor: Actor, tx: Prisma.TransactionClient) {
    const r = await tx.order.updateMany({ where: { id: orderId, type: 'REFERRAL', status: 'ORDERED', patientId: appt.patientId }, data: { status: 'SCHEDULED', targetDoctorId: appt.doctorId, scheduledFor: appt.slotStart } });
    if (!r.count) throw new AppError(409, 'REFERRAL_BOOKED', 'This referral has already been booked or cancelled.');
    await tx.referral.update({ where: { orderId }, data: { toDoctorId: appt.doctorId } });
    await auditService.record(
      { actorId: actor.session.userId, action: AuditAction.REFERRAL_BOOKED, entity: 'referrals', entityId: orderId, patientId: appt.patientId, ip: actor.ip, metadata: { appointment: appt.ref, appointmentId: appt.id } },
      tx,
    );
  },

  /** Inside cancel: the referral's booking was cancelled → back to ORDERED ("to be booked") so it can be booked again. */
  async releaseReferralBooking(orderId: string, tx: Prisma.TransactionClient) {
    await tx.order.updateMany({ where: { id: orderId, type: 'REFERRAL', status: 'SCHEDULED' }, data: { status: 'ORDERED', scheduledFor: null } });
  },

  /** Inside reschedule: the referral follows its booking to the new slot (and doctor). */
  async moveReferralBooking(orderId: string, appt: { doctorId: string; slotStart: Date }, tx: Prisma.TransactionClient) {
    const r = await tx.order.updateMany({ where: { id: orderId, type: 'REFERRAL', status: 'SCHEDULED' }, data: { targetDoctorId: appt.doctorId, scheduledFor: appt.slotStart } });
    if (r.count) await tx.referral.update({ where: { orderId }, data: { toDoctorId: appt.doctorId } });
  },

  /** Who referred each booking (doctor name + department) — names only, no clinical reason (reception sees these too). */
  async referralSources(orderIds: string[]) {
    const out = new Map<string, { orderId: string; fromDoctor: { id: string; name: string; department: string | null }; createdAt: Date }>();
    if (!orderIds.length) return out;
    const rows = await prisma.order.findMany({ where: { id: { in: [...new Set(orderIds)] }, type: 'REFERRAL' }, select: { id: true, orderingDoctorId: true, createdAt: true } });
    const doctors = await staffService.doctorsByIds([...new Set(rows.map((r) => r.orderingDoctorId))]);
    for (const r of rows) {
      const d = doctors.get(r.orderingDoctorId);
      out.set(r.id, { orderId: r.id, fromDoctor: { id: r.orderingDoctorId, name: d?.fullName ?? 'Doctor', department: d?.department?.name ?? null }, createdAt: r.createdAt });
    }
    return out;
  },

  /* ---------------- Patient portal (own + family; callers check the household and audit) ---------------- */

  /** Referrals the patient still has to book (ORDERED), with the reason — it is the patient's own record. */
  async referralsToBookFor(patientIds: string[]) {
    if (!patientIds.length) return [];
    const rows = await prisma.order.findMany({
      where: { type: 'REFERRAL', status: 'ORDERED', patientId: { in: patientIds } },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true, orderNumber: true, patientId: true, visitId: true, priority: true, createdAt: true, orderingDoctorId: true, targetDoctorId: true,
        targetDepartment: { select: { id: true, code: true, name: true } }, referral: { select: { reason: true } },
      },
    });
    const doctors = await staffService.doctorsByIds([...new Set(rows.flatMap((r) => [r.orderingDoctorId, r.targetDoctorId].filter((x): x is string => !!x)))]);
    return rows.map((r) => ({
      orderId: r.id, orderNumber: r.orderNumber, patientId: r.patientId, fromVisitId: r.visitId, priority: r.priority, createdAt: r.createdAt,
      reason: r.referral?.reason ?? null,
      fromDoctor: { id: r.orderingDoctorId, name: doctors.get(r.orderingDoctorId)?.fullName ?? 'Doctor', department: doctors.get(r.orderingDoctorId)?.department?.name ?? null },
      toDepartment: r.targetDepartment,
      toDoctor: r.targetDoctorId ? { id: r.targetDoctorId, name: doctors.get(r.targetDoctorId)?.fullName ?? 'Doctor' } : null,
    }));
  },

  /** Referral links between a patient's visits (journey edges): from visit → order (→ visit it led to, if seen). */
  async referralLinks(patientIds: string[]) {
    if (!patientIds.length) return [];
    return prisma.referral.findMany({
      where: { patientId: { in: patientIds }, order: { status: { not: 'CANCELLED' } } },
      select: { orderId: true, fromVisitId: true, toVisitId: true },
    });
  },

  /**
   * What the patient may see of the orders on these visits. Patient-facing fields only:
   *   - tests: title, status and — only once RESULT_READY — the findings, values and the report file (never the doctor's indication);
   *   - prescriptions: medicine, dose, frequency, days, instructions, dispensed or not (never the prescriber's notes);
   *   - referrals: where to, reason, status, and the visit it led to.
   */
  async patientFacingForVisits(visitIds: string[]) {
    if (!visitIds.length) return [];
    const rows = await present(await prisma.order.findMany({ where: { visitId: { in: visitIds } }, orderBy: { createdAt: 'asc' }, select: orderSelect }));
    return rows.map((o) => {
      const base = { id: o.id, orderNumber: o.orderNumber, visitId: o.visitId, type: o.type, status: o.status, title: o.title, createdAt: o.createdAt, orderingDoctor: { id: o.orderingDoctor.id, name: o.orderingDoctor.name } };
      if (o.type === 'LAB' || o.type === 'RADIOLOGY') {
        const ready = o.status === 'RESULT_READY';
        return {
          ...base, department: o.targetDepartment.name,
          results: ready ? o.results.map((r) => ({ id: r.id, summary: r.summary, values: r.values, isAbnormal: r.isAbnormal, fileUrl: r.fileUrl, reportedAt: r.reportedAt })) : [],
        };
      }
      if (o.type === 'REFERRAL') {
        return {
          ...base, department: o.targetDepartment.name,
          referral: { reason: o.referral?.reason ?? null, toDepartment: o.targetDepartment, toDoctor: o.targetDoctor, toVisitId: o.referral?.toVisitId ?? null, scheduledFor: o.scheduledFor },
        };
      }
      return {
        ...base, department: o.targetDepartment.name,
        prescription: o.prescription
          ? {
              id: o.prescription.id, status: o.status === 'CANCELLED' ? 'CANCELLED' : o.prescription.status,
              items: o.prescription.items.map((i) => ({
                id: i.id, medicineName: i.medicineName, dose: i.dose, frequency: i.frequency, durationDays: i.durationDays, route: i.route, instructions: i.instructions,
                quantity: i.quantity, dispensedQuantity: i.dispensedQuantity, dispensed: i.dispensedQuantity >= i.quantity,
              })),
            }
          : null,
      };
    });
  },

  /** Inside check-in / walk-in: the patient arrived for a booked referral → link the visit, SCHEDULED → IN_PROGRESS. */
  async attachReferralVisit(input: { patientId: string; doctorId: string; visitId: string; orderId?: string | null }, tx: Prisma.TransactionClient) {
    // The booking's own referral when known; otherwise a referral already booked with this doctor wins over one
    // still waiting to be booked (oldest first within each).
    const find = (statuses: OrderStatus[]) =>
      tx.referral.findFirst({
        where: {
          patientId: input.patientId, toDoctorId: input.doctorId, toVisitId: null, order: { status: { in: statuses } },
          ...(input.orderId ? { orderId: input.orderId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, orderId: true },
      });
    const ref = (await find(['SCHEDULED'])) ?? (await find(['ORDERED']));
    if (!ref) return null;
    await tx.referral.update({ where: { id: ref.id }, data: { toVisitId: input.visitId } });
    await tx.order.update({ where: { id: ref.orderId }, data: { status: 'IN_PROGRESS', startedAt: new Date(), targetDoctorId: input.doctorId } });
    return ref.orderId;
  },

  /** Inside visit completion: the referral this visit answered is COMPLETED. */
  async completeReferralForVisit(visitId: string, tx: Prisma.TransactionClient) {
    const ref = await tx.referral.findFirst({ where: { toVisitId: visitId }, select: { orderId: true } });
    if (!ref) return;
    await tx.order.updateMany({ where: { id: ref.orderId, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: new Date() } });
  },

  /** The referral (with reason) that brought the patient to this visit, if any. Callers check access. */
  async referralForVisit(visitId: string, patientId: string, doctorId: string) {
    const ref =
      (await prisma.referral.findFirst({ where: { toVisitId: visitId }, select: { orderId: true } })) ??
      (await prisma.referral.findFirst({ where: { patientId, toDoctorId: doctorId, order: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } } }, orderBy: { createdAt: 'desc' }, select: { orderId: true } }));
    return ref ? this.get(ref.orderId) : null;
  },

  /** Patients with an open referral addressed to this doctor (flag on the doctor's schedule). */
  async openReferralPatientIds(doctorId: string) {
    const rows = await prisma.referral.findMany({ where: { toDoctorId: doctorId, order: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } } }, select: { patientId: true } });
    return new Set(rows.map((r) => r.patientId));
  },

  /* ---------------- Department queues: lab and radiology ---------------- */

  /**
   * The technician's queue: their department's orders of this type. A technician filed under another kind of department
   * (e.g. a new hire still in Administration) sees every department of the matching kind.
   * Rows carry what the bench needs — patient name + MRN, test, ordering doctor, urgency, status — and NO clinical notes
   * (the doctor's indication stays on the doctor's side).
   */
  async queue(actor: Actor, type: QueueType) {
    const depts = await queueDepartments(actor, type);
    const deptIds = depts.map((d) => d.id);
    const { start } = localDayRange(localDateKey());
    const rows = await prisma.order.findMany({
      where: {
        type, targetDepartmentId: { in: deptIds },
        OR: [{ status: { in: ACTIVE_QUEUE } }, { status: 'RESULT_READY', resultReadyAt: { gte: start } }],
      },
      orderBy: [{ createdAt: 'asc' }],
      select: queueSelect,
    });
    const [patients, doctors] = await Promise.all([
      patientsService.headers(rows.map((r) => r.patientId)),
      staffService.doctorsByIds([...new Set(rows.flatMap((r) => [r.orderingDoctorId, ...r.results.map((x) => x.reportedById)]))]),
    ]);
    const PRIORITY_RANK = { STAT: 0, URGENT: 1, ROUTINE: 2 } as const;
    const items = rows
      .map((r) => {
        const p = patients.get(r.patientId);
        const doc = doctors.get(r.orderingDoctorId);
        return {
          id: r.id, orderNumber: r.orderNumber, type: r.type, status: r.status, priority: r.priority, title: r.title,
          createdAt: r.createdAt, startedAt: r.startedAt, resultReadyAt: r.resultReadyAt,
          department: r.targetDepartment,
          patient: p ? { id: p.id, name: p.name, mrn: p.mrn, gender: p.gender, age: p.age } : null,
          orderingDoctor: { id: r.orderingDoctorId, name: doc?.fullName ?? 'Doctor', department: doc?.department?.name ?? null },
          result: r.results[0] ? { id: r.results[0].id, summary: r.results[0].summary, isAbnormal: r.results[0].isAbnormal, fileUrl: r.results[0].fileUrl, reportedAt: r.results[0].reportedAt } : null,
        };
      })
      .sort((a, b) => {
        const done = Number(a.status === 'RESULT_READY') - Number(b.status === 'RESULT_READY');
        if (done) return done;
        if (a.status === 'RESULT_READY') return +b.resultReadyAt! - +a.resultReadyAt!;
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || +a.createdAt - +b.createdAt;
      });
    const pending = items.filter((i) => i.status !== 'RESULT_READY');
    return {
      type,
      departments: depts,
      stats: {
        toCollect: pending.filter((i) => i.status === 'ORDERED' || i.status === 'SCHEDULED').length,
        inProgress: pending.filter((i) => i.status === 'IN_PROGRESS').length,
        urgent: pending.filter((i) => i.priority !== 'ROUTINE').length,
        readyToday: items.length - pending.length,
      },
      items,
    };
  },

  /** "Sample collected" (lab) / "Scan done" (radiology): ORDERED|SCHEDULED → IN_PROGRESS, assigned to the technician. */
  async markInProgress(actor: Actor, orderId: string) {
    const o = await queueOrder(actor, orderId);
    const tech = await techOf(actor);
    await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({ where: { id: o.id, status: { in: ['ORDERED', 'SCHEDULED'] } }, data: { status: 'IN_PROGRESS', startedAt: new Date(), assignedToId: tech.id } });
      if (!r.count) throw new AppError(409, 'ORDER_NOT_WAITING', 'This order is no longer waiting — refresh the queue.');
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.ORDER_STARTED, entity: 'orders', entityId: o.id, patientId: o.patientId, ip: actor.ip ?? null, metadata: { orderNumber: o.orderNumber, type: o.type } },
        tx,
      );
    });
    emitTo(Rooms.department(o.targetDepartmentId), 'orders:changed', { type: o.type, orderId: o.id });
    return this.queueItem(o.id);
  },

  /**
   * Upload the result: text findings + optional PDF/image. IN_PROGRESS → RESULT_READY in one transaction with the
   * order_results row and the charge (price and department from the catalogue). Then the ordering doctor gets an in-app alert.
   */
  async uploadResult(actor: Actor, orderId: string, input: { summary: string; isAbnormal: boolean; file?: { base64: string } | null }) {
    const o = await queueOrder(actor, orderId);
    const tech = await techOf(actor);
    if (o.status !== 'IN_PROGRESS') {
      throw new AppError(409, 'ORDER_NOT_IN_PROGRESS', o.status === 'RESULT_READY' ? 'A result has already been uploaded for this order.' : `Mark the ${o.type === 'LAB' ? 'sample collected' : 'scan done'} first.`);
    }
    if (!o.catalogueItemId) throw new AppError(409, 'NO_CATALOGUE_ITEM', 'This order has no price in the service catalogue.');
    const file = input.file ? decodeUpload(input.file.base64) : null;
    const resultId = randomUUID();
    const stored = file ? await saveUpload(RESULTS_FOLDER, resultId, file) : null;
    const now = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        const r = await tx.order.updateMany({ where: { id: o.id, status: 'IN_PROGRESS' }, data: { status: 'RESULT_READY', completedAt: now, resultReadyAt: now, assignedToId: tech.id } });
        if (!r.count) throw new AppError(409, 'ORDER_NOT_IN_PROGRESS', 'A result has already been uploaded for this order.');
        await tx.orderResult.create({
          data: { id: resultId, orderId: o.id, reportedById: tech.id, summary: input.summary.trim(), isAbnormal: input.isAbnormal, fileUrl: file ? resultFileUrl(resultId) : null, reportedAt: now },
        });
        const charge = await billingService.addOrderCharge({ visitId: o.visitId, orderId: o.id, catalogueItemId: o.catalogueItemId!, createdById: tech.id }, tx);
        await auditService.record(
          { actorId: actor.session.userId, action: AuditAction.RESULT_UPLOADED, entity: 'order_results', entityId: resultId, patientId: o.patientId, ip: actor.ip ?? null, metadata: { orderNumber: o.orderNumber, type: o.type, abnormal: input.isAbnormal, file: file ? file.mimeType : null } },
          tx,
        );
        await auditService.record(
          { actorId: actor.session.userId, action: AuditAction.CHARGE_CREATED, entity: 'charges', entityId: charge.id, patientId: o.patientId, ip: actor.ip ?? null, metadata: { orderNumber: o.orderNumber, totalPaise: charge.totalPaise } },
          tx,
        );
      });
    } catch (err) {
      if (stored) await removeUpload(stored);
      throw err;
    }

    await this.notifyResultReady(o, input.isAbnormal);
    emitTo(Rooms.department(o.targetDepartmentId), 'orders:changed', { type: o.type, orderId: o.id });
    billingService.notifyCharged(o.patientId);
    return this.queueItem(o.id);
  },

  /** In-app alert to the ordering doctor. Never fails the technician's upload. */
  async notifyResultReady(o: { id: string; orderNumber: string; title: string; patientId: string; orderingDoctorId: string }, abnormal: boolean) {
    try {
      const [doctor, patient] = await Promise.all([staffService.doctorsByIds([o.orderingDoctorId]).then((m) => m.get(o.orderingDoctorId)), patientsService.getSummary(o.patientId)]);
      if (!doctor) return;
      await notificationsService.inApp(doctor.userId, {
        subject: `${abnormal ? 'Abnormal result' : 'Result ready'}: ${o.title}`,
        body: `${o.title} for ${patient.name} (${patient.mrn}) is on the timeline. Order ${o.orderNumber}.`,
        data: { kind: 'RESULT_READY', orderId: o.id, patientId: o.patientId, abnormal },
      });
    } catch (err) {
      console.error('[orders] result notification failed:', err instanceof Error ? err.message : err);
    }
  },

  /** One queue row (after an action). */
  async queueItem(orderId: string) {
    const o = await this.get(orderId);
    const p = (await patientsService.headers([o.patientId])).get(o.patientId);
    return {
      id: o.id, orderNumber: o.orderNumber, type: o.type, status: o.status, priority: o.priority, title: o.title,
      patient: p ? { id: p.id, name: p.name, mrn: p.mrn } : null,
      result: o.results[0] ? { id: o.results[0].id, summary: o.results[0].summary, isAbnormal: o.results[0].isAbnormal, fileUrl: o.results[0].fileUrl } : null,
    };
  },

  /** Who may download a result file is decided by the route; this only finds the result and its order. */
  async resultRef(resultId: string) {
    const r = await prisma.orderResult.findUnique({ where: { id: resultId }, select: { id: true, fileUrl: true, order: { select: { id: true, type: true, patientId: true, targetDepartmentId: true, orderNumber: true } } } });
    if (!r || !r.fileUrl) throw AppError.notFound('Report not found');
    const { id: orderId, ...order } = r.order;
    return { ...order, id: r.id, orderId };
  },

  /* ---------------- Pharmacy reads / writes (called by the pharmacy module) ---------------- */

  /** Prescriptions waiting to be dispensed (ACTIVE or PARTIALLY_DISPENSED, order not cancelled). */
  async prescriptionsToDispense() {
    const rows = await prisma.prescription.findMany({
      where: { status: { in: ['ACTIVE', 'PARTIALLY_DISPENSED'] }, OR: [{ orderId: null }, { order: { status: { not: 'CANCELLED' } } }] },
      orderBy: { createdAt: 'asc' },
      select: rxSelect,
    });
    return rows.map(presentRx);
  },

  async prescription(id: string) {
    const row = await prisma.prescription.findUnique({ where: { id }, select: rxSelect });
    if (!row) throw AppError.notFound('Prescription not found');
    return presentRx(row);
  },

  /** Prescriptions fully dispensed since `since` (pharmacy stat). */
  dispensedSince(since: Date) {
    return prisma.prescription.count({ where: { status: 'DISPENSED', updatedAt: { gte: since } } });
  },

  /**
   * Inside the dispense transaction: adds `quantity` to the item's dispensed count (never past what was prescribed),
   * then rolls the prescription and its MEDICATION order forward. The prescription itself is never edited.
   */
  async recordDispensed(prescriptionId: string, itemId: string, quantity: number, tx: Prisma.TransactionClient) {
    const n = await tx.$executeRaw`
      UPDATE prescription_items SET dispensed_quantity = dispensed_quantity + ${quantity}
      WHERE id = ${itemId}::uuid AND prescription_id = ${prescriptionId}::uuid AND dispensed_quantity + ${quantity} <= quantity`;
    if (!n) throw new AppError(409, 'OVER_DISPENSE', 'That is more than is left to dispense on this prescription.');
  },

  /** After all items of one dispense: DISPENSED when every item is complete, else PARTIALLY_DISPENSED. */
  async settlePrescription(prescriptionId: string, tx: Prisma.TransactionClient) {
    const rx = await tx.prescription.findUniqueOrThrow({ where: { id: prescriptionId }, select: { orderId: true, items: { select: { quantity: true, dispensedQuantity: true } } } });
    const full = rx.items.every((i) => i.dispensedQuantity >= i.quantity);
    const status: PrescriptionStatus = full ? 'DISPENSED' : 'PARTIALLY_DISPENSED';
    await tx.prescription.update({ where: { id: prescriptionId }, data: { status } });
    if (rx.orderId) {
      const now = new Date();
      await tx.order.update({
        where: { id: rx.orderId },
        data: full ? { status: 'COMPLETED', completedAt: now } : { status: 'IN_PROGRESS', startedAt: now },
      });
    }
    return status;
  },

  /** Referrals addressed to this doctor (doctor home side card). Names only — the reason opens with the record. */
  async incomingReferrals(doctorId: string) {
    const rows = await prisma.order.findMany({
      where: { type: 'REFERRAL', targetDoctorId: doctorId, status: { in: ['ORDERED', 'SCHEDULED', 'IN_PROGRESS'] as OrderStatus[] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, orderNumber: true, patientId: true, status: true, priority: true, scheduledFor: true, createdAt: true, orderingDoctorId: true },
    });
    const from = await staffService.doctorsByIds([...new Set(rows.map((r) => r.orderingDoctorId))]);
    return rows.map((r) => ({ ...r, fromDoctor: { id: r.orderingDoctorId, name: from.get(r.orderingDoctorId)?.fullName ?? 'Doctor', department: from.get(r.orderingDoctorId)?.department?.name ?? null } }));
  },
};
