import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import { getSession, requireAuth, requirePermission } from '../auth/auth.middleware.js';
import { patientsService } from './patients.service.js';

/** HTTP routes for the patients module, mounted at /api/patients. Every route checks the user's role/permissions. */
export const patientsRouter: Router = Router();

patientsRouter.use(requireAuth);

/** The signed-in patient's own profile (MRN etc.). */
patientsRouter.get('/me', requirePermission('self:read'), async (_req, res) => {
  const patient = await patientsService.findByUserId(getSession(res).userId);
  if (!patient) throw AppError.notFound('Patient record not found');
  res.json({ patient });
});
