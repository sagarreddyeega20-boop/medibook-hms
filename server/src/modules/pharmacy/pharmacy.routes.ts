import { Router } from 'express';

/** HTTP routes for the pharmacy module, mounted at /api/pharmacy. Every route must check the user's role. */
export const pharmacyRouter: Router = Router();
