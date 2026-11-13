export { patientsService } from './patients.service.js';
export { patientsRouter } from './patients.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const patientsTables = ["patients","family_members","consents"] as const;
