import type { Router } from 'express';
import { authRouter } from './auth/index.js';
import { staffRouter } from './staff/index.js';
import { patientsRouter } from './patients/index.js';
import { schedulingRouter } from './scheduling/index.js';
import { receptionRouter } from './reception/index.js';
import { visitsRouter } from './visits/index.js';
import { ordersRouter } from './orders/index.js';
import { pharmacyRouter } from './pharmacy/index.js';
import { billingRouter } from './billing/index.js';
import { accountsRouter } from './accounts/index.js';
import { auditRouter } from './audit/index.js';
import { notificationsRouter } from './notifications/index.js';

/** Every module router, mounted at /api/<name>. */
export const moduleRouters: Record<string, Router> = {
  auth: authRouter,
  staff: staffRouter,
  patients: patientsRouter,
  scheduling: schedulingRouter,
  reception: receptionRouter,
  visits: visitsRouter,
  orders: ordersRouter,
  pharmacy: pharmacyRouter,
  billing: billingRouter,
  accounts: accountsRouter,
  audit: auditRouter,
  notifications: notificationsRouter,
};
