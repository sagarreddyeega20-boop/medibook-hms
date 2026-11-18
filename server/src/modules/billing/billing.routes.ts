import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { isDateKey, localDateKey } from '../../lib/time.js';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAnyPermission, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { patientsService } from '../patients/patients.service.js';
import { invoicePdf, receiptPdf } from './billing.pdf.js';
import { billingService, PAYMENT_METHODS } from './billing.service.js';

/**
 * HTTP routes for the billing module, mounted at /api/billing. Every route checks the user's role/permissions.
 * Counter (RECEPTIONIST, ACCOUNTS): payments:collect. Refund requests: refunds:request (reception); decisions: refunds:manage (accounts).
 * Patients see only their own and their family's bills (self:read + household check).
 */
export const billingRouter: Router = Router();

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const paise = z.number().int('Amounts are in whole paise').positive('Enter an amount greater than zero').max(100_000_000);
const dateKey = z.string().refine(isDateKey, 'Use YYYY-MM-DD');
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });

const sendPdf = (res: Response, name: string, pdf: Buffer, download: boolean) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
};
const pdfQuery = z.object({ download: z.enum(['1', '0']).optional() });

billingRouter.use(requireAuth);

/* ---------------- Billing counter ---------------- */

billingRouter.get('/counter', requirePermission('payments:collect'), async (_req, res) => {
  res.json(await billingService.counter());
});

billingRouter.get('/patients', requirePermission('payments:collect'), validate({ query: z.object({ q: z.string().trim().max(80).default('') }) }), async (_req, res) => {
  res.json({ patients: await billingService.searchPatients(res.locals.valid.query.q) });
});

billingRouter.get('/patients/:id', requirePermission('payments:collect'), validate({ params: idParams }), async (_req, res) => {
  res.json(await billingService.patientAccount(res.locals.valid.params.id));
});

billingRouter.get('/invoices/:id', requirePermission('payments:collect'), validate({ params: idParams }), async (_req, res) => {
  res.json({ invoice: await billingService.invoice(res.locals.valid.params.id) });
});

billingRouter.get('/invoices/:id/pdf', requirePermission('payments:collect'), validate({ params: idParams, query: pdfQuery }), async (_req, res) => {
  const inv = await billingService.invoice(res.locals.valid.params.id);
  sendPdf(res, inv.invoiceNumber, invoicePdf(inv), res.locals.valid.query.download === '1');
});

/** Records a counter payment across one or more invoices. 201 = recorded; 200 = this idempotency key was already recorded (same receipt). */
billingRouter.post(
  '/payments',
  requirePermission('payments:collect'),
  validate({
    body: z.object({
      patientId: uuid,
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().trim().max(80).nullable().optional(),
      idempotencyKey: z.string().trim().min(16, 'Missing payment key').max(80).regex(/^[A-Za-z0-9_-]+$/, 'Invalid payment key'),
      allocations: z.array(z.object({ invoiceId: uuid, amountPaise: paise })).min(1, 'Choose at least one invoice').max(20),
    }).refine((b) => b.method === 'CASH' || !!b.reference?.trim(), { message: 'Enter the UPI transaction ID or card last 4 digits', path: ['reference'] }),
  }),
  async (req, res) => {
    const out = await billingService.collectPayment(actor(req, res), res.locals.valid.body);
    res.status(out.replayed ? 200 : 201).json(out);
  },
);

billingRouter.get('/payments/:id', requireAnyPermission('payments:collect', 'transactions:read'), validate({ params: idParams }), async (_req, res) => {
  res.json({ payment: await billingService.receipt(res.locals.valid.params.id) });
});

billingRouter.get('/payments/:id/pdf', requireAnyPermission('payments:collect', 'transactions:read'), validate({ params: idParams, query: pdfQuery }), async (_req, res) => {
  const r = await billingService.receipt(res.locals.valid.params.id);
  sendPdf(res, r.receiptNumber, receiptPdf(r), res.locals.valid.query.download === '1');
});

/* ---------------- Refunds ---------------- */

