import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';
import { auditService } from './audit.service.js';

/** HTTP routes for the audit module, mounted at /api/audit. */
export const auditRouter: Router = Router();

auditRouter.use(requireAuth);

auditRouter.get(
  '/',
  requirePermission('audit:read'),
  validate({
    query: z.object({
      action: z.string().max(40).optional(),
      patientId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      before: z.coerce.bigint().optional(),
    }),
  }),
  async (_req, res) => {
    const q = res.locals.valid.query;
    const rows = await auditService.list(q);
    const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const patientIds = [...new Set(rows.map((r) => r.patientId).filter((x): x is string => !!x))];
    const [staff, patients, subjects] = await Promise.all([staffService.namesByUserIds(ids), patientsService.namesByUserIds(ids), patientsService.summaries(patientIds)]);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    res.json({
      entries: rows.map((r) => ({
        id: r.id.toString(),
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        actor: r.actorId ? (staff.get(r.actorId) ?? patients.get(r.actorId) ?? { name: 'Unknown', code: null }) : null,
        patient: r.patientId ? (subjects.has(r.patientId) ? { id: r.patientId, name: subjects.get(r.patientId)!.name, mrn: subjects.get(r.patientId)!.mrn } : { id: r.patientId, name: 'Patient', mrn: null }) : null,
        reason: r.reason,
        ip: r.ip,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      last24h: await auditService.countsSince(since),
    });
  },
);
