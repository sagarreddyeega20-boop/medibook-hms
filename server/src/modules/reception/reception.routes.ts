import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isDateKey } from '../../lib/time.js';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { receptionService } from './reception.service.js';

/** HTTP routes for the reception module, mounted at /api/reception. Every route checks the user's role/permissions. */
export const receptionRouter: Router = Router();

const uuid = z.string().uuid();
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });

receptionRouter.use(requireAuth);

/** The live board: every doctor's calculated status, queue and slots for a day. */
receptionRouter.get(
  '/board',
  requirePermission('reception:read'),
  validate({ query: z.object({ date: z.string().refine(isDateKey, 'Use YYYY-MM-DD').optional(), departmentId: uuid.optional() }) }),
  async (_req, res) => {
    const q = res.locals.valid.query;
    res.json(await receptionService.board({ date: q.date, departmentId: q.departmentId, viewerUserId: getSession(res).userId }));
  },
);

receptionRouter.post('/check-in', requirePermission('appointments:checkin'), validate({ body: z.object({ appointmentId: uuid }) }), async (req, res) => {
  res.status(201).json(await receptionService.checkIn(actor(req, res), res.locals.valid.body.appointmentId));
});

receptionRouter.post(
  '/walk-ins',
  requirePermission('appointments:checkin'),
  validate({ body: z.object({ patientId: uuid, doctorId: uuid, complaint: z.string().trim().max(300).optional() }) }),
  async (req, res) => {
    res.status(201).json(await receptionService.walkIn(actor(req, res), res.locals.valid.body));
  },
);

receptionRouter.post('/visits/:id/call', requirePermission('appointments:checkin'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json({ visit: await receptionService.callIn(actor(req, res), res.locals.valid.params.id) });
});

receptionRouter.post('/visits/:id/finish', requirePermission('appointments:checkin'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json({ visit: await receptionService.finish(actor(req, res), res.locals.valid.params.id) });
});
