import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { pharmacyService } from './pharmacy.service.js';

/**
 * HTTP routes for the pharmacy module, mounted at /api/pharmacy. Every route checks the user's role/permissions.
 * Pharmacists see prescriptions to dispense and stock — never clinical notes, and they cannot edit a prescription.
 */
export const pharmacyRouter: Router = Router();

const uuid = z.string().uuid();
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });
const paise = z.number().int('Amounts are in whole paise').min(0).max(100_000_000);
const label = (max: number) => z.string().trim().max(max).nullable().optional();

pharmacyRouter.use(requireAuth);

/* ---------------- Prescriptions to dispense ---------------- */

pharmacyRouter.get('/dashboard', requirePermission('pharmacy:dispense'), async (_req, res) => {
  res.json(await pharmacyService.dashboard());
});

pharmacyRouter.get('/prescriptions/:id', requirePermission('prescriptions:read'), validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await pharmacyService.dispenseView(res.locals.valid.params.id));
});

pharmacyRouter.post(
  '/prescriptions/:id/dispense',
  requirePermission('pharmacy:dispense'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ items: z.array(z.object({ itemId: uuid, quantity: z.number().int().min(0).max(10_000) })).min(1).max(50) }),
  }),
  async (req, res) => {
    res.json(await pharmacyService.dispense(actor(req, res), res.locals.valid.params.id, res.locals.valid.body.items));
  },
);

/* ---------------- Stock ---------------- */

pharmacyRouter.get('/medicines', requirePermission('pharmacy:stock'), validate({ query: z.object({ q: z.string().trim().max(60).default('') }) }), async (_req, res) => {
  res.json(await pharmacyService.medicines(res.locals.valid.query.q));
});

pharmacyRouter.get('/medicines/:id', requirePermission('pharmacy:stock'), validate({ params: z.object({ id: uuid }) }), async (_req, res) => {
  res.json(await pharmacyService.medicine(res.locals.valid.params.id));
});

pharmacyRouter.post(
  '/medicines',
  requirePermission('pharmacy:stock'),
  validate({
    body: z.object({
      name: z.string().trim().min(2, 'Enter the medicine name').max(120),
      genericName: label(120),
      strength: label(40),
      form: label(40),
      sellingPricePaise: paise,
      purchasePricePaise: paise,
      reorderLevel: z.number().int().min(0).max(100_000).default(10),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ medicine: await pharmacyService.createMedicine(actor(req, res), res.locals.valid.body) });
  },
);

pharmacyRouter.patch(
  '/medicines/:id',
  requirePermission('pharmacy:stock'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      genericName: label(120),
      strength: label(40),
      form: label(40),
      sellingPricePaise: paise.optional(),
      reorderLevel: z.number().int().min(0).max(100_000).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    res.json({ medicine: await pharmacyService.updateMedicine(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);

pharmacyRouter.post(
  '/medicines/:id/stock-in',
  requirePermission('pharmacy:stock'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ quantity: z.number().int().min(1, 'Quantity must be at least 1').max(100_000), unitCostPaise: paise, reference: label(120) }),
  }),
  async (req, res) => {
    res.status(201).json({ medicine: await pharmacyService.stockIn(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);
