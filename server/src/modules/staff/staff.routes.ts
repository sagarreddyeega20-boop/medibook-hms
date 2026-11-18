import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { noBody, validate } from '../../lib/validate.js';
import { clientIp, getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { STAFF_ROLES } from '../auth/permissions.js';
import { ROLE_NAMES, staffService } from './staff.service.js';

/** HTTP routes for the staff module ("Staff & roles" admin console), mounted at /api/staff. */
export const staffRouter: Router = Router();

const roleEnum = z.enum(STAFF_ROLES);
const idParams = z.object({ id: z.string().uuid() });
const actor = (req: Request, res: Response) => ({
  session: getSession(res),
  ip: clientIp(req),
});

staffRouter.use(requireAuth);

staffRouter.get('/', requirePermission('staff:read'), async (_req, res) => {
  res.json({ staff: await staffService.list() });
});

/** Departments and the roles this user may assign (drives the "Add staff" form). */
staffRouter.get('/options', requirePermission('staff:read'), async (_req, res) => {
  const s = getSession(res);
  const assignable = STAFF_ROLES.filter((r) => r !== 'SUPER_ADMIN' && (r !== 'ADMIN' || s.permissions.includes('staff:create_admin')));
  res.json({
    departments: await staffService.departments(),
    roles: assignable.map((code) => ({ code, name: ROLE_NAMES[code] })),
  });
});

staffRouter.post(
  '/',
  requirePermission('staff:create'),
  validate({
    body: z.object({
      fullName: z.string().trim().min(2, 'Enter the full name').max(120),
      email: z.string().trim().toLowerCase().email('Enter a valid work email').max(254),
      role: roleEnum,
      departmentId: z.string().uuid('Choose a department'),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ staff: await staffService.create(actor(req, res), res.locals.valid.body) });
  },
);

staffRouter.patch(
  '/:id/role',
  requirePermission('staff:update'),
  validate({ params: idParams, body: z.object({ role: roleEnum }) }),
  async (req, res) => {
    res.json({ staff: await staffService.changeRole(actor(req, res), res.locals.valid.params.id, res.locals.valid.body.role) });
  },
);

staffRouter.post('/:id/deactivate', requirePermission('staff:deactivate'), validate({ params: idParams, body: noBody }), async (req, res) => {
  res.json({ staff: await staffService.deactivate(actor(req, res), res.locals.valid.params.id) });
});

staffRouter.post('/:id/invite', requirePermission('staff:update'), validate({ params: idParams, body: noBody }), async (req, res) => {
  res.json(await staffService.sendInvite(actor(req, res), res.locals.valid.params.id));
});

/* ---------------- Departments ---------------- */

const deptKind = z.enum(['CLINICAL', 'LAB', 'RADIOLOGY', 'PHARMACY', 'ADMIN', 'BILLING']);

staffRouter.get('/departments', requirePermission('departments:manage'), async (_req, res) => {
  res.json({ departments: await staffService.allDepartments() });
});

staffRouter.post(
  '/departments',
  requirePermission('departments:manage'),
  validate({
    body: z.object({
      code: z.string().trim().regex(/^[A-Za-z]{2,8}$/, 'Code is 2–8 letters, e.g. ORTHO'),
      name: z.string().trim().min(2, 'Enter the department name').max(80),
      kind: deptKind,
    }),
  }),
  async (req, res) => {
    res.status(201).json({ department: await staffService.createDepartment(actor(req, res), res.locals.valid.body) });
  },
);

staffRouter.patch(
  '/departments/:id',
  requirePermission('departments:manage'),
  validate({
    params: idParams,
    body: z.object({ name: z.string().trim().min(2).max(80).optional(), kind: deptKind.optional(), isActive: z.boolean().optional() }),
  }),
  async (req, res) => {
    res.json({ department: await staffService.updateDepartment(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);

/* ---------------- Doctor profiles (department, specialty, fee, default slot length) ---------------- */

staffRouter.get('/doctors', requirePermission('schedules:manage'), async (_req, res) => {
  res.json({ doctors: await staffService.listDoctors({ includeInactive: true }) });
});

staffRouter.patch(
  '/doctors/:id',
  requirePermission('schedules:manage', 'fees:manage'),
  validate({
    params: idParams,
    body: z.object({
      departmentId: z.string().uuid('Choose a department').optional(),
      specialty: z.string().trim().max(80).nullable().optional(),
      consultationFeePaise: z.number().int('Fee must be whole paise').min(0).max(10_000_000).optional(),
      slotMinutes: z.number().int().min(5).max(120).optional(),
    }),
  }),
  async (req, res) => {
    res.json({ doctor: await staffService.updateDoctorProfile(actor(req, res), res.locals.valid.params.id, res.locals.valid.body) });
  },
);
