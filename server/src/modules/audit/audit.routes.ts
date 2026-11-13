import { Router } from 'express';

/** HTTP routes for the audit module, mounted at /api/audit. Every route must check the user's role. */
export const auditRouter: Router = Router();
