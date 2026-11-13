import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { formatLocal } from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { ordersService } from '../orders/orders.service.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';
import { visitsService } from '../visits/visits.service.js';
import { authService } from './auth.service.js';
import type { SessionData } from './session.service.js';

/**
 * Second access layer: which PATIENTS a clinician may open (the role decides the screens; this decides the records).
 * Enforced on the server for every clinical read. A doctor may read a patient's clinical data only if they
 *   - have a visit with the patient (VISIT), or
 *   - have an order / referral for the patient addressed to them (ORDER), or
 *   - hold an active break-glass override (BREAK_GLASS: typed reason, 60 minutes, admins alerted, audited).
 * Every successful read writes a VIEW row to audit_logs with the patient_id; every refusal writes ACCESS_DENIED.
 * Owns: access_overrides (auth module).
 */

export const BREAK_GLASS_MINUTES = 60;
export type AccessBasis = 'VISIT' | 'ORDER' | 'BREAK_GLASS';

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

/** What was looked at, for the VIEW audit row. */
export interface ViewTarget {
  entity: string; // e.g. "clinical_notes", "timeline", "visits"
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

async function staffIdOf(userId: string) {
  const me = await staffService.profileByUserId(userId);
  return me?.isActive ? me : null;
}

export const careAccess = {
  async activeOverride(userId: string, patientId: string) {
    return prisma.accessOverride.findFirst({
      where: { userId, patientId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
      select: { id: true, reason: true, expiresAt: true, createdAt: true },
    });
  },

  /** The basis on which this user may read this patient's clinical data, or null. Writes nothing. */
  async basis(session: SessionData, patientId: string): Promise<AccessBasis | null> {
    if (session.kind !== 'STAFF' || !session.permissions.includes('clinical:read')) return null;
    const me = await staffIdOf(session.userId);
    if (!me) return null;
    if (await visitsService.doctorHasVisit(me.id, patientId)) return 'VISIT';
    if (await ordersService.isAddressedTo(me.id, patientId)) return 'ORDER';
    if (await this.activeOverride(session.userId, patientId)) return 'BREAK_GLASS';
    return null;
  },

  /**
   * Gate for every clinical read. Throws 403 (code NO_CARE_RELATIONSHIP, so the UI can offer break-glass) and audits the
   * refusal, or writes the VIEW audit row and returns the basis.
   */
  async assertCanView(actor: Actor, patientId: string, target: ViewTarget): Promise<AccessBasis> {
    await patientsService.getSummary(patientId); // 404 for unknown patients
    const basis = await this.basis(actor.session, patientId);
    if (!basis) {
      await auditService.recordSafe({
        actorId: actor.session.userId, action: AuditAction.ACCESS_DENIED, entity: target.entity, entityId: target.entityId ?? null, patientId, ip: actor.ip ?? null,
        metadata: { reason: 'NO_CARE_RELATIONSHIP', role: actor.session.role },
      });
      throw new AppError(403, 'NO_CARE_RELATIONSHIP', 'You have no visit, order or referral with this patient. Use break-glass access only in an emergency.');
    }
    await auditService.record({
      actorId: actor.session.userId, action: AuditAction.VIEW, entity: target.entity, entityId: target.entityId ?? null, patientId, ip: actor.ip ?? null,
      reason: basis === 'BREAK_GLASS' ? (await this.activeOverride(actor.session.userId, patientId))?.reason ?? null : null,
      metadata: { basis, ...(target.metadata ?? {}) } as Prisma.InputJsonValue,
    });
    return basis;
  },

  /** Emergency access: typed reason → 60 minutes of access → every admin gets an email + in-app alert → audited. */
  async breakGlass(actor: Actor, patientId: string, reason: string) {
    if (actor.session.kind !== 'STAFF' || !actor.session.permissions.includes('clinical:read')) throw AppError.forbidden();
    const me = await staffIdOf(actor.session.userId);
    if (!me) throw AppError.forbidden();
    const patient = await patientsService.getSummary(patientId);
    const existing = await this.activeOverride(actor.session.userId, patientId);
    if (existing) return { override: existing, alreadyActive: true };

    const now = new Date();
    const expiresAt = new Date(now.getTime() + BREAK_GLASS_MINUTES * 60_000);
    const override = await prisma.$transaction(async (tx) => {
      const o = await tx.accessOverride.create({ data: { userId: actor.session.userId, patientId, reason: reason.trim(), expiresAt }, select: { id: true, reason: true, expiresAt: true, createdAt: true } });
      await auditService.record(
        {
          actorId: actor.session.userId, action: AuditAction.BREAK_GLASS, entity: 'access_overrides', entityId: o.id, patientId, reason: o.reason, ip: actor.ip ?? null,
          metadata: { staffCode: me.staffCode, mrn: patient.mrn, minutes: BREAK_GLASS_MINUTES, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
      return o;
    });

    await this.alertAdmins({ overrideId: override.id, doctor: me.fullName, staffCode: me.staffCode, patient: patient.name, mrn: patient.mrn, patientId, reason: override.reason, at: now, until: expiresAt });
    return { override, alreadyActive: false };
  },

  /** Email + in-app alert to every Admin and Super Admin. Never fails the doctor's request. */
  async alertAdmins(a: { overrideId: string; doctor: string; staffCode: string; patient: string; mrn: string; patientId: string; reason: string; at: Date; until: Date }) {
    try {
      const adminIds = [...new Set([...(await authService.userIdsWithRole('ADMIN')), ...(await authService.userIdsWithRole('SUPER_ADMIN'))])];
      const [emails, names] = await Promise.all([authService.emailsByUserIds(adminIds), staffService.namesByUserIds(adminIds)]);
      await Promise.all(
        adminIds.map(async (id) => {
          await notificationsService.inApp(id, {
            subject: `Break-glass: ${a.doctor} opened ${a.mrn}`,
            body: `${a.doctor} (${a.staffCode}) used break-glass access to ${a.patient} (${a.mrn}). Reason: “${a.reason}”. Access until ${formatLocal(a.until)}.`,
            data: { kind: 'BREAK_GLASS', overrideId: a.overrideId, patientId: a.patientId },
          });
          const email = emails.get(id);
          if (email) {
            await notificationsService.notify({ userId: id, email }, 'break-glass-alert', {
              adminName: names.get(id)?.name ?? 'Admin', doctor: a.doctor, staffCode: a.staffCode, patient: a.patient, mrn: a.mrn, reason: a.reason, at: formatLocal(a.at), until: formatLocal(a.until),
            });
          }
        }),
      );
      await prisma.accessOverride.update({ where: { id: a.overrideId }, data: { adminNotifiedAt: new Date() } });
    } catch (err) {
      console.error('[break-glass] admin alert failed:', err instanceof Error ? err.message : err);
    }
  },
};
