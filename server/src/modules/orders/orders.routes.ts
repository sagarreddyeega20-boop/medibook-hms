import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { findUpload } from '../../lib/uploads.js';
import { noBody, validate } from '../../lib/validate.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { clientIp, getSession, ownDataOnly, requireAnyPermission, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { careAccess } from '../auth/care-access.service.js';
import { billingService } from '../billing/billing.service.js';
import { patientsService } from '../patients/patients.service.js';
import { pharmacyService } from '../pharmacy/pharmacy.service.js';
import { staffService } from '../staff/staff.service.js';
import { ordersService, QUEUE_PERMISSION, RESULTS_FOLDER, type QueueType } from './orders.service.js';

/** HTTP routes for the orders module, mounted at /api/orders. Every route checks the user's role/permissions. */
export const ordersRouter: Router = Router();

const uuid = z.string().uuid();
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });
const priority = z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE');
const opt = (max: number) => z.string().trim().max(max).nullable().optional();

ordersRouter.use(requireAuth);

/* ---------------- Pickers for the consultation screen ---------------- */

/** Lab tests and radiology scans from the service catalogue. */
ordersRouter.get('/catalogue', requirePermission('orders:create'), validate({ query: z.object({ type: z.enum(['LAB', 'RADIOLOGY']).optional() }) }), async (_req, res) => {
  const t = res.locals.valid.query.type;
  res.json({ items: await billingService.catalogue(t === 'LAB' ? ['LAB_TEST'] : t === 'RADIOLOGY' ? ['RADIOLOGY_SCAN'] : ['LAB_TEST', 'RADIOLOGY_SCAN']) });
});

ordersRouter.get('/medicines', requirePermission('prescriptions:write'), validate({ query: z.object({ q: z.string().trim().max(60).default('') }) }), async (_req, res) => {
  res.json({ medicines: await pharmacyService.searchMedicines(res.locals.valid.query.q) });
});

/** Clinical departments and their doctors (referral target picker). */
ordersRouter.get('/referral-targets', requirePermission('referrals:create'), async (_req, res) => {
  const [departments, doctors] = await Promise.all([staffService.departments(), staffService.listDoctors()]);
  res.json({
    departments: departments
      .filter((d) => d.kind === 'CLINICAL')
      .map((d) => ({ ...d, doctors: doctors.filter((x) => x.department?.id === d.id).map((x) => ({ id: x.id, name: x.fullName, specialty: x.specialty })) })),
  });
});

/* ---------------- Create orders (doctor, own open visit) ---------------- */

ordersRouter.post(
  '/investigations',
  requirePermission('orders:create'),
  validate({ body: z.object({ visitId: uuid, catalogueItemId: uuid, priority, notes: opt(1000) }) }),
  async (req, res) => {
    res.status(201).json({ order: await ordersService.createInvestigation(actor(req, res), res.locals.valid.body) });
  },
);

ordersRouter.post(
  '/referrals',
  requirePermission('referrals:create'),
  validate({
    body: z.object({
      visitId: uuid,
      toDepartmentId: uuid,
      toDoctorId: uuid.nullable().optional(),
      reason: z.string().trim().min(5, 'Give the referral reason').max(2000),
      priority,
    }),
  }),
  async (req, res) => {
    res.status(201).json({ order: await ordersService.createReferral(actor(req, res), res.locals.valid.body) });
  },
);

const rxItem = z.object({
  medicineId: uuid.nullable().optional(),
  medicineName: z.string().trim().min(2, 'Enter the medicine').max(120),
  dose: opt(60),
  frequency: opt(40),
  durationDays: z.number().int().min(1).max(365).nullable().optional(),
  route: opt(40),
  instructions: opt(300),
  quantity: z.number().int().min(1).max(10_000).nullable().optional(),
});

