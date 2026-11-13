export { auditService } from './audit.service.js';
export { auditRouter } from './audit.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const auditTables = ["audit_logs"] as const;
