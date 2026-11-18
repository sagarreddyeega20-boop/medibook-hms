export { billingService } from './billing.service.js';
export { billingRouter } from './billing.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const billingTables = ["service_catalogue","charges","invoices","invoice_lines","payments","payment_allocations","refunds","cash_reconciliations"] as const;
