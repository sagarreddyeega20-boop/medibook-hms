import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * Audit service — append-only audit log of every clinical view and every change.
 * Owns: audit_logs. Other modules call auditService.record(), never the table directly.
 */
export interface AuditEntry {
  actorId?: string | null;
  action: string; // VIEW, CREATE, UPDATE, DELETE, LOGIN, BREAK_GLASS …
  entity: string; // table name, e.g. "clinical_notes"
  entityId?: string | null;
  patientId?: string | null;
  reason?: string | null;
  ip?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export const auditService = {
  record(entry: AuditEntry, tx: Prisma.TransactionClient = prisma) {
    return tx.auditLog.create({ data: entry });
  },
};
