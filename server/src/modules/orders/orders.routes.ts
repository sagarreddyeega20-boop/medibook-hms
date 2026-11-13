import { Router } from 'express';
import { requireAuth, requirePermission } from '../auth/auth.middleware.js';

/** HTTP routes for the orders module, mounted at /api/orders. Every route checks the user's role/permissions. */
export const ordersRouter: Router = Router();

ordersRouter.use(requireAuth);

/** Placeholder home for the role that owns this module (filled in when the orders module is built). */
ordersRouter.get('/lab/dashboard', requirePermission('orders:lab'), (_req, res) => {
  res.json({ module: 'orders', title: 'Lab queue', placeholder: true });
});

/** Placeholder home for the role that owns this module (filled in when the orders module is built). */
ordersRouter.get('/radiology/dashboard', requirePermission('orders:radiology'), (_req, res) => {
  res.json({ module: 'orders', title: 'Radiology queue', placeholder: true });
});
