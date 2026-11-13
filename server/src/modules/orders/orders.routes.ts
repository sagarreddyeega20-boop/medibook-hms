import { Router } from 'express';

/** HTTP routes for the orders module, mounted at /api/orders. Every route must check the user's role. */
export const ordersRouter: Router = Router();
