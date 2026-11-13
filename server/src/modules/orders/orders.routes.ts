import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { billingService } from '../billing/billing.service.js';
import { pharmacyService } from '../pharmacy/pharmacy.service.js';
import { staffService } from '../staff/staff.service.js';
import { ordersService } from './orders.service.js';

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

/* ---------------- Department queues (built with the lab / radiology module) ---------------- */

ordersRouter.get('/lab/dashboard', requirePermission('orders:lab'), (_req, res) => {
  res.json({ module: 'orders', title: 'Lab queue', placeholder: true });
});

ordersRouter.get('/radiology/dashboard', requirePermission('orders:radiology'), (_req, res) => {
  res.json({ module: 'orders', title: 'Radiology queue', placeholder: true });
});
