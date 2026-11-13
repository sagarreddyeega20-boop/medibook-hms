import { Router } from 'express';

/** HTTP routes for the scheduling module, mounted at /api/scheduling. Every route must check the user's role. */
export const schedulingRouter: Router = Router();
