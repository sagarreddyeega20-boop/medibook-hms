export { authService } from './auth.service.js';
export { authRouter } from './auth.routes.js';
export { getSession, requireAnyPermission, requireAuth, requirePermission, requireRole } from './auth.middleware.js';
export { PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type StaffRole } from './permissions.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const authTables = ["users","roles","user_roles","permissions","role_permissions","otp_requests","access_overrides"] as const;
