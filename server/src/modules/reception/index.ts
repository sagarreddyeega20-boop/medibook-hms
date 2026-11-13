export { receptionService } from './reception.service.js';
export { receptionRouter } from './reception.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const receptionTables = ["queue_events"] as const;
