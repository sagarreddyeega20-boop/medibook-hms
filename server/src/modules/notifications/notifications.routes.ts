import { Router } from 'express';

/** HTTP routes for the notifications module, mounted at /api/notifications. Every route must check the user's role. */
export const notificationsRouter: Router = Router();
