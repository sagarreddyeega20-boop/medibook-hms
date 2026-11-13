import type { RoleCode } from '@prisma/client';
import type { CookieOptions } from 'express';
import { env } from '../../config/env.js';
import { randomToken, tokenKey } from '../../lib/password.js';
import { redis } from '../../lib/redis.js';

/**
 * Server-side sessions in Redis. The browser only holds a random ID in an httpOnly cookie;
 * Redis keys use a keyed hash of it. Idle timeout = key TTL, refreshed on every authenticated request.
 */
export const SESSION_COOKIE = 'mb_sid';

export interface SessionData {
  userId: string;
  kind: 'STAFF' | 'PATIENT';
  role: RoleCode;
  permissions: string[];
  name: string;
  staffCode?: string;
  mrn?: string;
  createdAt: number; // epoch ms
  idleSeconds: number;
}

const sessKey = (tk: string) => `sess:${tk}`;
const userKey = (userId: string) => `user-sess:${userId}`;
const maxAgeMs = () => env.SESSION_MAX_HOURS * 3600 * 1000;

export const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict',
  path: '/',
  maxAge: maxAgeMs(),
});

export const idleSecondsFor = (kind: SessionData['kind']) =>
  (kind === 'STAFF' ? env.SESSION_IDLE_MINUTES : env.PATIENT_SESSION_IDLE_MINUTES) * 60;

export const sessionService = {
  async create(data: Omit<SessionData, 'createdAt' | 'idleSeconds'>): Promise<{ token: string; session: SessionData }> {
    const token = randomToken();
    const tk = tokenKey(token);
    const session: SessionData = { ...data, createdAt: Date.now(), idleSeconds: idleSecondsFor(data.kind) };
    await redis
      .multi()
      .set(sessKey(tk), JSON.stringify(session), 'EX', session.idleSeconds)
      .sadd(userKey(data.userId), tk)
      .expire(userKey(data.userId), env.SESSION_MAX_HOURS * 3600)
      .exec();
    return { token, session };
  },

  /** Returns the session and slides its idle expiry, or null if missing/idle-expired/past max age. */
  async touch(token: string): Promise<SessionData | null> {
    const tk = tokenKey(token);
    const raw = await redis.get(sessKey(tk));
    if (!raw) return null;
    const session = JSON.parse(raw) as SessionData;
    if (Date.now() - session.createdAt > maxAgeMs()) {
      await redis.del(sessKey(tk));
      return null;
    }
    await redis.expire(sessKey(tk), session.idleSeconds);
    return session;
  },

  async destroy(token: string) {
    const tk = tokenKey(token);
    const raw = await redis.get(sessKey(tk));
    await redis.del(sessKey(tk));
    if (raw) await redis.srem(userKey((JSON.parse(raw) as SessionData).userId), tk);
  },

  /** Ends every session of a user (deactivation, role change, password set). */
  async revokeUser(userId: string) {
    const tks = await redis.smembers(userKey(userId));
    if (tks.length) await redis.del(...tks.map(sessKey));
    await redis.del(userKey(userId));
  },
};
