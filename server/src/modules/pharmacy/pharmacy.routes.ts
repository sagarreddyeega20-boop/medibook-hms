import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';

/** HTTP routes for the pharmacy module, mounted at /api/pharmacy. Every route checks the user's role/permissions. */
export const pharmacyRouter: Router = Router();

pharmacyRouter.use(requireAuth);

/** Placeholder home for the role that owns this module (filled in when the pharmacy module is built). */
pharmacyRouter.get('/dashboard', requirePermission('pharmacy:dispense'), (_req, res) => {
  res.json({ module: 'pharmacy', title: 'Pharmacy queue', placeholder: true });
});
