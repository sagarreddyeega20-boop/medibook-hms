import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * Audit service — append-only audit log of every clinical view and every change.
 * Owns: audit_logs. Other modules call auditService.record(), never the table directly.
 */
export interface AuditEntry {
  actorId?: string | null;
  action: string; // see AuditAction; clinical modules add VIEW, CREATE, UPDATE, BREAK_GLASS …
  entity: string; // table name, e.g. "clinical_notes"
  entityId?: string | null;
  patientId?: string | null;
  reason?: string | null;
  ip?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Identity & access events. */
export const AuditAction = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED', // wrong staff ID / password, inactive account
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED', // too many wrong passwords
  OTP_FAILED: 'OTP_FAILED',
  OTP_LOCKED: 'OTP_LOCKED',
  LOGOUT: 'LOGOUT',
  PASSWORD_SET: 'PASSWORD_SET',
  STAFF_CREATED: 'STAFF_CREATED',
  STAFF_INVITE_SENT: 'STAFF_INVITE_SENT',
  ROLE_CHANGED: 'ROLE_CHANGED',
  STAFF_DEACTIVATED: 'STAFF_DEACTIVATED',
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  // Patients
  FAMILY_LINKED: 'FAMILY_LINKED',
  // Hospital setup
  DEPARTMENT_CREATED: 'DEPARTMENT_CREATED',
  DEPARTMENT_UPDATED: 'DEPARTMENT_UPDATED',
  DOCTOR_PROFILE_UPDATED: 'DOCTOR_PROFILE_UPDATED',
  SCHEDULE_UPDATED: 'SCHEDULE_UPDATED',
  LEAVE_ADDED: 'LEAVE_ADDED',
  LEAVE_REMOVED: 'LEAVE_REMOVED',
  // Booking and the queue
  APPOINTMENT_BOOKED: 'APPOINTMENT_BOOKED',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  APPOINTMENT_RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
  CHECKED_IN: 'CHECKED_IN',
  WALK_IN_REGISTERED: 'WALK_IN_REGISTERED',
  CONSULT_STARTED: 'CONSULT_STARTED',
  CONSULT_ENDED: 'CONSULT_ENDED',
  // Clinical (every VIEW of clinical data is logged, not just changes)
  VIEW: 'VIEW',
  BREAK_GLASS: 'BREAK_GLASS',
  NOTE_SAVED: 'NOTE_SAVED',
  ALLERGIES_UPDATED: 'ALLERGIES_UPDATED',
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  REFERRAL_CREATED: 'REFERRAL_CREATED',
  REFERRAL_BOOKED: 'REFERRAL_BOOKED',
  PRESCRIPTION_CREATED: 'PRESCRIPTION_CREATED',
  CHARGE_CREATED: 'CHARGE_CREATED',
  // Department queues
  ORDER_STARTED: 'ORDER_STARTED', // sample collected / scan done
  RESULT_UPLOADED: 'RESULT_UPLOADED',
  MEDICINE_DISPENSED: 'MEDICINE_DISPENSED',
  MEDICINE_CREATED: 'MEDICINE_CREATED',
  MEDICINE_UPDATED: 'MEDICINE_UPDATED',
  STOCK_IN: 'STOCK_IN',
} as const;

export interface AuditQuery {
  action?: string;
  actorId?: string;
  patientId?: string;
  limit: number;
  before?: bigint; // id cursor
}

export const auditService = {
  record(entry: AuditEntry, tx: Prisma.TransactionClient = prisma) {
    return tx.auditLog.create({ data: entry });
  },

  /** Never let a failed audit write break the request that triggered it (login paths). */
  async recordSafe(entry: AuditEntry) {
    try {
      await prisma.auditLog.create({ data: entry });
    } catch (err) {
      console.error('[audit] write failed', entry.action, err);
    }
  },

  list(q: AuditQuery) {
    return prisma.auditLog.findMany({
      where: {
        action: q.action || undefined,
        actorId: q.actorId || undefined,
        patientId: q.patientId || undefined,
        id: q.before ? { lt: q.before } : undefined,
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
  },

  async countsSince(since: Date) {
    const rows = await prisma.auditLog.groupBy({ by: ['action'], where: { createdAt: { gte: since } }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.action, r._count])) as Record<string, number>;
  },
};
