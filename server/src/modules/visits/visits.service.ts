import type { Prisma, VisitType } from '@prisma/client';
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
};
