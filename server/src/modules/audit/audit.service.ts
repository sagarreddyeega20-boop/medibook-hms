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
} as const;

export interface AuditQuery {
  action?: string;
  actorId?: string;
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
