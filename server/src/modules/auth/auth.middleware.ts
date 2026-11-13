import type { RoleCode } from '@prisma/client';
import type { Request, RequestHandler, Response } from 'express';
import { readCookie } from '../../lib/cookies.js';
import { AppError } from '../../lib/errors.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { Permission } from './permissions.js';
import { cookieOptions, SESSION_COOKIE, sessionService, type SessionData } from './session.service.js';

/**
 * Route guards. Every protected route chains them:
 *   router.get('/x', requireAuth, requirePermission('staff:read'), handler)
 * requireRole / requirePermission include requireAuth, so they can also be used alone.
 */

export const clientIp = (req: Request) => req.ip ?? null;

/** The session attached by requireAuth. */
export function getSession(res: Response): SessionData {
  const s = res.locals.session as SessionData | undefined;
  if (!s) throw AppError.unauthorized();
  return s;
}

export const getSessionToken = (res: Response): string => res.locals.sessionToken as string;

export const requireAuth: RequestHandler = async (req, res, next) => {
  if (res.locals.session) return next();
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? await sessionService.touch(token) : null;
  if (!session) {
    if (token) res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw new AppError(401, token ? 'SESSION_EXPIRED' : 'UNAUTHORIZED', token ? 'Your session has expired. Please sign in again.' : 'Authentication required');
  }
  res.locals.session = session;
  res.locals.sessionToken = token;
  next();
};

async function deny(req: Request, session: SessionData, need: Record<string, unknown>): Promise<never> {
  await auditService.recordSafe({
    actorId: session.userId, action: AuditAction.ACCESS_DENIED, entity: 'routes', entityId: `${req.method} ${req.baseUrl}${req.path}`.slice(0, 200),
    ip: clientIp(req), metadata: { role: session.role, ...need } as never,
  });
  throw AppError.forbidden();
}

const chain = (check: (session: SessionData, req: Request) => Promise<void>): RequestHandler => async (req, res, next) => {
  await requireAuth(req, res, () => undefined);
  await check(getSession(res), req);
  next();
};

/** Allows the listed roles only. */
export const requireRole = (...roles: RoleCode[]): RequestHandler =>
  chain(async (s, req) => {
    if (!roles.includes(s.role)) await deny(req, s, { needRole: roles });
  });

/** Requires every listed permission. */
export const requirePermission = (...permissions: Permission[]): RequestHandler =>
  chain(async (s, req) => {
    const missing = permissions.filter((p) => !s.permissions.includes(p));
    if (missing.length) await deny(req, s, { needPermission: missing });
  });

/** Requires at least one of the listed permissions. */
export const requireAnyPermission = (...permissions: Permission[]): RequestHandler =>
  chain(async (s, req) => {
    if (!permissions.some((p) => s.permissions.includes(p))) await deny(req, s, { needAnyPermission: permissions });
  });
