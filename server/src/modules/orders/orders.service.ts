import type { OrderPriority, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitTo, Rooms } from '../../lib/socket.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { billingService } from '../billing/billing.service.js';
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

  /** Inside check-in / walk-in: the patient arrived for a booked referral → link the visit, SCHEDULED → IN_PROGRESS. */
  async attachReferralVisit(input: { patientId: string; doctorId: string; visitId: string }, tx: Prisma.TransactionClient) {
    const ref = await tx.referral.findFirst({
      where: { patientId: input.patientId, toDoctorId: input.doctorId, toVisitId: null, order: { status: { in: ['ORDERED', 'SCHEDULED'] } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, orderId: true },
    });
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
