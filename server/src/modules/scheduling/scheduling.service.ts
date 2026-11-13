import { randomUUID } from 'node:crypto';
import type { AppointmentStatus, BookingSource, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError, isUniqueViolation } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitScheduleChanged } from '../../lib/socket.js';
import {
  addDays, atLocalMinute, formatLocal, localDateKey, localDayOfWeek, localDayRange, localMidnight, minuteLabel,
} from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService, type Doctor } from '../staff/staff.service.js';

/**
 * Scheduling service — Doctor schedules and leaves, slot generation, appointments, Redis slot holds.
 * Owns: doctor_schedules, doctor_leaves, appointments
 * Other modules must call this service, never these tables directly.
 *
 * Booking is two steps, the same for reception, the patient portal and the chatbot:
 *   1. hold(slot)  → Redis SET NX with a 10-minute TTL; a second hold on the same slot is refused.
 *   2. book(hold)  → INSERT into appointments. The partial unique index
 *      appointments_doctor_slot_active_uniq (doctor_id, slot_start) WHERE status <> 'CANCELLED'
 *      is the final guard: if two bookings for one slot ever reach the database, the second fails.
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

export type SlotState = 'FREE' | 'HELD' | 'BOOKED' | 'CHECKED_IN' | 'DONE' | 'CANCELLED';

export interface Slot {
  start: string; // ISO UTC
  end: string;
  state: SlotState;
  past: boolean;
  bookable: boolean;
  heldByMe?: boolean;
  offSchedule?: boolean; // an appointment outside today's schedule (schedule edited after booking)
  appointment?: { id: string; ref: string; patientId: string; status: AppointmentStatus; tokenNumber: number | null; reason: string | null; source: BookingSource };
}

export interface ScheduleWindow {
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}

interface HoldRecord {
  holdId: string;
  doctorId: string;
  slotStart: string;
  slotEnd: string;
  userId: string;
  createdAt: string;
}

const ACTIVE: AppointmentStatus[] = ['BOOKED', 'CHECKED_IN', 'IN_CONSULTATION', 'COMPLETED', 'NO_SHOW'];
const STATE_OF: Record<AppointmentStatus, SlotState> = {
  HELD: 'HELD', BOOKED: 'BOOKED', CHECKED_IN: 'CHECKED_IN', IN_CONSULTATION: 'CHECKED_IN', COMPLETED: 'DONE', NO_SHOW: 'BOOKED', CANCELLED: 'CANCELLED',
};

/* ---------------- Redis holds ---------------- */

const holdKey = (doctorId: string, slotStartIso: string) => `hold:slot:${doctorId}:${slotStartIso}`;
const holdIdKey = (holdId: string) => `hold:id:${holdId}`;
const userHoldKey = (userId: string) => `hold:user:${userId}`;

async function loadHold(holdId: string): Promise<HoldRecord | null> {
  const key = await redis.get(holdIdKey(holdId));
  if (!key) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  const rec = JSON.parse(raw) as HoldRecord;
  return rec.holdId === holdId ? rec : null;
}

async function dropHold(rec: HoldRecord) {
  // Only delete the slot key if it still belongs to this hold.
  const key = holdKey(rec.doctorId, rec.slotStart);
  const raw = await redis.get(key);
  const multi = redis.multi().del(holdIdKey(rec.holdId));
  if (raw && (JSON.parse(raw) as HoldRecord).holdId === rec.holdId) multi.del(key);
  const userHold = await redis.get(userHoldKey(rec.userId));
  if (userHold === rec.holdId) multi.del(userHoldKey(rec.userId));
  await multi.exec();
}

const expiryTimers = new Map<string, NodeJS.Timeout>();
/** Holds expire silently in Redis; tell live screens when one lapses so the slot shows free again. */
function announceExpiry(rec: HoldRecord) {
  const t = setTimeout(async () => {
    expiryTimers.delete(rec.holdId);
    if (!(await loadHold(rec.holdId).catch(() => null))) emitScheduleChanged({ doctorId: rec.doctorId, date: localDateKey(new Date(rec.slotStart)), kind: 'hold-expired' });
  }, env.SLOT_HOLD_SECONDS * 1000 + 500);
  t.unref();
  expiryTimers.set(rec.holdId, t);
}

