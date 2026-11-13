export { staffService } from './staff.service.js';
export { staffRouter } from './staff.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const staffTables = ["staff","departments"] as const;
