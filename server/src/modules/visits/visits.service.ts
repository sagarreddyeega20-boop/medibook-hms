import type { Prisma, VisitStatus, VisitType } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { localDateKey, localDayRange } from '../../lib/time.js';

/**
 * Visits service — Visits (the centre of the data model), clinical notes, vitals, patient timeline.
 * Owns: visits, clinical_notes, vitals
 * Other modules must call this service, never these tables directly.
 */

const visitSelect = {
  id: true, visitNumber: true, patientId: true, appointmentId: true, departmentId: true, doctorId: true, type: true, status: true,
  chiefComplaint: true, tokenNumber: true, startedAt: true, consultStartedAt: true, endedAt: true,
} satisfies Prisma.VisitSelect;
export type VisitRow = Prisma.VisitGetPayload<{ select: typeof visitSelect }>;

export const visitsService = {
  /** Opens a visit (status OPEN = waiting in the queue). Walk-ins have no appointment. */
  async create(
    input: { patientId: string; doctorId: string; departmentId: string; type: VisitType; appointmentId?: string | null; tokenNumber: number; chiefComplaint?: string | null },
    tx: Prisma.TransactionClient,
  ) {
    const day = localDateKey().replace(/-/g, '');
    const visitNumber = `V-${day}-${String(await nextSequence(`visit:${day}`, tx)).padStart(4, '0')}`;
    return tx.visit.create({
      data: {
        visitNumber, patientId: input.patientId, doctorId: input.doctorId, departmentId: input.departmentId, type: input.type,
        appointmentId: input.appointmentId ?? null, tokenNumber: input.tokenNumber, chiefComplaint: input.chiefComplaint?.trim() || null, status: 'OPEN',
      },
      select: visitSelect,
    });
  },

  async get(id: string) {
    const v = await prisma.visit.findUnique({ where: { id }, select: visitSelect });
    if (!v) throw AppError.notFound('Visit not found');
    return v;
  },

  /** Today's visits for these doctors, plus any still open from earlier (the live queue). */
  async queueForDoctors(doctorIds: string[], dateKey = localDateKey()) {
    const { start, end } = localDayRange(dateKey);
    return prisma.visit.findMany({
      where: {
        doctorId: { in: doctorIds },
        type: { in: ['OPD', 'WALK_IN'] },
        OR: [{ startedAt: { gte: start, lt: end } }, { status: { in: ['OPEN', 'IN_CONSULTATION'] } }],
      },
      orderBy: [{ tokenNumber: 'asc' }, { startedAt: 'asc' }],
      select: visitSelect,
    });
  },

  /** OPEN → IN_CONSULTATION. A doctor sees one patient at a time. */
  async startConsult(id: string, tx: Prisma.TransactionClient) {
    const v = await tx.visit.findUnique({ where: { id }, select: visitSelect });
    if (!v) throw AppError.notFound('Visit not found');
    const busy = await tx.visit.findFirst({ where: { doctorId: v.doctorId, status: 'IN_CONSULTATION', id: { not: id } }, select: { tokenNumber: true } });
    if (busy) throw new AppError(409, 'DOCTOR_BUSY', `The doctor is still with token ${busy.tokenNumber}. Finish that consultation first.`);
    const r = await tx.visit.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'IN_CONSULTATION', consultStartedAt: new Date() } });
    if (!r.count) throw new AppError(409, 'NOT_WAITING', 'This patient is not waiting in the queue.');
    return tx.visit.findUniqueOrThrow({ where: { id }, select: visitSelect });
  },

  /** IN_CONSULTATION → COMPLETED. */
  async complete(id: string, tx: Prisma.TransactionClient) {
    const r = await tx.visit.updateMany({ where: { id, status: 'IN_CONSULTATION' }, data: { status: 'COMPLETED', endedAt: new Date() } });
    if (!r.count) throw new AppError(409, 'NOT_IN_CONSULTATION', 'This patient is not in consultation.');
    return tx.visit.findUniqueOrThrow({ where: { id }, select: visitSelect });
  },

  async countsForDay(dateKey: string) {
    const { start, end } = localDayRange(dateKey);
    const rows = await prisma.visit.groupBy({ by: ['type'], where: { startedAt: { gte: start, lt: end }, status: { not: 'CANCELLED' } }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.type, r._count])) as Partial<Record<VisitType, number>>;
  },

  /* ---------------- Care relationship (used by the access layer) ---------------- */

  /** True if this doctor has (or had) a visit with this patient. */
  async doctorHasVisit(doctorId: string, patientId: string) {
    return (await prisma.visit.count({ where: { doctorId, patientId, status: { not: 'CANCELLED' } } })) > 0;
  },

  /** Every visit of a patient, newest first (timeline). */
  listForPatient(patientId: string) {
    return prisma.visit.findMany({ where: { patientId }, orderBy: { startedAt: 'desc' }, select: visitSelect });
  },

  /* ---------------- Clinical notes ---------------- */

  notesForVisits(visitIds: string[]) {
    if (!visitIds.length) return Promise.resolve([] as NoteRow[]);
    return prisma.clinicalNote.findMany({ where: { visitId: { in: visitIds } }, orderBy: { createdAt: 'desc' }, select: noteSelect });
  },

  /**
   * Creates or updates the author's consultation note on a visit.
   * complaint → subjective, findings → objective, diagnosis, advice → plan.
   */
  async saveNote(
    input: { visitId: string; authorId: string; complaint?: string | null; findings?: string | null; diagnosis?: string | null; advice?: string | null },
    tx: Prisma.TransactionClient,
  ) {
    const clean = (v?: string | null) => (v === undefined ? undefined : v?.trim() || null);
    const data = { subjective: clean(input.complaint), objective: clean(input.findings), diagnosis: clean(input.diagnosis), plan: clean(input.advice) };
    const existing = await tx.clinicalNote.findFirst({ where: { visitId: input.visitId, authorId: input.authorId, type: 'CONSULTATION' }, select: { id: true } });
    const note = existing
      ? await tx.clinicalNote.update({ where: { id: existing.id }, data, select: noteSelect })
      : await tx.clinicalNote.create({ data: { visitId: input.visitId, authorId: input.authorId, type: 'CONSULTATION', ...data }, select: noteSelect });
    return { note, created: !existing };
  },
};

/** Visits a doctor may still write to. */
export const EDITABLE_VISIT: VisitStatus[] = ['OPEN', 'IN_CONSULTATION'];

const noteSelect = {
  id: true, visitId: true, authorId: true, type: true, subjective: true, objective: true, diagnosis: true, plan: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ClinicalNoteSelect;
export type NoteRow = Prisma.ClinicalNoteGetPayload<{ select: typeof noteSelect }>;

/** API shape of a note: complaint, findings, diagnosis, advice. */
export const presentNote = (n: NoteRow) => ({
  id: n.id, visitId: n.visitId, authorId: n.authorId, type: n.type,
  complaint: n.subjective, findings: n.objective, diagnosis: n.diagnosis, advice: n.plan, createdAt: n.createdAt, updatedAt: n.updatedAt,
});
