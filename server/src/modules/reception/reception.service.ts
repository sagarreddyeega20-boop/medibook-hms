import type { Prisma, QueueEventType } from '@prisma/client';
import { AppError, isUniqueViolation } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitScheduleChanged } from '../../lib/socket.js';
import { localDateKey } from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { billingService } from '../billing/billing.service.js';
import { ordersService } from '../orders/orders.service.js';
import { patientsService } from '../patients/patients.service.js';
import { schedulingService, type Slot } from '../scheduling/scheduling.service.js';
import { staffService } from '../staff/staff.service.js';
import { visitsService, type VisitRow } from '../visits/visits.service.js';

/**
 * Reception service — Live reception board: calculated doctor status, check-in, queue tokens, walk-ins.
 * Owns: queue_events
 * Other modules must call this service, never these tables directly.
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

/** Status is calculated, never typed. */
export type DoctorStatus = 'OFF_DUTY' | 'ON_LEAVE' | 'AVAILABLE' | 'IN_CONSULTATION' | 'RUNNING_LATE';

/** A queue is "running late" when the longest-waiting booked patient is this far past their slot. */
export const RUNNING_LATE_MINUTES = 15;

/** Queue tokens restart at 1 per doctor per hospital day. */
const nextToken = (doctorId: string, tx: Prisma.TransactionClient) => nextSequence(`token:${doctorId}:${localDateKey()}`, tx);

async function queueEvents(tx: Prisma.TransactionClient, base: { visitId: string; patientId: string; doctorId: string; appointmentId?: string | null; tokenNumber?: number | null }, types: QueueEventType[]) {
  await tx.queueEvent.createMany({ data: types.map((type) => ({ ...base, appointmentId: base.appointmentId ?? null, tokenNumber: base.tokenNumber ?? null, type })) });
}

/**
 * Calculated doctor status, in priority order:
 *   ON_LEAVE (a leave covers now) → RUNNING_LATE (oldest waiting booked patient > 15 min past their slot)
 *   → IN_CONSULTATION (a visit is in consultation) → OFF_DUTY (outside today's schedule) → AVAILABLE.
 */
export function calculateStatus(input: {
  onLeave: boolean;
  onDuty: boolean;
  inConsultation: boolean;
  oldestWaitingSlotStart: Date | null;
  now?: Date;
}): { status: DoctorStatus; lateByMinutes: number } {
  const now = input.now ?? new Date();
  const late = input.oldestWaitingSlotStart ? Math.floor((now.getTime() - input.oldestWaitingSlotStart.getTime()) / 60_000) : 0;
  if (input.onLeave) return { status: 'ON_LEAVE', lateByMinutes: 0 };
  if (late > RUNNING_LATE_MINUTES) return { status: 'RUNNING_LATE', lateByMinutes: late };
  if (input.inConsultation) return { status: 'IN_CONSULTATION', lateByMinutes: Math.max(0, late) };
  if (!input.onDuty) return { status: 'OFF_DUTY', lateByMinutes: 0 };
  return { status: 'AVAILABLE', lateByMinutes: Math.max(0, late) };
}

