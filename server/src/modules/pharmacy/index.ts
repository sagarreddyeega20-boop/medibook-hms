export { pharmacyService } from './pharmacy.service.js';
export { pharmacyRouter } from './pharmacy.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const pharmacyTables = ["medicines","stock_movements","dispensations"] as const;
