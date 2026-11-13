export { notificationsService } from './notifications.service.js';
export { notificationsRouter } from './notifications.routes.js';

/** Tables owned by this module (see CLAUDE.md, rule 1). */
export const notificationsTables = ["notifications","settings"] as const;
