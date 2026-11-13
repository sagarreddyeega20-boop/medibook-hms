import { randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { redis as sharedRedis } from '../../lib/redis.js';
import { hashSecret, verifySecret } from '../../lib/password.js';

/**
 * One-time codes in Redis (docs/mvp-structure.md, "Login and OTP rules"):
 * 6 digits, stored hashed, 5-minute expiry, 5 wrong attempts → 15-minute lock,
 * 60-second resend cooldown, at most 5 codes per hour per account.
 *
 * `acct` identifies the account the limits apply to (e.g. "u:<userId>" for staff,
 * "e:<hashed email>" for patients). Unknown patient emails get the exact same
 * treatment, so responses never reveal whether an account exists.
 *
 * Keys: otp:<acct>:code (hash) · :attempts · :lock · :cooldown · :hour
 */
export interface OtpRules {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  lockSeconds: number;
  cooldownSeconds: number;
  maxPerHour: number;
}

export const defaultOtpRules: OtpRules = {
  length: env.OTP_LENGTH,
  ttlSeconds: env.OTP_TTL_SECONDS,
  maxAttempts: env.OTP_MAX_ATTEMPTS,
  lockSeconds: env.OTP_LOCK_MINUTES * 60,
  cooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
  maxPerHour: env.OTP_MAX_PER_HOUR,
};

export type IssueResult =
  | { ok: true; code: string | null; expiresInSeconds: number; resendInSeconds: number }
  | { ok: false; reason: 'LOCKED' | 'COOLDOWN' | 'HOURLY_LIMIT'; retryAfterSeconds: number };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID'; attemptsRemaining: number }
  | { ok: false; reason: 'LOCKED'; retryAfterSeconds: number; justLocked: boolean };

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export function createOtpStore(redis: Redis = sharedRedis, rules: OtpRules = defaultOtpRules) {
  const key = (acct: string, part: 'code' | 'attempts' | 'lock' | 'cooldown' | 'hour') => `otp:${acct}:${part}`;

  async function lockedFor(acct: string): Promise<number> {
    const ms = await redis.pttl(key(acct, 'lock'));
    return ms > 0 ? secs(ms) : 0;
  }

  /** Seconds the current code stays valid (0 if none). */
  async function activeCodeSeconds(acct: string): Promise<number> {
    const ms = await redis.pttl(key(acct, 'code'));
    return ms > 0 ? secs(ms) : 0;
  }

  return {
    rules,

    /**
     * Creates and stores a new code. With `reuseActive`, a request inside the cooldown (or over the
     * hourly limit) while a code is still valid returns `code: null` — the code already sent still works.
     */
    async issue(acct: string, opts: { reuseActive?: boolean } = {}): Promise<IssueResult> {
      const lock = await lockedFor(acct);
      if (lock) return { ok: false, reason: 'LOCKED', retryAfterSeconds: lock };

      const cooldownMs = await redis.pttl(key(acct, 'cooldown'));
      if (cooldownMs > 0) {
        const active = await activeCodeSeconds(acct);
        if (opts.reuseActive && active) return { ok: true, code: null, expiresInSeconds: active, resendInSeconds: secs(cooldownMs) };
        return { ok: false, reason: 'COOLDOWN', retryAfterSeconds: secs(cooldownMs) };
      }

      const hourKey = key(acct, 'hour');
      const count = await redis.incr(hourKey);
      if (count === 1) await redis.expire(hourKey, 3600);
      if (count > rules.maxPerHour) {
        const active = await activeCodeSeconds(acct);
        const windowLeft = await redis.ttl(hourKey);
        if (opts.reuseActive && active) return { ok: true, code: null, expiresInSeconds: active, resendInSeconds: Math.max(windowLeft, 1) };
        return { ok: false, reason: 'HOURLY_LIMIT', retryAfterSeconds: Math.max(windowLeft, 1) };
      }

      const code = randomInt(0, 10 ** rules.length).toString().padStart(rules.length, '0');
      await redis
        .multi()
        .set(key(acct, 'code'), await hashSecret(code), 'EX', rules.ttlSeconds)
        .set(key(acct, 'cooldown'), '1', 'EX', rules.cooldownSeconds)
        .exec();
      return { ok: true, code, expiresInSeconds: rules.ttlSeconds, resendInSeconds: rules.cooldownSeconds };
    },

    async verify(acct: string, code: string): Promise<VerifyResult> {
      const lock = await lockedFor(acct);
      if (lock) return { ok: false, reason: 'LOCKED', retryAfterSeconds: lock, justLocked: false };

      const stored = await redis.get(key(acct, 'code'));
      const wellFormed = new RegExp(`^\\d{${rules.length}}$`).test(code);
      if (stored && wellFormed && (await verifySecret(code, stored))) {
        await redis.del(key(acct, 'code'), key(acct, 'attempts')); // single use
        return { ok: true };
      }

      // Wrong, expired or missing code: count the attempt (window = lock length).
      const attemptsKey = key(acct, 'attempts');
      const attempts = await redis.incr(attemptsKey);
      if (attempts === 1) await redis.expire(attemptsKey, rules.lockSeconds);
      if (attempts >= rules.maxAttempts) {
        await redis
          .multi()
          .set(key(acct, 'lock'), '1', 'EX', rules.lockSeconds)
          .del(key(acct, 'code'), attemptsKey)
          .exec();
        return { ok: false, reason: 'LOCKED', retryAfterSeconds: rules.lockSeconds, justLocked: true };
      }
      return { ok: false, reason: 'INVALID', attemptsRemaining: rules.maxAttempts - attempts };
    },

    /** Removes all OTP state for an account (tests / admin unlock). */
    async reset(acct: string) {
      await redis.del(key(acct, 'code'), key(acct, 'attempts'), key(acct, 'lock'), key(acct, 'cooldown'), key(acct, 'hour'));
    },
  };
}

export type OtpStore = ReturnType<typeof createOtpStore>;
export const otpStore = createOtpStore();