ordersRouter.post(
  '/prescriptions',
  requirePermission('prescriptions:write'),
  validate({ body: z.object({ visitId: uuid, notes: opt(1000), items: z.array(rxItem).min(1, 'Add at least one medicine').max(20) }) }),
  async (req, res) => {
    res.status(201).json({ order: await ordersService.createPrescription(actor(req, res), res.locals.valid.body) });
  },
);

ordersRouter.post(
  '/:id/cancel',
  requirePermission('orders:create'),
  validate({ params: z.object({ id: uuid }), body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  async (req, res) => {
    res.json({ order: await ordersService.cancel(actor(req, res), res.locals.valid.params.id, res.locals.valid.body.reason) });
  },
);

/* ---------------- Department queues: lab and radiology (no clinical notes on any of these) ---------------- */

ordersRouter.get('/lab/dashboard', requirePermission('orders:lab'), async (req, res) => {
  res.json(await ordersService.queue(actor(req, res), 'LAB'));
});

ordersRouter.get('/radiology/dashboard', requirePermission('orders:radiology'), async (req, res) => {
  res.json(await ordersService.queue(actor(req, res), 'RADIOLOGY'));
});

/** Sample collected / scan done → IN_PROGRESS. The service checks the order type matches the technician's queue. */
ordersRouter.post('/:id/start', requireAnyPermission('orders:lab', 'orders:radiology'), validate({ params: z.object({ id: uuid }), body: noBody }), async (req, res) => {
  res.json({ order: await ordersService.markInProgress(actor(req, res), res.locals.valid.params.id) });
});

/** Upload the result: findings text + optional PDF/image (base64, ≤ 5 MB, type checked from the bytes) → RESULT_READY. */
ordersRouter.post(
  '/:id/result',
  requirePermission('results:upload'),
  requireAnyPermission('orders:lab', 'orders:radiology'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      summary: z.string().trim().min(3, 'Write the findings').max(4000),
      isAbnormal: z.boolean().default(false),
      file: z.object({ name: z.string().trim().max(200).optional(), base64: z.string().min(1).max(8_000_000) }).nullable().optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ order: await ordersService.uploadResult(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);

/**
 * Result file, served only to authorised users — never as a static file:
 *   - the technicians of that queue (orders:lab / orders:radiology),
 *   - clinicians with a care relationship or break-glass (audited as a VIEW of order_results),
 *   - the patient (or the family account holder) in the portal.
 * Everyone else gets 403, and the refusal is audited.
 */
ordersRouter.get('/results/:resultId/file', ownDataOnly, validate({ params: z.object({ resultId: uuid }) }), async (req, res) => {
  const a = actor(req, res);
  const ref = await ordersService.resultRef(res.locals.valid.params.resultId);
  const s = a.session;
  let allowed = false;
  if (s.kind === 'STAFF' && s.permissions.includes(QUEUE_PERMISSION[ref.type as QueueType] ?? '__none__')) allowed = true;
  else if (s.kind === 'STAFF' && s.permissions.includes('clinical:read')) {
    await careAccess.assertCanView(a, ref.patientId, { entity: 'order_results', entityId: ref.id, metadata: { orderNumber: ref.orderNumber, file: true } });
    allowed = true;
  } else if (s.kind === 'PATIENT' && s.permissions.includes('self:read')) {
    allowed = (await patientsService.accessiblePatientIds(s.userId)).includes(ref.patientId);
  }
  if (!allowed) {
    await auditService.recordSafe({ actorId: s.userId, action: AuditAction.ACCESS_DENIED, entity: 'order_results', entityId: ref.id, patientId: ref.patientId, ip: a.ip, metadata: { role: s.role, file: true } });
    throw AppError.forbidden();
  }
  const file = await findUpload(RESULTS_FOLDER, ref.id);
  if (!file) throw AppError.notFound('The report file is missing');
  res.set({
    'Content-Type': file.mimeType,
    'Content-Disposition': `inline; filename="${ref.orderNumber}.${file.ext}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.sendFile(file.path);
});
