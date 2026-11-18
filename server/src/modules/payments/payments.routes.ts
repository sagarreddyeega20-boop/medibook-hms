import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { rateLimit } from '../../lib/rateLimit.js';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { paymentsService } from './payments.service.js';

/**
 * HTTP routes for the payments module, mounted at /api/payments.
 * Patients pay for their own held slot; the gateway confirms through the signed webhook (the only public route).
 */
export const paymentsRouter: Router = Router();

const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });
const uuid = z.string().uuid();
const key = z.string().trim().min(8).max(100);
/** Patients only: online checkout is for one's own (or family's) booking. */
const canPay = requirePermission('self:book');

/* ---------------- Gateway webhook (public, signed) ---------------- */

const webhookEvent = z.object({
  type: z.enum(['payment.captured', 'payment.failed']),
  providerOrderId: z.string().min(1).max(100),
  providerPaymentId: z.string().min(1).max(100),
  amountPaise: z.number().int().min(0),
  error: z.string().max(500).optional(),
});

paymentsRouter.post(
  '/webhook/:provider',
  rateLimit({ name: 'payment-webhook', max: 600, windowSeconds: 60 }),
  validate({ params: z.object({ provider: z.string().regex(/^[a-z]{2,20}$/) }), body: webhookEvent }),
  async (req, res) => {
    // The signature covers the body exactly as the gateway sent it.
    await paymentsService.handleWebhook(res.locals.valid.params.provider, req.body, req.get('x-medibook-signature'));
    res.json({ ok: true });
  },
);

/* ---------------- Patient checkout ---------------- */

paymentsRouter.use(requireAuth);

paymentsRouter.get('/checkout', canPay, validate({ query: z.object({ holdId: uuid, patientId: uuid }) }), async (req, res) => {
  res.json({ checkout: await paymentsService.checkout(actor(req, res), res.locals.valid.query) });
});

paymentsRouter.post(
  '/orders',
  canPay,
  validate({ body: z.object({ holdId: uuid, patientId: uuid, reason: z.string().max(500).optional(), idempotencyKey: key }) }),
  async (req, res) => {
    res.status(201).json({ order: await paymentsService.createOrder(actor(req, res), res.locals.valid.body) });
  },
);

paymentsRouter.get('/orders/:id', canPay, validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json({ order: await paymentsService.order(actor(req, res), res.locals.valid.params.id) });
});

/** Card numbers never reach the server: the browser checks the number (Luhn, brand) and sends brand + last 4 only. */
const instrument = z.discriminatedUnion('method', [
  z.object({ method: z.literal('UPI'), provider: z.string().trim().min(2).max(40), upiId: z.string().trim().regex(/^[\w.-]{2,64}@[a-zA-Z]{2,32}$/, 'Enter a UPI ID like name@bank').optional() }),
  z.object({ method: z.literal('CARD'), provider: z.enum(['Visa', 'Mastercard', 'RuPay']), last4: z.string().regex(/^\d{4}$/) }).strict(),
  z.object({ method: z.literal('NETBANKING'), provider: z.string().trim().min(2).max(40) }).strict(),
  z.object({ method: z.literal('WALLET'), provider: z.string().trim().min(2).max(40) }).strict(),
]);

paymentsRouter.post(
  '/orders/:id/pay',
  canPay,
  validate({ params: z.object({ id: uuid }), body: z.object({ idempotencyKey: key, instrument }) }),
  async (req, res) => {
    res.json({ order: await paymentsService.pay(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);
