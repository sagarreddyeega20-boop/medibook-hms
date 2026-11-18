import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { redis as sharedRedis } from './redis.js';
import { tokenKey } from './password.js';

/**
 * Fixed-window request limits in Redis, for the public auth endpoints (login, OTP request/verify/resend,
 * registration, set-password). These sit in front of the per-account OTP and password-lockout rules:
 * the account rules stop guessing one account, these stop one client hammering many.
 *
 *   rateLimit({ name: 'login', max: 20, windowSeconds: 900, key: (req) => req.body?.staffId })
 *
 * Keys: rl:<name>:<ip>[:<hashed identifier>]. Over the limit → 429 RATE_LIMITED with Retry-After.
 * If Redis is down the request is let through (the account lockouts, which also need Redis, fail closed).
 */
export interface RateLimitOptions {
  name: string;
  max: number;
  windowSeconds: number;
  /** Optional second dimension (e.g. the staff ID or email being tried), combined with the IP. */
  key?: (req: Request) => string | undefined | null;
  redis?: Redis;
}

export type TaggedHandler = RequestHandler & { guard?: string };

export function rateLimit(opts: RateLimitOptions): TaggedHandler {
  const store = opts.redis ?? sharedRedis;
  const handler: TaggedHandler = async (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const extra = opts.key?.(req);
    const id = typeof extra === 'string' && extra ? `:${tokenKey(extra.trim().toLowerCase()).slice(0, 24)}` : '';
    const key = `rl:${opts.name}:${ip}${id}`;
    let count: number;
    let ttl: number;
    try {
      [[, count], [, ttl]] = (await store.multi().incr(key).ttl(key).exec()) as [[null, number], [null, number]];
      if (ttl < 0) await store.expire(key, opts.windowSeconds);
    } catch {
      return next();
    }
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - count)));
    if (count > opts.max) {
      const retry = ttl > 0 ? ttl : opts.windowSeconds;
      res.setHeader('Retry-After', String(retry));
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.', { retryAfterSeconds: retry });
    }
    next();
  };
  handler.guard = 'rateLimit';
  return handler;
}

/** Limits for the auth endpoints (env-tunable; see .env.example). */
const window = env.RATE_LIMIT_WINDOW_MINUTES * 60;
export const authLimits = {
  /** Staff ID + password, patient OTP request, registration: per IP, and per IP + identifier. */
  login: [
    rateLimit({ name: 'login-ip', max: env.RATE_LIMIT_LOGIN_PER_IP, windowSeconds: window }),
    rateLimit({ name: 'login-id', max: env.RATE_LIMIT_LOGIN_PER_ACCOUNT, windowSeconds: window, key: (req) => req.body?.staffId ?? req.body?.email }),
  ],
  /** OTP verify / resend, set-password: per IP (each challenge also has its own attempt lock). */
  otp: [rateLimit({ name: 'otp-ip', max: env.RATE_LIMIT_OTP_PER_IP, windowSeconds: window })],
};
