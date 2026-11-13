import { Router } from 'express';

/** HTTP routes for the billing module, mounted at /api/billing. Every route must check the user's role. */
export const billingRouter: Router = Router();
