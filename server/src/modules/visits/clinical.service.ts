import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { localDateKey } from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { careAccess, type Actor } from '../auth/care-access.service.js';
import { billingService } from '../billing/billing.service.js';
import { ordersService, type OrderView } from '../orders/orders.service.js';
import { patientsService } from '../patients/patients.service.js';
import { schedulingService } from '../scheduling/scheduling.service.js';
import { staffService } from '../staff/staff.service.js';
import { EDITABLE_VISIT, presentNote, visitsService, type VisitRow } from './visits.service.js';

/**
 * Doctor workspace: today's queue, the consultation bundle, the patient timeline and notes.
 * Every read of clinical data goes through careAccess.assertCanView (care relationship or break-glass) and is audited.
 */

export type TimelineType = 'VISIT' | 'NOTE' | 'LAB' | 'RADIOLOGY' | 'RESULT' | 'REFERRAL' | 'PRESCRIPTION';
export const TIMELINE_TYPES: TimelineType[] = ['VISIT', 'NOTE', 'LAB', 'RADIOLOGY', 'RESULT', 'REFERRAL', 'PRESCRIPTION'];

export interface TimelineEvent {
  id: string;
  type: TimelineType;
  at: string;
  title: string;
  status?: string;
  priority?: string;
  department: string | null;
  doctor: string | null;
  visitId: string;
  /** Labelled facts, e.g. ["Diagnosis", "Stable angina"]. */
  lines: [string, string][];
}

async function me(actor: Actor) {
  const s = await staffService.profileByUserId(actor.session.userId);
  if (!s || !s.isActive) throw AppError.forbidden('Only active doctors have a clinical workspace');
  return s;
}

