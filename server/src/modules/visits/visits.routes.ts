import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isDateKey } from '../../lib/time.js';
import { noBody, validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { BREAK_GLASS_MINUTES, careAccess } from '../auth/care-access.service.js';
import { receptionService } from '../reception/reception.service.js';
import { clinicalService, TIMELINE_TYPES, type TimelineType } from './clinical.service.js';

/**
 * HTTP routes for the visits module, mounted at /api/visits — the doctor workspace.
 * Layer 1: the role's permission (clinical:read / clinical:write) — receptionists, accounts and pharmacists get 403 here.
 * Layer 2: careAccess (visit / order / referral / break-glass) inside the service, for every clinical read, each one audited.
 */
export const visitsRouter: Router = Router();

const uuid = z.string().uuid();
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });
const text = (max: number) => z.string().trim().max(max).nullable().optional();

visitsRouter.use(requireAuth);

/* ---------------- Doctor home ---------------- */

visitsRouter.get(
  '/dashboard',
  requirePermission('schedule:own'),
  validate({ query: z.object({ date: z.string().refine(isDateKey, 'Use YYYY-MM-DD').optional() }) }),
  async (req, res) => {
    res.json(await clinicalService.today(actor(req, res), res.locals.valid.query.date));
  },
);

/** Patient lookup (demographics only). Opening the record goes through the access check. */
visitsRouter.get('/patients/search', requirePermission('clinical:read'), validate({ query: z.object({ q: z.string().trim().min(2).max(60) }) }), async (_req, res) => {
  res.json({ patients: await clinicalService.search(res.locals.valid.query.q) });
});

/* ---------------- Patient-level clinical reads (access-checked + audited) ---------------- */

const typeFilter = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').filter((t): t is TimelineType => (TIMELINE_TYPES as string[]).includes(t)) : undefined));

visitsRouter.get(
  '/patients/:patientId/timeline',
  requirePermission('clinical:read'),
  validate({ params: z.object({ patientId: uuid }), query: z.object({ type: typeFilter }) }),
  async (req, res) => {
    res.json(await clinicalService.timeline(actor(req, res), res.locals.valid.params.patientId, res.locals.valid.query.type));
  },
);

visitsRouter.get('/patients/:patientId/notes', requirePermission('clinical:read'), validate({ params: z.object({ patientId: uuid }) }), async (req, res) => {
  res.json({ notes: await clinicalService.notes(actor(req, res), res.locals.valid.params.patientId) });
});

visitsRouter.put(
  '/patients/:patientId/allergies',
  requirePermission('clinical:write'),
  validate({ params: z.object({ patientId: uuid }), body: z.object({ allergies: text(500) }) }),
  async (req, res) => {
    res.json({ patient: await clinicalService.updateAllergies(actor(req, res), res.locals.valid.params.patientId, res.locals.valid.body.allergies ?? null) });
  },
);

/** Does the signed-in doctor have access right now? (No clinical data; decides whether to offer break-glass.) */
visitsRouter.get('/patients/:patientId/access', requirePermission('clinical:read'), validate({ params: z.object({ patientId: uuid }) }), async (_req, res) => {
  const s = getSession(res);
  const id = res.locals.valid.params.patientId;
  res.json({ basis: await careAccess.basis(s, id), override: await careAccess.activeOverride(s.userId, id) });
});

/** Break-glass: typed reason → 60 minutes of access, admins alerted, audited. */
visitsRouter.post(
  '/patients/:patientId/break-glass',
  requirePermission('clinical:read'),
  validate({
    params: z.object({ patientId: uuid }),
    body: z.object({ reason: z.string().trim().min(10, 'Describe the emergency in at least 10 characters').max(500) }),
  }),
  async (req, res) => {
    const r = await careAccess.breakGlass(actor(req, res), res.locals.valid.params.patientId, res.locals.valid.body.reason);
    res.status(r.alreadyActive ? 200 : 201).json({ ...r, minutes: BREAK_GLASS_MINUTES });
  },
);

/* ---------------- Visit (consultation) ---------------- */

visitsRouter.get('/:id', requirePermission('clinical:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json(await clinicalService.consultation(actor(req, res), res.locals.valid.params.id));
});

visitsRouter.get('/:id/notes', requirePermission('clinical:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  res.json({ notes: await clinicalService.visitNotes(actor(req, res), res.locals.valid.params.id) });
});

visitsRouter.put(
  '/:id/notes',
  requirePermission('clinical:write'),
  validate({ params: z.object({ id: uuid }), body: z.object({ complaint: text(2000), findings: text(4000), diagnosis: text(500), advice: text(4000) }) }),
  async (req, res) => {
    res.json({ note: await clinicalService.saveNote(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);

/** Start consult: the doctor calls in a checked-in patient (the same queue move reception uses). */
visitsRouter.post('/:id/start', requirePermission('clinical:write'), validate({ params: z.object({ id: uuid }), body: noBody }), async (req, res) => {
  const a = actor(req, res);
  await clinicalService.ownVisit(a, res.locals.valid.params.id);
  res.json({ visit: await receptionService.callIn(a, res.locals.valid.params.id) });
});

/** Complete visit: closes it and creates the consultation charge. */
visitsRouter.post('/:id/complete', requirePermission('clinical:write'), validate({ params: z.object({ id: uuid }), body: noBody }), async (req, res) => {
  const a = actor(req, res);
  await clinicalService.ownVisit(a, res.locals.valid.params.id);
  res.json({ visit: await receptionService.finish(a, res.locals.valid.params.id) });
});
