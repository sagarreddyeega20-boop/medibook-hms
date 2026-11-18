import { Router } from 'express';
import { z } from 'zod';
import { noBody, validate } from '../../lib/validate.js';
import { getSession, ownDataOnly, requireAuth } from '../auth/auth.middleware.js';
import { notificationsService } from './notifications.service.js';

/** HTTP routes for the notifications module, mounted at /api/notifications. Users only ever see their own in-app alerts. */
export const notificationsRouter: Router = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', ownDataOnly, validate({ query: z.object({ unread: z.enum(['true', 'false']).optional() }) }), async (_req, res) => {
  const s = getSession(res);
  res.json(await notificationsService.inbox(s.userId, { unreadOnly: res.locals.valid.query.unread === 'true' }));
});

notificationsRouter.post('/:id/read', ownDataOnly, validate({ params: z.object({ id: z.string().uuid() }), body: noBody }), async (_req, res) => {
  await notificationsService.markRead(getSession(res).userId, res.locals.valid.params.id);
  res.status(204).end();
});