/* ---------------- Slot generation ---------------- */

async function windowsFor(doctorIds: string[], dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const rows = await prisma.doctorSchedule.findMany({
    where: {
      doctorId: { in: doctorIds }, dayOfWeek: localDayOfWeek(dateKey), isActive: true,
      AND: [{ OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: date } }] }, { OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] }],
    },
    orderBy: { startMinute: 'asc' },
    select: { doctorId: true, startMinute: true, endMinute: true, slotMinutes: true },
  });
  const out = new Map<string, ScheduleWindow[]>(doctorIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.doctorId)!.push({ startMinute: r.startMinute, endMinute: r.endMinute, slotMinutes: r.slotMinutes });
  return out;
}

async function leavesBetween(doctorIds: string[], start: Date, end: Date) {
  return prisma.doctorLeave.findMany({
    where: { doctorId: { in: doctorIds }, startsAt: { lt: end }, endsAt: { gt: start } },
    select: { id: true, doctorId: true, startsAt: true, endsAt: true, reason: true },
  });
}

export interface DaySlots {
  date: string;
  windows: ScheduleWindow[];
  leaves: { startsAt: Date; endsAt: Date; reason: string | null }[];
  slots: Slot[];
}

/** Every doctor's slots for a local day, with their state (free / held / booked / checked-in / done / cancelled). */
async function daySlotsMany(doctorIds: string[], dateKey: string, viewerUserId?: string): Promise<Map<string, DaySlots>> {
  const { start: dayStart, end: dayEnd } = localDayRange(dateKey);
  const [windows, leaves, appts] = await Promise.all([
    windowsFor(doctorIds, dateKey),
    leavesBetween(doctorIds, dayStart, dayEnd),
    prisma.appointment.findMany({
      where: { doctorId: { in: doctorIds }, slotStart: { gte: dayStart, lt: dayEnd } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, ref: true, doctorId: true, patientId: true, status: true, tokenNumber: true, reason: true, source: true, slotStart: true, slotEnd: true },
    }),
  ]);
  const now = Date.now();
  const result = new Map<string, DaySlots>();

  for (const doctorId of doctorIds) {
    const myLeaves = leaves.filter((l) => l.doctorId === doctorId);
    const raw: { start: Date; end: Date }[] = [];
    for (const w of windows.get(doctorId)!) {
      for (let m = w.startMinute; m + w.slotMinutes <= w.endMinute; m += w.slotMinutes) {
        const s = atLocalMinute(dateKey, m);
        const e = new Date(s.getTime() + w.slotMinutes * 60_000);
        if (myLeaves.some((l) => l.startsAt < e && l.endsAt > s)) continue;
        raw.push({ start: s, end: e });
      }
    }
    const mine = appts.filter((a) => a.doctorId === doctorId);
    const slots: Slot[] = raw.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString(), state: 'FREE', past: r.start.getTime() <= now, bookable: false }));
    // Appointments that no longer match the schedule still show on the grid.
    for (const a of mine) {
      if (a.status !== 'CANCELLED' && !slots.some((s) => s.start === a.slotStart.toISOString())) {
        slots.push({ start: a.slotStart.toISOString(), end: a.slotEnd.toISOString(), state: 'FREE', past: a.slotStart.getTime() <= now, bookable: false, offSchedule: true });
      }
    }
    slots.sort((a, b) => a.start.localeCompare(b.start));
    for (const s of slots) {
      const active = mine.find((a) => a.slotStart.toISOString() === s.start && a.status !== 'CANCELLED');
      const cancelled = [...mine].reverse().find((a) => a.slotStart.toISOString() === s.start && a.status === 'CANCELLED');
      const a = active ?? cancelled;
      if (a) {
        s.state = STATE_OF[a.status];
        s.appointment = { id: a.id, ref: a.ref, patientId: a.patientId, status: a.status, tokenNumber: a.tokenNumber, reason: a.reason, source: a.source };
      }
    }
    result.set(doctorId, { date: dateKey, windows: windows.get(doctorId)!, leaves: myLeaves.map(({ startsAt, endsAt, reason }) => ({ startsAt, endsAt, reason })), slots });
  }

  // Holds (one MGET for every candidate slot)
  const candidates: { doctorId: string; slot: Slot }[] = [];
  for (const [doctorId, d] of result) for (const s of d.slots) if (s.state === 'FREE' || s.state === 'CANCELLED') candidates.push({ doctorId, slot: s });
  if (candidates.length) {
    const values = await redis.mget(...candidates.map((c) => holdKey(c.doctorId, c.slot.start)));
    values.forEach((v, i) => {
      if (!v) return;
      const rec = JSON.parse(v) as HoldRecord;
      const s = candidates[i]!.slot;
      s.state = 'HELD';
      s.heldByMe = !!viewerUserId && rec.userId === viewerUserId;
    });
  }
  for (const d of result.values()) {
    for (const s of d.slots) s.bookable = !s.past && !s.offSchedule && (s.state === 'FREE' || s.state === 'CANCELLED' || (s.state === 'HELD' && !!s.heldByMe));
  }
  return result;
}

