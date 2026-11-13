export { authService } from './auth.service.js';
export { authRouter } from './auth.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const authTables = ["users","roles","user_roles","permissions","role_permissions","otp_requests","access_overrides"] as const;