export const receptionService = {
  /* ---------------- Live board ---------------- */

  async board(opts: { date?: string; departmentId?: string; viewerUserId?: string } = {}) {
    const today = localDateKey();
    const date = opts.date ?? today;
    const doctors = (await staffService.listDoctors({ departmentId: opts.departmentId })).filter((d) => d.department);
    const ids = doctors.map((d) => d.id);
    const now = new Date();

    const [days, todays, availability, visits, nextFree] = await Promise.all([
      schedulingService.daySlotsMany(ids, date, opts.viewerUserId),
      date === today ? null : schedulingService.daySlotsMany(ids, today, opts.viewerUserId),
      schedulingService.availabilityNow(ids, now),
      visitsService.queueForDoctors(ids, today),
      schedulingService.nextFreeSlots(ids, today),
    ]);
    const todaySlots = todays ?? days;

    const patientIds = new Set<string>(visits.map((v) => v.patientId));
    for (const d of days.values()) for (const s of d.slots) if (s.appointment) patientIds.add(s.appointment.patientId);
    const apptIds: string[] = [];
    for (const d of days.values()) for (const s of d.slots) if (s.appointment) apptIds.push(s.appointment.id);
    const [patients, prepaid] = await Promise.all([patientsService.summaries([...patientIds]), billingService.prepaidStatus(apptIds)]);
    const who = (id: string) => {
      const p = patients.get(id);
      return p ? { id: p.id, name: p.name, mrn: p.mrn, phone: p.phone } : null;
    };

    const board = doctors.map((d) => {
      const day = days.get(d.id)!;
      const mine = visits.filter((v) => v.doctorId === d.id);
      const current = mine.find((v) => v.status === 'IN_CONSULTATION') ?? null;
      const waiting = mine.filter((v) => v.status === 'OPEN');
      // The slot each waiting OPD patient was booked for (walk-ins have none).
      const slotOf = (v: VisitRow) => todaySlots.get(d.id)!.slots.find((s) => s.appointment?.id === v.appointmentId);
      const waitingSlots = waiting.map((v) => slotOf(v)?.start).filter((x): x is string => !!x).sort();
      const a = availability.get(d.id)!;
      const { status, lateByMinutes } = calculateStatus({
        onLeave: a.onLeave, onDuty: a.onDuty, inConsultation: !!current, oldestWaitingSlotStart: waitingSlots[0] ? new Date(waitingSlots[0]) : null, now,
      });
      const free = nextFree.get(d.id);
      return {
        id: d.id,
        name: d.fullName,
        specialty: d.specialty,
        department: d.department,
        consultationFeePaise: d.consultationFeePaise,
        status,
        lateByMinutes,
        leaveReason: a.leaveReason,
        worksToday: a.worksToday,
        current: current ? { visitId: current.id, token: current.tokenNumber, type: current.type, patient: who(current.patientId), since: current.consultStartedAt } : null,
        queue: waiting.map((v) => ({ visitId: v.id, token: v.tokenNumber, type: v.type, patient: who(v.patientId), slotStart: slotOf(v)?.start ?? null, appointmentId: v.appointmentId, arrivedAt: v.startedAt })),
        done: mine.filter((v) => v.status === 'COMPLETED').length,
        nextFreeSlot: free ? { start: free.start, end: free.end } : null,
        windows: day.windows,
        leaves: day.leaves,
        slots: day.slots.map((s: Slot) => ({ ...s, patient: s.appointment ? who(s.appointment.patientId) : null, payment: s.appointment ? (prepaid.get(s.appointment.id) ?? null) : null })),
      };
    });

    const [apptCounts, visitCounts] = await Promise.all([schedulingService.countsForDay(date), visitsService.countsForDay(date)]);
    const booked = Object.entries(apptCounts).filter(([s]) => s !== 'CANCELLED').reduce((n, [, c]) => n + (c ?? 0), 0);
    return {
      date,
      today,
      generatedAt: now.toISOString(),
      stats: {
        appointments: booked,
        checkedIn: visitCounts.OPD ?? 0,
        walkIns: visitCounts.WALK_IN ?? 0,
        cancelled: apptCounts.CANCELLED ?? 0,
        doctorsAvailable: board.filter((d) => d.status === 'AVAILABLE').length,
        doctorsOnDuty: board.filter((d) => d.status !== 'OFF_DUTY' && d.status !== 'ON_LEAVE').length,
      },
      doctors: board,
    };
  },

  /* ---------------- Check-in: booked appointment → OPD visit + token ---------------- */

  async checkIn(actor: Actor, appointmentId: string) {
    const appt = await schedulingService.getAppointment(appointmentId);
    if (appt.status !== 'BOOKED') throw new AppError(409, 'NOT_CHECKABLE', `This appointment is ${appt.status.toLowerCase().replace('_', ' ')}, so it can't be checked in.`);
    if (localDateKey(appt.slotStart) !== localDateKey()) throw new AppError(400, 'NOT_TODAY', 'Only today’s appointments can be checked in.');
    let visit: VisitRow;
    try {
      visit = await prisma.$transaction(async (tx) => {
        const token = await nextToken(appt.doctorId, tx);
        const v = await visitsService.create(
          { patientId: appt.patientId, doctorId: appt.doctorId, departmentId: appt.departmentId, type: 'OPD', appointmentId: appt.id, tokenNumber: token, chiefComplaint: appt.reason },
          tx,
        );
        await schedulingService.markCheckedIn(appt.id, token, tx);
        await billingService.attachPrepaidToVisit(appt.id, v.id, tx); // a prepaid consultation's bill becomes the visit's bill
        await ordersService.attachReferralVisit({ patientId: v.patientId, doctorId: v.doctorId, visitId: v.id }, tx);
        await queueEvents(tx, { visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, appointmentId: appt.id, tokenNumber: token }, ['CHECKED_IN', 'TOKEN_ISSUED']);
        await auditService.record(
          { actorId: actor.session.userId, action: AuditAction.CHECKED_IN, entity: 'visits', entityId: v.id, patientId: v.patientId, ip: actor.ip, metadata: { ref: appt.ref, token, visitNumber: v.visitNumber } },
          tx,
        );
        return v;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'NOT_CHECKABLE', 'This appointment is already checked in.');
      throw err;
    }
    emitScheduleChanged({ doctorId: visit.doctorId, date: localDateKey(), kind: 'checked-in' });
    return { visit, token: visit.tokenNumber, ref: appt.ref };
  },

  /* ---------------- Walk-in: visit WITHOUT an appointment ---------------- */

  async walkIn(actor: Actor, input: { patientId: string; doctorId: string; complaint?: string | null }) {
    const [patient, doctor] = await Promise.all([patientsService.getSummary(input.patientId), staffService.doctorById(input.doctorId)]);
    if (!doctor.isActive || !doctor.department) throw AppError.badRequest('This doctor is not taking patients');
    const a = (await schedulingService.availabilityNow([doctor.id])).get(doctor.id)!;
    if (a.onLeave) throw new AppError(409, 'DOCTOR_ON_LEAVE', `${doctor.fullName} is on leave${a.leaveReason ? ` (${a.leaveReason})` : ''}. Choose another doctor.`);
    const visit = await prisma.$transaction(async (tx) => {
      const token = await nextToken(doctor.id, tx);
      const v = await visitsService.create(
        { patientId: patient.id, doctorId: doctor.id, departmentId: doctor.department!.id, type: 'WALK_IN', tokenNumber: token, chiefComplaint: input.complaint },
        tx,
      );
      await queueEvents(tx, { visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, tokenNumber: token }, ['CHECKED_IN', 'TOKEN_ISSUED']);
      await ordersService.attachReferralVisit({ patientId: v.patientId, doctorId: v.doctorId, visitId: v.id }, tx);
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.WALK_IN_REGISTERED, entity: 'visits', entityId: v.id, patientId: v.patientId, ip: actor.ip, metadata: { token, doctor: doctor.staffCode, visitNumber: v.visitNumber, offDuty: !a.onDuty } },
        tx,
      );
      return v;
    });
    emitScheduleChanged({ doctorId: doctor.id, date: localDateKey(), kind: 'walk-in' });
    return { visit, token: visit.tokenNumber, doctor: { id: doctor.id, name: doctor.fullName }, patient: { id: patient.id, name: patient.name, mrn: patient.mrn } };
  },

  /* ---------------- Queue moves (call in / finish) ---------------- */

  /** REFERRAL orders waiting to be booked ("to book" on the board). */
  async referralsToBook() {
    const rows = await ordersService.referralsToBook();
    const patients = await patientsService.summaries(rows.map((r) => r.patientId));
    return rows.map((r) => {
      const p = patients.get(r.patientId);
      return { ...r, patient: p ? { id: p.id, name: p.name, mrn: p.mrn, phone: p.phone } : null };
    });
  },

  async callIn(actor: Actor, visitId: string) {
    const visit = await prisma.$transaction(async (tx) => {
      const v = await visitsService.startConsult(visitId, tx);
      if (v.appointmentId) await schedulingService.setQueueStatus(v.appointmentId, 'IN_CONSULTATION', tx);
      await queueEvents(tx, { visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, appointmentId: v.appointmentId, tokenNumber: v.tokenNumber }, ['CALLED', 'CONSULT_STARTED']);
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.CONSULT_STARTED, entity: 'visits', entityId: v.id, patientId: v.patientId, ip: actor.ip, metadata: { token: v.tokenNumber } }, tx);
      return v;
    });
    emitScheduleChanged({ doctorId: visit.doctorId, date: localDateKey(), kind: 'consult-started' });
    return visit;
  },

  /** Ends the consultation: visit COMPLETED, a consultation charge for the doctor's department, any referral it answered COMPLETED. */
  async finish(actor: Actor, visitId: string) {
    const before = await visitsService.get(visitId);
    const doctor = await staffService.doctorById(before.doctorId);
    const visit = await prisma.$transaction(async (tx) => {
      const v = await visitsService.complete(visitId, tx);
      if (v.appointmentId) await schedulingService.setQueueStatus(v.appointmentId, 'COMPLETED', tx);
      const charge = await billingService.addConsultationCharge(
        { visitId: v.id, staffCode: doctor.staffCode, departmentCode: doctor.department?.code ?? null, doctorName: doctor.fullName, createdById: doctor.id },
        tx,
      );
      if (charge) {
        await auditService.record({ actorId: actor.session.userId, action: AuditAction.CHARGE_CREATED, entity: 'charges', entityId: charge.id, patientId: v.patientId, ip: actor.ip, metadata: { visitNumber: v.visitNumber, totalPaise: charge.totalPaise, kind: 'CONSULTATION' } }, tx);
      }
      await ordersService.completeReferralForVisit(v.id, tx);
      await queueEvents(tx, { visitId: v.id, patientId: v.patientId, doctorId: v.doctorId, appointmentId: v.appointmentId, tokenNumber: v.tokenNumber }, ['CONSULT_ENDED']);
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.CONSULT_ENDED, entity: 'visits', entityId: v.id, patientId: v.patientId, ip: actor.ip, metadata: { token: v.tokenNumber } }, tx);
      return v;
    });
    emitScheduleChanged({ doctorId: visit.doctorId, date: localDateKey(), kind: 'consult-ended' });
    billingService.notifyCharged(visit.patientId);
    return visit;
  },
};
