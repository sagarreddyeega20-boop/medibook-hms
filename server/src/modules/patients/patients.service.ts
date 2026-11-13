import type { Gender, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';

/**
 * Patients service — Patient registry (MRN), duplicate detection, family members, DPDP consents.
 * Owns: patients, family_members, consents
 * Other modules must call this service, never these tables directly.
 */

/** Hospital patient ID: MB-YYYY-NNNNNN (counter per registration year). */
export const formatMrn = (year: number, n: number) => `MB-${year}-${String(n).padStart(6, '0')}`;

export interface NewPatient {
  userId?: string;
  fullName: string;
  gender: Gender;
  dateOfBirth: Date;
  email: string;
  phone: string;
  source: 'ONLINE' | 'RECEPTION';
}

export const splitName = (fullName: string) => {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0]!, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
};

export const patientsService = {
  async register(input: NewPatient, tx: Prisma.TransactionClient = prisma) {
    const year = new Date().getUTCFullYear();
    const mrn = formatMrn(year, await nextSequence(`mrn:${year}`, tx));
    return tx.patient.create({
      data: {
        mrn,
        userId: input.userId,
        ...splitName(input.fullName),
        gender: input.gender,
        dateOfBirth: input.dateOfBirth,
        email: input.email,
        phone: input.phone,
        registrationSource: input.source,
      },
      select: { id: true, mrn: true, firstName: true, lastName: true },
    });
  },

  findByUserId(userId: string) {
    return prisma.patient.findUnique({
      where: { userId },
      select: { id: true, mrn: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, email: true, phone: true, createdAt: true },
    });
  },

  async namesByUserIds(userIds: string[]) {
    const rows = await prisma.patient.findMany({ where: { userId: { in: userIds } }, select: { userId: true, mrn: true, firstName: true, lastName: true } });
    return new Map(rows.map((r) => [r.userId!, { name: [r.firstName, r.lastName].filter(Boolean).join(' '), code: r.mrn }]));
  },
};

export const displayName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(' ');
