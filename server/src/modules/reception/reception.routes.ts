import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';

/** HTTP routes for the reception module, mounted at /api/reception. Every route checks the user's role/permissions. */
export const receptionRouter: Router = Router();

receptionRouter.use(requireAuth);

/** Placeholder home for the role that owns this module (filled in when the reception module is built). */
receptionRouter.get('/dashboard', requirePermission('reception:read'), (_req, res) => {
  res.json({ module: 'reception', title: 'Reception live board', placeholder: true });
});
