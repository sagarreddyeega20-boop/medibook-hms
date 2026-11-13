import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';

/** HTTP routes for the visits module, mounted at /api/visits. Every route checks the user's role/permissions. */
export const visitsRouter: Router = Router();

visitsRouter.use(requireAuth);

/** Placeholder home for the role that owns this module (filled in when the visits module is built). */
visitsRouter.get('/dashboard', requirePermission('clinical:read'), (_req, res) => {
  res.json({ module: 'visits', title: 'Doctor dashboard', placeholder: true });
});