billingRouter.post(
  '/refunds',
  requirePermission('refunds:request'),
  validate({ body: z.object({ paymentId: uuid, invoiceId: uuid, amountPaise: paise, reason: z.string().trim().min(5, 'Give the reason for the refund').max(300) }) }),
  async (req, res) => {
    res.status(201).json({ refund: await billingService.requestRefund(actor(req, res), res.locals.valid.body) });
  },
);

billingRouter.get(
  '/refunds',
  requireAnyPermission('refunds:manage', 'refunds:request'),
  validate({ query: z.object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED']).optional(), patientId: uuid.optional() }) }),
  async (_req, res) => {
    res.json({ refunds: await billingService.refunds(res.locals.valid.query) });
  },
);

for (const [path, decision] of [['approve', 'APPROVED'], ['reject', 'REJECTED']] as const) {
  billingRouter.post(
    `/refunds/:id/${path}`,
    requirePermission('refunds:manage'),
    validate({
      params: idParams,
      body: z.object({ note: z.string().trim().max(300).nullable().optional() }).refine((b) => decision === 'APPROVED' || (b.note?.length ?? 0) >= 5, { message: 'Say why the refund is rejected', path: ['note'] }),
    }),
    async (req, res) => {
      res.json({ refund: await billingService.decideRefund(actor(req, res), res.locals.valid.params.id, decision, res.locals.valid.body.note ?? null) });
    },
  );
}

/* ---------------- End-of-day cash reconciliation ---------------- */

billingRouter.get('/reconciliation', requireAnyPermission('payments:collect', 'accounts:read'), validate({ query: z.object({ date: dateKey.optional() }) }), async (_req, res) => {
  res.json(await billingService.reconciliation(res.locals.valid.query.date ?? localDateKey()));
});

billingRouter.post(
  '/reconciliation',
  requirePermission('payments:collect'),
  validate({ body: z.object({ date: dateKey, countedCashPaise: z.number().int('Amounts are in whole paise').min(0).max(100_000_000), note: z.string().trim().max(300).nullable().optional() }) }),
  async (req, res) => {
    res.status(201).json({ reconciliation: await billingService.closeDay(actor(req, res), res.locals.valid.body) });
  },
);

/* ---------------- Price list (admin) ---------------- */

billingRouter.get('/catalogue', requirePermission('fees:manage'), async (_req, res) => {
  res.json({ items: await billingService.priceList() });
});

billingRouter.patch(
  '/catalogue/:id',
  requirePermission('fees:manage'),
  validate({ params: idParams, body: z.object({ pricePaise: z.number().int().min(0).max(100_000_000).optional(), taxPercent: z.number().int('Use a whole-number rate').min(0).max(28).optional(), isActive: z.boolean().optional() }) }),
  async (req, res) => {
    res.json({ item: await billingService.updateCatalogueItem(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);

/* ---------------- Patient portal: own + family bills ---------------- */

async function household(res: Response) {
  return patientsService.accessiblePatientIds(getSession(res).userId);
}

billingRouter.get('/me', requirePermission('self:read'), async (_req, res) => {
  res.json(await billingService.forPatients(await household(res)));
});

billingRouter.get('/me/invoices/:id/pdf', requirePermission('self:read'), validate({ params: idParams, query: pdfQuery }), async (_req, res) => {
  const { id } = res.locals.valid.params;
  if (!(await household(res)).includes(await billingService.invoicePatientId(id))) throw AppError.notFound('Invoice not found');
  const inv = await billingService.invoice(id);
  sendPdf(res, inv.invoiceNumber, invoicePdf(inv), res.locals.valid.query.download !== '0');
});

billingRouter.get('/me/payments/:id/pdf', requirePermission('self:read'), validate({ params: idParams, query: pdfQuery }), async (_req, res) => {
  const { id } = res.locals.valid.params;
  if (!(await household(res)).includes(await billingService.paymentPatientId(id))) throw AppError.notFound('Receipt not found');
  const r = await billingService.receipt(id);
  sendPdf(res, r.receiptNumber, receiptPdf(r), res.locals.valid.query.download !== '0');
});
