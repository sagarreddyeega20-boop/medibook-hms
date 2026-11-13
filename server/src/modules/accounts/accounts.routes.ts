import { Router } from 'express';

/** HTTP routes for the accounts module, mounted at /api/accounts. Every route must check the user's role. */
export const accountsRouter: Router = Router();
