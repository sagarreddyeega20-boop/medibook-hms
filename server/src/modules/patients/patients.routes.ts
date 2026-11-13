import { Router } from 'express';

/** HTTP routes for the patients module, mounted at /api/patients. Every route must check the user's role. */
export const patientsRouter: Router = Router();