/** The slot starting at `slotStart`, if it exists in the doctor's schedule that day. */
async function findSlot(doctorId: string, slotStart: Date, viewerUserId?: string) {
  const day = (await daySlotsMany([doctorId], localDateKey(slotStart), viewerUserId)).get(doctorId)!;
  return day.slots.find((s) => s.start === slotStart.toISOString() && !s.offSchedule) ?? null;
}

function assertBookable(slot: Slot | null): asserts slot is Slot {
  if (!slot) throw new AppError(400, 'SLOT_INVALID', 'That time is not in the doctor’s schedule (or the doctor is on leave).');
  if (slot.past) throw new AppError(400, 'SLOT_PAST', 'That slot has already started. Pick a later time.');
  if (slot.state === 'HELD' && !slot.heldByMe) throw new AppError(409, 'SLOT_HELD', 'Someone else is booking this slot right now. Pick another time.');
  if (!slot.bookable) throw new AppError(409, 'SLOT_TAKEN', 'This slot is already booked. Pick another time.');
}

/* ---------------- Appointment views ---------------- */

const apptSelect = {
  id: true, ref: true, patientId: true, doctorId: true, departmentId: true, slotStart: true, slotEnd: true, status: true, source: true,
  reason: true, tokenNumber: true, cancelledAt: true, cancelReason: true, checkedInAt: true, rescheduledFromId: true, createdAt: true,
} satisfies Prisma.AppointmentSelect;
type ApptRow = Prisma.AppointmentGetPayload<{ select: typeof apptSelect }>;

async function present(rows: ApptRow[]) {
  const [doctors, patients] = await Promise.all([
    staffService.doctorsByIds([...new Set(rows.map((r) => r.doctorId))]),
    patientsService.summaries(rows.map((r) => r.patientId)),
  ]);
  return rows.map((r) => {
    const d = doctors.get(r.doctorId);
    const p = patients.get(r.patientId);
    return {
      ...r,
      date: localDateKey(r.slotStart),
      doctor: d ? { id: d.id, name: d.fullName, specialty: d.specialty, department: d.department, consultationFeePaise: d.consultationFeePaise } : null,
      patient: p ? { id: p.id, name: p.name, mrn: p.mrn, phone: p.phone } : null,
    };
  });
}
export type AppointmentView = Awaited<ReturnType<typeof present>>[number];

