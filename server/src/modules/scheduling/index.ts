export { schedulingService } from './scheduling.service.js';
export { schedulingRouter } from './scheduling.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const schedulingTables = ["doctor_schedules","doctor_leaves","appointments"] as const;
