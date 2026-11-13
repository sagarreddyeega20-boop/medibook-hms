import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requireAnyPermission, requirePermission } from '../auth/auth.middleware.js';
import { staffService } from '../staff/staff.service.js';
import { patientsService } from './patients.service.js';

/** HTTP routes for the patients module, mounted at /api/patients. Every route checks the user's role/permissions. */
export const patientsRouter: Router = Router();

const idParams = z.object({ id: z.string().uuid() });
const actor = (req: Request, res: Response) => ({ session: getSession(res), ip: clientIp(req) });

const today = () => new Date().toISOString().slice(0, 10);
const dob = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)) && d <= today() && d >= '1900-01-01', 'Enter a valid date of birth');
const phone = z.string().trim().regex(/^\+?[0-9 -]{10,16}$/, 'Enter a valid mobile number');
const gender = z.enum(['MALE', 'FEMALE', 'OTHER']);
const relationship = z.string().trim().min(2, 'Enter the relationship, e.g. Mother').max(40);

patientsRouter.use(requireAuth);

/* ---------------- Patient portal (own record + family) ---------------- */

/** The signed-in patient's own profile (MRN etc.). */
patientsRouter.get('/me', requirePermission('self:read'), async (_req, res) => {
  const patient = await patientsService.findByUserId(getSession(res).userId);
  if (!patient) throw AppError.notFound('Patient record not found');
  res.json({ patient });
});

/** Self + family members on this account. */
patientsRouter.get('/me/family', requirePermission('self:read'), async (_req, res) => {
  res.json({ household: await patientsService.household(getSession(res).userId) });
});

patientsRouter.post(
  '/me/family',
  requirePermission('family:manage'),
  validate({ body: z.object({ fullName: z.string().trim().min(2, 'Enter the full name').max(120), gender, dateOfBirth: dob, phone: phone.optional(), relationship }) }),
  async (req, res) => {
    res.status(201).json({ member: await patientsService.addFamilyMemberByPatient(actor(req, res), res.locals.valid.body) });
  },
);

/* ---------------- Reception: search, register, family links ---------------- */

patientsRouter.get(
  '/search',
  requireAnyPermission('patients:register', 'reception:read'),
  validate({ query: z.object({ q: z.string().trim().max(80).default('') }) }),
  async (_req, res) => {
    res.json({ patients: await patientsService.search(res.locals.valid.query.q) });
  },
);

/** Live duplicate check while the registration form is filled in. */
patientsRouter.post(
  '/duplicates',
  requirePermission('patients:register'),
  validate({ body: z.object({ fullName: z.string().trim().min(2).max(120), dateOfBirth: dob, phone }) }),
  async (_req, res) => {
    const b = res.locals.valid.body;
    res.json({ matches: await patientsService.findDuplicates({ fullName: b.fullName, dateOfBirth: new Date(`${b.dateOfBirth}T00:00:00Z`), phone: b.phone }) });
  },
);

patientsRouter.post(
  '/',
  requirePermission('patients:register'),
  validate({
    body: z.object({
      fullName: z.string().trim().min(2, 'Enter the full name').max(120),
      gender,
      dateOfBirth: dob,
      phone,
      email: z.string().trim().toLowerCase().email('Enter a valid email').max(254).optional().or(z.literal('').transform(() => undefined)),
      address: z.string().trim().max(300).optional(),
      confirmNotDuplicate: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const a = actor(req, res);
    const staff = await staffService.profileByUserId(a.session.userId);
    res.status(201).json({ patient: await patientsService.registerAtReception({ ...a, staffId: staff?.id ?? null }, res.locals.valid.body) });
  },
);

patientsRouter.get('/:id', requirePermission('patients:read_contact'), validate({ params: idParams }), async (_req, res) => {
  res.json({ patient: await patientsService.detail(res.locals.valid.params.id) });
});

patientsRouter.post(
  '/:id/family',
  requirePermission('patients:register'),
  validate({ params: idParams, body: z.object({ memberPatientId: z.string().uuid('Choose a patient'), relationship }) }),
  async (req, res) => {
    const { id } = res.locals.valid.params;
    res.status(201).json({ member: await patientsService.linkFamily(actor(req, res), { accountPatientId: id, ...res.locals.valid.body }) });
  },
);

patientsRouter.delete(
  '/:id/family/:linkId',
  requirePermission('patients:register'),
  validate({ params: z.object({ id: z.string().uuid(), linkId: z.string().uuid() }) }),
  async (_req, res) => {
    await patientsService.unlinkFamily(res.locals.valid.params.id, res.locals.valid.params.linkId);
    res.status(204).end();
  },
);