async function notifySafe(patientId: string, template: 'appointment-booked' | 'appointment-cancelled' | 'appointment-rescheduled', view: AppointmentView, extra: { previousWhen?: string } = {}) {
  try {
    const c = await patientsService.contactFor(patientId);
    if (!c.email) return;
    await notificationsService.notify({ userId: c.userId, email: c.email }, template, {
      name: c.name, mrn: c.mrn, ref: view.ref, doctor: view.doctor?.name ?? 'your doctor', department: view.doctor?.department?.name ?? '',
      when: formatLocal(view.slotStart), reason: view.cancelReason ?? undefined, previousWhen: extra.previousWhen,
    });
  } catch (err) {
    console.error(`[notify] ${template} for ${view.ref} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Patients may act only for themselves and the family members on their account; staff need appointments:book. */
async function assertCanActFor(actor: Actor, patientId: string) {
  if (actor.session.kind === 'PATIENT') {
    if (!(await patientsService.accessiblePatientIds(actor.session.userId)).includes(patientId)) throw AppError.forbidden('You can only manage appointments for yourself and your family members');
  } else if (!actor.session.permissions.includes('appointments:book')) {
    throw AppError.forbidden();
  }
}

const formatRef = (n: number) => `APT-${String(n).padStart(6, '0')}`;

/* ---------------- Schedule validation ---------------- */

function validateWindows(entries: (ScheduleWindow & { dayOfWeek: number })[]) {
  for (const e of entries) {
    if (e.endMinute <= e.startMinute) throw AppError.badRequest(`${DAY_NAMES[e.dayOfWeek]}: the end time must be after the start time`);
    if (e.endMinute - e.startMinute < e.slotMinutes) throw AppError.badRequest(`${DAY_NAMES[e.dayOfWeek]}: the session is shorter than one slot`);
  }
  for (let d = 0; d < 7; d++) {
    const day = entries.filter((e) => e.dayOfWeek === d).sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < day.length; i++) {
      if (day[i]!.startMinute < day[i - 1]!.endMinute) {
        throw AppError.badRequest(`${DAY_NAMES[d]}: sessions ${minuteLabel(day[i - 1]!.startMinute)}–${minuteLabel(day[i - 1]!.endMinute)} and ${minuteLabel(day[i]!.startMinute)}–${minuteLabel(day[i]!.endMinute)} overlap`);
      }
    }
  }
}
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* =====================================================================
   Service
   ===================================================================== */

export const schedulingService = {
  daySlotsMany,

  async daySlots(doctorId: string, dateKey: string, viewerUserId?: string) {
    return (await daySlotsMany([doctorId], dateKey, viewerUserId)).get(doctorId)!;
  },

  /** On leave / on duty right now, per doctor (for the calculated status). */
  async availabilityNow(doctorIds: string[], now = new Date()) {
    const today = localDateKey(now);
    const [windows, leaves] = await Promise.all([windowsFor(doctorIds, today), leavesBetween(doctorIds, now, new Date(now.getTime() + 1))]);
    const minute = Math.floor((now.getTime() - localMidnight(today).getTime()) / 60_000);
    return new Map(
      doctorIds.map((id) => {
        const leave = leaves.find((l) => l.doctorId === id);
        const w = windows.get(id)!;
        return [id, { onLeave: !!leave, leaveReason: leave?.reason ?? null, onDuty: w.some((x) => minute >= x.startMinute && minute < x.endMinute), worksToday: w.length > 0 }];
      }),
    );
  },

  /** First bookable slot per doctor, looking ahead up to `days` days from `fromDate`. */
  async nextFreeSlots(doctorIds: string[], fromDate = localDateKey(), days = 14) {
    const out = new Map<string, Slot | null>(doctorIds.map((id) => [id, null]));
    let pending = [...doctorIds];
    for (let i = 0; i < days && pending.length; i++) {
      const date = addDays(fromDate, i);
      const day = await daySlotsMany(pending, date);
      for (const id of pending) {
        const free = day.get(id)!.slots.find((s) => s.bookable);
        if (free) out.set(id, free);
      }
      pending = pending.filter((id) => !out.get(id));
    }
    return out;
  },

  /* ---------------- Holds ---------------- */

  async hold(actor: Actor, input: { doctorId: string; slotStart: Date }) {
    const doctor = await staffService.doctorById(input.doctorId);
    if (!doctor.isActive) throw AppError.notFound('Doctor not found');
    const slot = await findSlot(input.doctorId, input.slotStart, actor.session.userId);
    assertBookable(slot);
    const key = holdKey(input.doctorId, slot.start);

    if (slot.heldByMe) {
      const rec = JSON.parse((await redis.get(key))!) as HoldRecord;
      const ttl = await redis.ttl(key);
      return { holdId: rec.holdId, doctorId: rec.doctorId, slotStart: rec.slotStart, slotEnd: rec.slotEnd, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), holdSeconds: ttl };
    }

    const rec: HoldRecord = { holdId: randomUUID(), doctorId: input.doctorId, slotStart: slot.start, slotEnd: slot.end, userId: actor.session.userId, createdAt: new Date().toISOString() };
    const ok = await redis.set(key, JSON.stringify(rec), 'EX', env.SLOT_HOLD_SECONDS, 'NX');
    if (ok !== 'OK') throw new AppError(409, 'SLOT_HELD', 'Someone else is booking this slot right now. Pick another time.');
    await redis.set(holdIdKey(rec.holdId), key, 'EX', env.SLOT_HOLD_SECONDS);

    // A patient holds one slot at a time: picking another releases the previous one.
    if (actor.session.kind === 'PATIENT') {
      const previous = await redis.getset(userHoldKey(actor.session.userId), rec.holdId);
      await redis.expire(userHoldKey(actor.session.userId), env.SLOT_HOLD_SECONDS);
      const prev = previous ? await loadHold(previous) : null;
      if (prev && prev.holdId !== rec.holdId) {
        await dropHold(prev);
        emitScheduleChanged({ doctorId: prev.doctorId, date: localDateKey(new Date(prev.slotStart)), kind: 'hold-released' });
      }
    }

    announceExpiry(rec);
    emitScheduleChanged({ doctorId: rec.doctorId, date: localDateKey(input.slotStart), kind: 'held' });
    return { holdId: rec.holdId, doctorId: rec.doctorId, slotStart: rec.slotStart, slotEnd: rec.slotEnd, expiresAt: new Date(Date.now() + env.SLOT_HOLD_SECONDS * 1000).toISOString(), holdSeconds: env.SLOT_HOLD_SECONDS };
  },

  async releaseHold(actor: Actor, holdId: string) {
    const rec = await loadHold(holdId);
    if (!rec) return;
    if (rec.userId !== actor.session.userId) throw AppError.forbidden('This hold belongs to someone else');
    await dropHold(rec);
    clearTimeout(expiryTimers.get(holdId));
    emitScheduleChanged({ doctorId: rec.doctorId, date: localDateKey(new Date(rec.slotStart)), kind: 'hold-released' });
  },

  /* ---------------- Booking ---------------- */

  /** Confirms a hold into an appointment. The unique index decides if two bookings race for one slot. */
  async book(actor: Actor, input: { holdId: string; patientId: string; reason?: string | null }) {
    const rec = await loadHold(input.holdId);
    if (!rec || rec.userId !== actor.session.userId) throw new AppError(409, 'HOLD_EXPIRED', 'Your hold on this slot has expired. Pick the slot again.');
    await assertCanActFor(actor, input.patientId);
    await patientsService.getSummary(input.patientId);
    const doctor = await staffService.doctorById(rec.doctorId);
    if (!doctor.department) throw AppError.badRequest('This doctor has no department yet');
    assertBookable(await findSlot(rec.doctorId, new Date(rec.slotStart), actor.session.userId));

    let created: ApptRow;
    try {
      created = await prisma.$transaction(async (tx) => {
        const ref = formatRef(await nextSequence('appointment', tx));
        const a = await tx.appointment.create({
          data: {
            ref, patientId: input.patientId, doctorId: doctor.id, departmentId: doctor.department!.id,
            slotStart: new Date(rec.slotStart), slotEnd: new Date(rec.slotEnd), status: 'BOOKED',
            source: actor.session.kind === 'PATIENT' ? 'ONLINE' : 'RECEPTION', reason: input.reason?.trim() || null,
          },
          select: apptSelect,
        });
        await auditService.record(
          {
            actorId: actor.session.userId, action: AuditAction.APPOINTMENT_BOOKED, entity: 'appointments', entityId: a.id, patientId: a.patientId, ip: actor.ip,
            metadata: { ref, doctor: doctor.staffCode, slotStart: rec.slotStart, source: a.source },
          },
          tx,
        );
        return a;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        await dropHold(rec);
        emitScheduleChanged({ doctorId: rec.doctorId, date: localDateKey(new Date(rec.slotStart)), kind: 'hold-released' });
        throw new AppError(409, 'SLOT_TAKEN', 'This slot was just booked by someone else. Please pick another time.');
      }
      throw err;
    }
    await dropHold(rec);
    clearTimeout(expiryTimers.get(rec.holdId));
    emitScheduleChanged({ doctorId: created.doctorId, date: localDateKey(created.slotStart), kind: 'booked' });
    const [view] = await present([created]);
    void notifySafe(created.patientId, 'appointment-booked', view!);
    return view!;
  },

  async cancel(actor: Actor, appointmentId: string, reason: string) {
    const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: apptSelect });
    if (!appt) throw AppError.notFound('Appointment not found');
    await assertCanActFor(actor, appt.patientId);
    if (appt.status !== 'BOOKED') throw new AppError(409, 'NOT_CANCELLABLE', `This appointment is ${appt.status.toLowerCase().replace('_', ' ')} and can no longer be cancelled.`);

    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.appointment.updateMany({ where: { id: appointmentId, status: 'BOOKED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() } });
      if (!r.count) throw new AppError(409, 'NOT_CANCELLABLE', 'This appointment changed while you were cancelling it. Refresh and try again.');
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.APPOINTMENT_CANCELLED, entity: 'appointments', entityId: appt.id, patientId: appt.patientId, reason: reason.trim(), ip: actor.ip, metadata: { ref: appt.ref, slotStart: appt.slotStart.toISOString() } },
        tx,
      );
      return tx.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: apptSelect });
    });
    emitScheduleChanged({ doctorId: appt.doctorId, date: localDateKey(appt.slotStart), kind: 'cancelled' });
    const [view] = await present([updated]);
    void notifySafe(appt.patientId, 'appointment-cancelled', view!);
    return view!;
  },

  /** Moves a booked appointment to a held slot: the old row is cancelled and a new one points back to it. */
  async reschedule(actor: Actor, appointmentId: string, holdId: string) {
    const old = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: apptSelect });
    if (!old) throw AppError.notFound('Appointment not found');
    await assertCanActFor(actor, old.patientId);
    if (old.status !== 'BOOKED') throw new AppError(409, 'NOT_RESCHEDULABLE', 'Only booked appointments can be rescheduled.');
    const rec = await loadHold(holdId);
    if (!rec || rec.userId !== actor.session.userId) throw new AppError(409, 'HOLD_EXPIRED', 'Your hold on the new slot has expired. Pick the slot again.');
    const doctor = await staffService.doctorById(rec.doctorId);
    if (!doctor.department) throw AppError.badRequest('This doctor has no department yet');
    assertBookable(await findSlot(rec.doctorId, new Date(rec.slotStart), actor.session.userId));

    let created: ApptRow;
    try {
      created = await prisma.$transaction(async (tx) => {
        const ref = formatRef(await nextSequence('appointment', tx));
        const r = await tx.appointment.updateMany({ where: { id: old.id, status: 'BOOKED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: `Rescheduled to ${ref}` } });
        if (!r.count) throw new AppError(409, 'NOT_RESCHEDULABLE', 'This appointment changed meanwhile. Refresh and try again.');
        const a = await tx.appointment.create({
          data: {
            ref, patientId: old.patientId, doctorId: doctor.id, departmentId: doctor.department!.id, slotStart: new Date(rec.slotStart), slotEnd: new Date(rec.slotEnd),
            status: 'BOOKED', source: old.source, reason: old.reason, rescheduledFromId: old.id,
          },
          select: apptSelect,
        });
        await auditService.record(
          {
            actorId: actor.session.userId, action: AuditAction.APPOINTMENT_RESCHEDULED, entity: 'appointments', entityId: a.id, patientId: a.patientId, ip: actor.ip,
            metadata: { from: old.ref, to: ref, fromSlot: old.slotStart.toISOString(), toSlot: rec.slotStart, doctor: doctor.staffCode },
          },
          tx,
        );
        return a;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        await dropHold(rec);
        throw new AppError(409, 'SLOT_TAKEN', 'The new slot was just booked by someone else. Please pick another time.');
      }
      throw err;
    }
    await dropHold(rec);
    clearTimeout(expiryTimers.get(rec.holdId));
    emitScheduleChanged({ doctorId: old.doctorId, date: localDateKey(old.slotStart), kind: 'rescheduled' });
    emitScheduleChanged({ doctorId: created.doctorId, date: localDateKey(created.slotStart), kind: 'rescheduled' });
    const [view] = await present([created]);
    void notifySafe(created.patientId, 'appointment-rescheduled', view!, { previousWhen: formatLocal(old.slotStart) });
    return view!;
  },

  /* ---------------- Reads ---------------- */

  async getAppointment(id: string) {
    const a = await prisma.appointment.findUnique({ where: { id }, select: apptSelect });
    if (!a) throw AppError.notFound('Appointment not found');
    return a;
  },

  async view(id: string) {
    return (await present([await this.getAppointment(id)]))[0]!;
  },

  async findByRef(actor: Actor, ref: string) {
    const a = await prisma.appointment.findUnique({ where: { ref: ref.trim().toUpperCase() }, select: apptSelect });
    if (!a) throw AppError.notFound(`No appointment with reference ${ref.toUpperCase()}`);
    await assertCanActFor(actor, a.patientId).catch(() => {
      throw AppError.notFound(`No appointment with reference ${ref.toUpperCase()}`); // never reveal other people's bookings
    });
    return (await present([a]))[0]!;
  },

  /** Appointments for these patients (portal: self + family; reception: one patient). */
  async listForPatients(patientIds: string[], opts: { take?: number } = {}) {
    const rows = await prisma.appointment.findMany({ where: { patientId: { in: patientIds } }, orderBy: { slotStart: 'desc' }, take: opts.take ?? 100, select: apptSelect });
    return present(rows);
  },

  /** Today's (or a day's) appointments, all doctors — reception stats. */
  async countsForDay(dateKey: string) {
    const { start, end } = localDayRange(dateKey);
    const rows = await prisma.appointment.groupBy({ by: ['status'], where: { slotStart: { gte: start, lt: end } }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.status, r._count])) as Partial<Record<AppointmentStatus, number>>;
  },

  /* ---------------- Queue hooks (called by reception inside its transaction) ---------------- */

  async markCheckedIn(appointmentId: string, tokenNumber: number, tx: Prisma.TransactionClient) {
    const r = await tx.appointment.updateMany({ where: { id: appointmentId, status: 'BOOKED' }, data: { status: 'CHECKED_IN', tokenNumber, checkedInAt: new Date() } });
    if (!r.count) throw new AppError(409, 'NOT_CHECKABLE', 'This appointment is not waiting for check-in (already checked in or cancelled).');
  },

  async setQueueStatus(appointmentId: string, status: 'IN_CONSULTATION' | 'COMPLETED', tx: Prisma.TransactionClient) {
    await tx.appointment.update({ where: { id: appointmentId }, data: { status } });
  },

  /* ---------------- Weekly schedules (admin) ---------------- */

  async getSchedule(doctorId: string) {
    return prisma.doctorSchedule.findMany({
      where: { doctorId, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      select: { id: true, dayOfWeek: true, startMinute: true, endMinute: true, slotMinutes: true },
    });
  },

  /** Replaces the doctor's weekly schedule. Existing appointments are kept even if they fall outside it. */
  async replaceSchedule(actor: Actor, doctorId: string, entries: (ScheduleWindow & { dayOfWeek: number })[]) {
    const doctor = await staffService.doctorById(doctorId);
    validateWindows(entries);
    await prisma.$transaction(async (tx) => {
      await tx.doctorSchedule.deleteMany({ where: { doctorId } });
      if (entries.length) await tx.doctorSchedule.createMany({ data: entries.map((e) => ({ doctorId, ...e })) });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.SCHEDULE_UPDATED, entity: 'doctor_schedules', entityId: doctorId, ip: actor.ip, metadata: { doctor: doctor.staffCode, sessions: entries.length } },
        tx,
      );
    });
    emitScheduleChanged({ doctorId, date: localDateKey(), kind: 'schedule' });
    return this.getSchedule(doctorId);
  },

  /* ---------------- Leaves (admin) ---------------- */

  async listLeaves(doctorId: string) {
    return prisma.doctorLeave.findMany({
      where: { doctorId, endsAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, startsAt: true, endsAt: true, reason: true, createdAt: true },
    });
  },

  async addLeave(actor: Actor, doctorId: string, input: { startsAt: Date; endsAt: Date; reason?: string | null }) {
    const doctor = await staffService.doctorById(doctorId);
    if (input.endsAt <= input.startsAt) throw AppError.badRequest('The leave must end after it starts');
    const leave = await prisma.$transaction(async (tx) => {
      const l = await tx.doctorLeave.create({ data: { doctorId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason?.trim() || null }, select: { id: true, startsAt: true, endsAt: true, reason: true, createdAt: true } });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.LEAVE_ADDED, entity: 'doctor_leaves', entityId: l.id, ip: actor.ip, metadata: { doctor: doctor.staffCode, startsAt: l.startsAt.toISOString(), endsAt: l.endsAt.toISOString() } },
        tx,
      );
      return l;
    });
    // Bookings already inside the leave are not cancelled automatically; reception sees them and calls the patients.
    const affected = await prisma.appointment.count({ where: { doctorId, status: 'BOOKED', slotStart: { gte: input.startsAt, lt: input.endsAt } } });
    for (let d = localDateKey(input.startsAt); d <= localDateKey(new Date(input.endsAt.getTime() - 1)) && d <= addDays(localDateKey(), 30); d = addDays(d, 1)) {
      emitScheduleChanged({ doctorId, date: d, kind: 'leave' });
    }
    return { leave, affectedAppointments: affected };
  },

  async removeLeave(actor: Actor, leaveId: string) {
    const l = await prisma.doctorLeave.findUnique({ where: { id: leaveId } });
    if (!l) throw AppError.notFound('Leave not found');
    await prisma.$transaction(async (tx) => {
      await tx.doctorLeave.delete({ where: { id: leaveId } });
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.LEAVE_REMOVED, entity: 'doctor_leaves', entityId: leaveId, ip: actor.ip, metadata: { doctorId: l.doctorId } }, tx);
    });
    emitScheduleChanged({ doctorId: l.doctorId, date: localDateKey(l.startsAt), kind: 'leave' });
  },

  /* ---------------- Directory for booking screens ---------------- */

  /** Doctors with fee and next free slot (patient portal, chatbot, reception booking). */
  async directory(opts: { departmentId?: string; fromDate?: string } = {}) {
    const doctors = (await staffService.listDoctors({ departmentId: opts.departmentId })).filter((d) => d.department);
    const next = await this.nextFreeSlots(doctors.map((d) => d.id), opts.fromDate ?? localDateKey());
    return doctors.map((d: Doctor) => ({
      id: d.id, name: d.fullName, specialty: d.specialty, department: d.department, consultationFeePaise: d.consultationFeePaise,
      nextFreeSlot: next.get(d.id) ? { start: next.get(d.id)!.start, end: next.get(d.id)!.end } : null,
    }));
  },
};
