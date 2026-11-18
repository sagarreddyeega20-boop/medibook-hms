import { Router } from 'express';
import { z } from 'zod';
import { addDays, isDateKey, localDateKey } from '../../lib/time.js';
import { validate } from '../../lib/validate.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { accountsService } from './accounts.service.js';

/** HTTP routes for the accounts module, mounted at /api/accounts. Every route checks the user's role/permissions. */
export const accountsRouter: Router = Router();

const dateKey = z.string().refine(isDateKey, 'Use YYYY-MM-DD');
/** Default range: the last 30 days including today (hospital-local dates). */
const range = z.object({ from: dateKey.optional(), to: dateKey.optional() }).transform((q) => {
  const to = q.to ?? localDateKey();
  return { to, from: q.from ?? addDays(to, -29) };
});

accountsRouter.use(requireAuth);

/** ACCOUNTS home: revenue by department, pharmacy margin, visit and patient counts, transactions, refunds. */
accountsRouter.get('/dashboard', requirePermission('accounts:read'), validate({ query: range }), async (_req, res) => {
  const { from, to } = res.locals.valid.query;
  res.json(await accountsService.dashboard(from, to));
});

accountsRouter.get('/transactions.csv', requirePermission('transactions:read'), validate({ query: range }), async (req, res) => {
  const { from, to } = res.locals.valid.query;
  const out = await accountsService.transactionsCsv(from, to);
  await auditService.recordSafe({ actorId: getSession(res).userId, action: AuditAction.TRANSACTIONS_EXPORTED, entity: 'payments', ip: clientIp(req), metadata: { from, to, rows: out.count } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(out.csv);
});
