/**
 * Billing service — Service catalogue, charges, one invoice per visit, counter payments, allocations, refunds.
 * Owns: service_catalogue, charges, invoices, invoice_lines, payments, payment_allocations, refunds
 * Other modules must call this service, never these tables directly.
 */
export const billingService = {
  // Business logic for this module is added in later steps.
};
