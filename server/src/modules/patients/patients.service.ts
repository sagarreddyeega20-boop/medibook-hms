import { Prisma, type Gender } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';

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
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  source: 'ONLINE' | 'RECEPTION';
  registeredById?: string | null;
}

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

export const splitName = (fullName: string) => {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0]!, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
};

export const displayName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(' ');

/** Phone numbers are compared on their last 10 digits ("+91 98450 14410" = "9845014410"). */
export const phoneKey = (phone: string | null | undefined) => (phone ?? '').replace(/\D/g, '').slice(-10);

const summarySelect = {
  id: true, mrn: true, userId: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, phone: true, email: true, createdAt: true,
} satisfies Prisma.PatientSelect;

type SummaryRow = Prisma.PatientGetPayload<{ select: typeof summarySelect }>;
const toSummary = (p: SummaryRow) => ({
  id: p.id, mrn: p.mrn, name: displayName(p), gender: p.gender,
  dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
  phone: p.phone, email: p.email, hasPortalAccount: !!p.userId, createdAt: p.createdAt,
});
export type PatientSummary = ReturnType<typeof toSummary>;

export const patientsService = {
  /** Low-level create (MRN + row). Callers handle duplicate checks and auditing. */
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
        email: input.email || null,
        phone: input.phone || null,
        address: input.address || null,
        registrationSource: input.source,
        registeredById: input.registeredById ?? null,
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

  /** id → summary, for other modules (board, appointment lists). */
  async summaries(ids: string[]) {
    if (!ids.length) return new Map<string, PatientSummary>();
    const rows = await prisma.patient.findMany({ where: { id: { in: [...new Set(ids)] } }, select: summarySelect });
    return new Map(rows.map((r) => [r.id, toSummary(r)]));
  },

  async getSummary(id: string) {
    const p = await prisma.patient.findUnique({ where: { id }, select: summarySelect });
    if (!p) throw AppError.notFound('Patient not found');
    return toSummary(p);
  },

  /** Where to email a patient: their own address, else the family account holder's. */
  async contactFor(patientId: string): Promise<{ name: string; mrn: string; email: string | null; userId: string | null }> {
    const p = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { ...summarySelect, familyOf: { select: { accountPatient: { select: { email: true, userId: true } } }, take: 1 } },
    });
    if (!p) throw AppError.notFound('Patient not found');
    const holder = p.familyOf[0]?.accountPatient;
    return { name: displayName(p), mrn: p.mrn, email: p.email ?? holder?.email ?? null, userId: p.userId ?? holder?.userId ?? null };
  },

  /** Reception search: MRN, name or phone (any part). */
  async search(q: string, limit = 20) {
    const term = q.trim();
    if (term.length < 2) return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = term.replace(/\D/g, '');
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM patients
      WHERE mrn ILIKE ${like}
         OR (first_name || ' ' || coalesce(last_name, '')) ILIKE ${like}
         OR (${phoneLike}::text IS NOT NULL AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${phoneLike})
      ORDER BY (upper(mrn) = upper(${term})) DESC, created_at DESC
      LIMIT ${limit}`;
    const byId = await this.summaries(rows.map((r) => r.id));
    return rows.map((r) => byId.get(r.id)!).filter(Boolean);
  },

  /** Patients with the same name, date of birth and phone (spec: duplicate-patient detection). */
  async findDuplicates(input: { fullName: string; dateOfBirth: Date; phone?: string | null }) {
    const { firstName, lastName } = splitName(input.fullName);
    const phone = phoneKey(input.phone);
    if (!phone) return [];
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM patients
      WHERE lower(first_name) = lower(${firstName})
        AND lower(coalesce(last_name, '')) = lower(${lastName ?? ''})
        AND date_of_birth = ${input.dateOfBirth.toISOString().slice(0, 10)}::date
        AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phone}
      LIMIT 5`;
    return [...(await this.summaries(rows.map((r) => r.id))).values()];
  },

  /**
   * Registration at reception. If name + date of birth + phone match an existing patient, refuses with
   * 409 DUPLICATE_PATIENT listing the matches, unless `confirmNotDuplicate` is set.
   */
  async registerAtReception(
    actor: Actor & { staffId: string | null },
    input: { fullName: string; gender: Gender; dateOfBirth: string; phone: string; email?: string | null; address?: string | null; confirmNotDuplicate?: boolean },
  ) {
    const dob = new Date(`${input.dateOfBirth}T00:00:00Z`);
    if (!input.confirmNotDuplicate) {
      const matches = await this.findDuplicates({ fullName: input.fullName, dateOfBirth: dob, phone: input.phone });
      if (matches.length) {
        throw new AppError(409, 'DUPLICATE_PATIENT', `${matches.length === 1 ? 'A patient' : `${matches.length} patients`} with the same name, date of birth and phone already exist${matches.length === 1 ? 's' : ''}.`, { matches });
      }
    }
    const created = await prisma.$transaction(async (tx) => {
      const p = await this.register(
        { fullName: input.fullName, gender: input.gender, dateOfBirth: dob, phone: input.phone, email: input.email, address: input.address, source: 'RECEPTION', registeredById: actor.staffId },
        tx,
      );
      await auditService.record(
        {
          actorId: actor.session.userId, action: AuditAction.PATIENT_REGISTERED, entity: 'patients', entityId: p.id, patientId: p.id, ip: actor.ip,
          metadata: { mrn: p.mrn, source: 'RECEPTION', duplicateOverride: !!input.confirmNotDuplicate },
        },
        tx,
      );
      return p;
    });
    return this.getSummary(created.id);
  },

  /** Patient record for reception: contact details + family links (no clinical data). */
  async detail(id: string) {
    const p = await prisma.patient.findUnique({
      where: { id },
      select: {
        ...summarySelect, address: true, emergencyContactName: true, emergencyContactPhone: true,
        familyMembers: { select: { id: true, relationship: true, memberPatient: { select: summarySelect } }, orderBy: { createdAt: 'asc' } },
        familyOf: { select: { id: true, relationship: true, accountPatient: { select: summarySelect } } },
      },
    });
    if (!p) throw AppError.notFound('Patient not found');
    return {
      ...toSummary(p),
      address: p.address,
      emergencyContact: p.emergencyContactName ? { name: p.emergencyContactName, phone: p.emergencyContactPhone } : null,
      familyMembers: p.familyMembers.map((f) => ({ linkId: f.id, relationship: f.relationship, patient: toSummary(f.memberPatient) })),
      accountHolders: p.familyOf.map((f) => ({ linkId: f.id, relationship: f.relationship, patient: toSummary(f.accountPatient) })),
    };
  },

  /* ---------------- Family members (one account, several patients) ---------------- */

  async linkFamily(actor: Actor, input: { accountPatientId: string; memberPatientId: string; relationship: string }) {
    if (input.accountPatientId === input.memberPatientId) throw AppError.badRequest('A patient cannot be their own family member');
    const [holder, member] = await Promise.all([this.getSummary(input.accountPatientId), this.getSummary(input.memberPatientId)]);
    if (member.hasPortalAccount) throw AppError.badRequest(`${member.name} has their own portal account, so they manage their own bookings`);
    try {
      const link = await prisma.$transaction(async (tx) => {
        const row = await tx.familyMember.create({ data: { ...input, relationship: input.relationship.trim() }, select: { id: true } });
        await auditService.record(
          {
            actorId: actor.session.userId, action: AuditAction.FAMILY_LINKED, entity: 'family_members', entityId: row.id, patientId: member.id, ip: actor.ip,
            metadata: { holder: holder.mrn, member: member.mrn, relationship: input.relationship },
          },
          tx,
        );
        return row;
      });
      return { linkId: link.id, relationship: input.relationship, patient: member };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw AppError.conflict(`${member.name} is already linked to ${holder.name}`);
      throw err;
    }
  },

  async unlinkFamily(accountPatientId: string, linkId: string) {
    const r = await prisma.familyMember.deleteMany({ where: { id: linkId, accountPatientId } });
    if (!r.count) throw AppError.notFound('Family link not found');
  },

  /** A portal user adds a family member: creates their patient record (MRN) and links it to the account. */
  async addFamilyMemberByPatient(actor: Actor, input: { fullName: string; gender: Gender; dateOfBirth: string; phone?: string | null; relationship: string }) {
    const holder = await this.findByUserId(actor.session.userId);
    if (!holder) throw AppError.notFound('Patient record not found');
    const created = await prisma.$transaction(async (tx) => {
      const p = await this.register(
        { fullName: input.fullName, gender: input.gender, dateOfBirth: new Date(`${input.dateOfBirth}T00:00:00Z`), phone: input.phone || holder.phone, source: 'ONLINE' },
        tx,
      );
      const link = await tx.familyMember.create({ data: { accountPatientId: holder.id, memberPatientId: p.id, relationship: input.relationship.trim() }, select: { id: true } });
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.PATIENT_REGISTERED, entity: 'patients', entityId: p.id, patientId: p.id, ip: actor.ip, metadata: { mrn: p.mrn, source: 'FAMILY' } }, tx);
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.FAMILY_LINKED, entity: 'family_members', entityId: link.id, patientId: p.id, ip: actor.ip, metadata: { holder: holder.mrn, member: p.mrn, relationship: input.relationship } }, tx);
      return { p, link };
    });
    return { linkId: created.link.id, relationship: input.relationship, patient: await this.getSummary(created.p.id) };
  },

  /** The signed-in patient and the family members on their account: [{ patient, relationship }]. Self first. */
  async household(userId: string) {
    const self = await prisma.patient.findUnique({
      where: { userId },
      select: { ...summarySelect, familyMembers: { select: { id: true, relationship: true, memberPatient: { select: summarySelect } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!self) throw AppError.notFound('Patient record not found');
    return [
      { linkId: null as string | null, relationship: 'Self', patient: toSummary(self) },
      ...self.familyMembers.map((f) => ({ linkId: f.id as string | null, relationship: f.relationship, patient: toSummary(f.memberPatient) })),
    ];
  },

  /** Patient IDs a portal user may book for and see: themself + their family members. */
  async accessiblePatientIds(userId: string) {
    return (await this.household(userId)).map((h) => h.patient.id);
  },
};
