export { visitsService } from './visits.service.js';
export { visitsRouter } from './visits.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const visitsTables = ["visits","clinical_notes","vitals"] as const;
