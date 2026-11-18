export { paymentsService } from './payments.service.js';
export { paymentsRouter } from './payments.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const paymentsTables = ["online_payment_orders"] as const;