/** The doctor's own visit, for writing to it. */
async function ownVisit(actor: Actor, visitId: string) {
  const doctor = await me(actor);
  const visit = await visitsService.get(visitId);
  if (visit.doctorId !== doctor.id) throw AppError.forbidden('This is another doctor’s consultation');
  return { doctor, visit };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Builds the cross-department timeline (newest first). */
function buildTimeline(visits: VisitRow[], notes: ReturnType<typeof presentNote>[], orders: OrderView[], doctors: Map<string, { fullName: string; department: { name: string } | null }>): TimelineEvent[] {
  const doc = (id: string | null | undefined) => (id ? doctors.get(id) : undefined);
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const out: TimelineEvent[] = [];

  for (const v of visits) {
    const d = doc(v.doctorId);
    out.push({
      id: `visit:${v.id}`, type: 'VISIT', at: v.startedAt.toISOString(), title: `${v.type === 'WALK_IN' ? 'Walk-in' : 'OPD'} visit · ${v.visitNumber}`, status: v.status,
      department: d?.department?.name ?? null, doctor: d?.fullName ?? null, visitId: v.id,
      lines: [['Complaint', v.chiefComplaint ?? '—'], ...(v.endedAt ? ([['Completed', v.endedAt.toISOString()]] as [string, string][]) : [])],
    });
  }
  for (const n of notes) {
    const d = doc(n.authorId);
    const lines: [string, string][] = [];
    if (n.complaint) lines.push(['Complaint', n.complaint]);
    if (n.findings) lines.push(['Findings', n.findings]);
    if (n.diagnosis) lines.push(['Diagnosis', n.diagnosis]);
    if (n.advice) lines.push(['Advice', n.advice]);
    out.push({
      id: `note:${n.id}`, type: 'NOTE', at: n.updatedAt.toISOString(), title: `Clinical note${n.diagnosis ? ` · ${n.diagnosis}` : ''}`,
      department: d?.department?.name ?? null, doctor: d?.fullName ?? null, visitId: n.visitId, lines,
    });
  }
  for (const o of orders) {
    const by = o.orderingDoctor;
    const dept = o.orderingDoctor.department?.name ?? doc(visitById.get(o.visitId)?.doctorId)?.department?.name ?? null;
    if (o.type === 'LAB' || o.type === 'RADIOLOGY') {
      out.push({
        id: `order:${o.id}`, type: o.type, at: o.createdAt.toISOString(), title: o.title, status: o.status, priority: o.priority,
        department: o.targetDepartment.name, doctor: by.name, visitId: o.visitId,
        lines: [['Order', o.orderNumber], ...(o.clinicalNotes ? ([['Indication', o.clinicalNotes]] as [string, string][]) : [])],
      });
      for (const r of o.results) {
        out.push({
          id: `result:${r.id}`, type: 'RESULT', at: r.reportedAt.toISOString(), title: `Result · ${o.title}`, status: r.isAbnormal ? 'ABNORMAL' : 'RESULT_READY',
          department: o.targetDepartment.name, doctor: r.reportedBy, visitId: o.visitId,
          lines: [['Summary', r.summary ?? '—'], ...(r.fileUrl ? ([['Report', r.fileUrl]] as [string, string][]) : [])],
        });
      }
    } else if (o.type === 'REFERRAL') {
      out.push({
        id: `referral:${o.id}`, type: 'REFERRAL', at: o.createdAt.toISOString(), title: `${by.name} → ${o.targetDoctor?.name ?? o.targetDepartment.name}`, status: o.status, priority: o.priority,
        department: dept, doctor: by.name, visitId: o.visitId,
        lines: [
          ['To', `${o.targetDepartment.name}${o.targetDoctor ? ` · ${o.targetDoctor.name}` : ''}`],
          ['Reason', o.referral?.reason ?? o.clinicalNotes ?? '—'],
          ...(o.scheduledFor ? ([['Booked for', o.scheduledFor.toISOString()]] as [string, string][]) : []),
        ],
      });
    } else if (o.type === 'MEDICATION' && o.prescription) {
      out.push({
        id: `rx:${o.id}`, type: 'PRESCRIPTION', at: o.createdAt.toISOString(), title: `Prescription · ${o.prescription.items.length} item${o.prescription.items.length === 1 ? '' : 's'}`,
        status: o.status === 'CANCELLED' ? 'CANCELLED' : o.prescription.status, department: dept, doctor: by.name, visitId: o.visitId,
        lines: [
          ...o.prescription.items.map((i) => [i.medicineName, [i.dose, i.frequency, i.durationDays ? `${i.durationDays} days` : null, i.instructions].filter(Boolean).join(' · ') || '—'] as [string, string]),
          ...(o.prescription.notes ? ([['Notes', o.prescription.notes]] as [string, string][]) : []),
        ],
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export const clinicalService = {
  /* ---------------- Doctor home: today's queue ---------------- */

  async today(actor: Actor, dateKey = localDateKey()) {
    const doctor = await me(actor);
    const [appts, visits, referralPatients, incoming] = await Promise.all([
      schedulingService.listForDoctorDay(doctor.id, dateKey),
      visitsService.queueForDoctors([doctor.id], dateKey),
      ordersService.openReferralPatientIds(doctor.id),
      ordersService.incomingReferrals(doctor.id),
    ]);
    const visitByAppt = new Map(visits.filter((v) => v.appointmentId).map((v) => [v.appointmentId!, v]));
    const patients = await patientsService.headers([...appts.map((a) => a.patientId), ...visits.map((v) => v.patientId), ...incoming.map((r) => r.patientId)]);
    const who = (id: string) => {
      const p = patients.get(id);
      return p ? { id: p.id, name: p.name, mrn: p.mrn, gender: p.gender, age: p.age } : null;
    };
    const visitStatus = (v: VisitRow) => (v.status === 'OPEN' ? 'CHECKED_IN' : v.status);

    const rows = [
      ...appts.map((a) => {
        const v = visitByAppt.get(a.id);
        return {
          key: a.id, time: a.slotStart.toISOString(), kind: 'APPOINTMENT' as const, ref: a.ref, reason: a.reason, token: v?.tokenNumber ?? a.tokenNumber,
          status: v ? visitStatus(v) : a.status, visitId: v?.id ?? null, patient: who(a.patientId), referral: referralPatients.has(a.patientId),
        };
      }),
      ...visits
        .filter((v) => !v.appointmentId || !appts.some((a) => a.id === v.appointmentId))
        .map((v) => ({
          key: v.id, time: v.startedAt.toISOString(), kind: 'WALK_IN' as const, ref: v.visitNumber, reason: v.chiefComplaint, token: v.tokenNumber,
          status: visitStatus(v), visitId: v.id, patient: who(v.patientId), referral: referralPatients.has(v.patientId),
        })),
    ].sort((a, b) => a.time.localeCompare(b.time));

    const current = visits.find((v) => v.status === 'IN_CONSULTATION') ?? null;
    const done = ['COMPLETED', 'NO_SHOW', 'CANCELLED'];
    return {
      date: dateKey,
      doctor: { id: doctor.id, name: doctor.fullName, staffCode: doctor.staffCode },
      stats: {
        today: rows.filter((r) => r.status !== 'CANCELLED').length,
        completed: rows.filter((r) => r.status === 'COMPLETED').length,
        waiting: rows.filter((r) => !done.includes(r.status)).length,
        cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
      },
      rows,
      current: current ? { visitId: current.id, token: current.tokenNumber, since: iso(current.consultStartedAt), complaint: current.chiefComplaint, patient: who(current.patientId) } : null,
      referrals: incoming.map((r) => ({ ...r, patient: who(r.patientId) })),
    };
  },

  /** Find a patient by MRN / name / phone (demographics only; opening the record is access-checked). */
  search(q: string) {
    return patientsService.search(q, 10);
  },

  /* ---------------- Consultation bundle ---------------- */

  async consultation(actor: Actor, visitId: string) {
    const visit = await visitsService.get(visitId);
    const basis = await careAccess.assertCanView(actor, visit.patientId, { entity: 'visits', entityId: visit.id, metadata: { visitNumber: visit.visitNumber } });
    const doctor = await me(actor);
    const [patient, notes, orders, referral, charges, doctors] = await Promise.all([
      patientsService.clinicalHeader(visit.patientId),
      visitsService.notesForVisits([visit.id]),
      ordersService.forVisit(visit.id),
      ordersService.referralForVisit(visit.id, visit.patientId, visit.doctorId),
      billingService.chargesForVisit(visit.id),
      staffService.doctorsByIds([visit.doctorId]),
    ]);
    const owner = doctors.get(visit.doctorId);
    const pastVisits = await prisma.visit.count({ where: { patientId: visit.patientId, id: { not: visit.id }, status: 'COMPLETED' } });
    return {
      access: basis,
      visit: { ...visit, doctor: owner ? { id: owner.id, name: owner.fullName, department: owner.department } : null },
      patient,
      pastVisits,
      canEdit: visit.doctorId === doctor.id && EDITABLE_VISIT.includes(visit.status),
      isMine: visit.doctorId === doctor.id,
      note: notes.map(presentNote).find((n) => n.authorId === visit.doctorId) ?? null,
      orders,
      referral,
      charges,
    };
  },

  /* ---------------- Timeline ---------------- */

  async timeline(actor: Actor, patientId: string, types?: TimelineType[]) {
    const basis = await careAccess.assertCanView(actor, patientId, { entity: 'timeline', entityId: patientId, metadata: types?.length ? { types } : {} });
    const [patient, visits, orders, override] = await Promise.all([
      patientsService.clinicalHeader(patientId),
      visitsService.listForPatient(patientId),
      ordersService.forPatient(patientId),
      careAccess.activeOverride(actor.session.userId, patientId),
    ]);
    const notes = (await visitsService.notesForVisits(visits.map((v) => v.id))).map(presentNote);
    const staffIds = new Set<string>([...visits.map((v) => v.doctorId), ...notes.map((n) => n.authorId), ...orders.map((o) => o.orderingDoctorId)]);
    const doctors = await staffService.doctorsByIds([...staffIds]);
    let events = buildTimeline(visits, notes, orders, doctors);
    const counts = Object.fromEntries(TIMELINE_TYPES.map((t) => [t, events.filter((e) => e.type === t).length])) as Record<TimelineType, number>;
    if (types?.length) events = events.filter((e) => types.includes(e.type));
    return { access: basis, override: basis === 'BREAK_GLASS' ? override : null, patient, counts, events };
  },

  /** All clinical notes of a patient (any department). */
  async notes(actor: Actor, patientId: string) {
    await careAccess.assertCanView(actor, patientId, { entity: 'clinical_notes', entityId: patientId });
    const visits = await visitsService.listForPatient(patientId);
    const notes = (await visitsService.notesForVisits(visits.map((v) => v.id))).map(presentNote);
    const doctors = await staffService.doctorsByIds([...new Set(notes.map((n) => n.authorId))]);
    return notes.map((n) => ({ ...n, author: doctors.get(n.authorId)?.fullName ?? 'Doctor', department: doctors.get(n.authorId)?.department?.name ?? null }));
  },

  async visitNotes(actor: Actor, visitId: string) {
    const visit = await visitsService.get(visitId);
    await careAccess.assertCanView(actor, visit.patientId, { entity: 'clinical_notes', entityId: visit.id });
    return (await visitsService.notesForVisits([visit.id])).map(presentNote);
  },

  /* ---------------- Writes (own, open visits only) ---------------- */

  async saveNote(actor: Actor, visitId: string, input: { complaint?: string | null; findings?: string | null; diagnosis?: string | null; advice?: string | null }) {
    const { doctor, visit } = await ownVisit(actor, visitId);
    if (!EDITABLE_VISIT.includes(visit.status)) throw new AppError(409, 'VISIT_CLOSED', 'This visit is closed. Notes can no longer be changed.');
    const note = await prisma.$transaction(async (tx) => {
      const { note: n, created } = await visitsService.saveNote({ visitId, authorId: doctor.id, ...input }, tx);
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.NOTE_SAVED, entity: 'clinical_notes', entityId: n.id, patientId: visit.patientId, ip: actor.ip ?? null, metadata: { visitNumber: visit.visitNumber, created } }, tx);
      return n;
    });
    return presentNote(note);
  },

  async updateAllergies(actor: Actor, patientId: string, allergies: string | null) {
    await careAccess.assertCanView(actor, patientId, { entity: 'patients', entityId: patientId, metadata: { field: 'allergies' } });
    await prisma.$transaction(async (tx) => {
      await patientsService.updateAllergies(patientId, allergies, tx);
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.ALLERGIES_UPDATED, entity: 'patients', entityId: patientId, patientId, ip: actor.ip ?? null }, tx);
    });
    return patientsService.clinicalHeader(patientId);
  },

  /** Ownership check before the shared queue moves (start / complete). */
  ownVisit,
};
