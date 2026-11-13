import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';

/** HTTP routes for the accounts module, mounted at /api/accounts. Every route checks the user's role/permissions. */
export const accountsRouter: Router = Router();

accountsRouter.use(requireAuth);

/** Placeholder home for the role that owns this module (filled in when the accounts module is built). */
accountsRouter.get('/dashboard', requirePermission('accounts:read'), (_req, res) => {
  res.json({ module: 'accounts', title: 'Accounts dashboard', placeholder: true });
});
