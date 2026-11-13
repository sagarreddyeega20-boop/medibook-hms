import { Router } from 'express';

/** HTTP routes for the reception module, mounted at /api/reception. Every route must check the user's role. */
export const receptionRouter: Router = Router();
