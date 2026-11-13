export { ordersService } from './orders.service.js';
export { ordersRouter } from './orders.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const ordersTables = ["orders","order_results","referrals","prescriptions","prescription_items"] as const;
