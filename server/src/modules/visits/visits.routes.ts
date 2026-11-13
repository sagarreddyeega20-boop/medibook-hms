import { Router } from 'express';

/** HTTP routes for the visits module, mounted at /api/visits. Every route must check the user's role. */
export const visitsRouter: Router = Router();
