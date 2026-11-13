import { Router } from 'express';

/** HTTP routes for the auth module, mounted at /api/auth. Every route must check the user's role. */
export const authRouter: Router = Router();
