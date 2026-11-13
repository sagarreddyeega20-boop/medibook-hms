import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redis } from '../../lib/redis.js';
import { setupInfra, tag } from '../../test/helpers.js';
import { createOtpStore, defaultOtpRules } from './otp.service.js';

/** OTP rules from docs/mvp-structure.md, tested against real Redis. */
const store = createOtpStore();
const accts: string[] = [];
const acct = () => {
  const a = `test:${tag()}`;
  accts.push(a);
  return a;
};
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeAll(setupInfra);
afterAll(async () => {
  for (const a of accts) await store.reset(a);
});

describe('OTP rules', () => {
  it('uses the documented limits', () => {
    expect(defaultOtpRules).toEqual({ length: 6, ttlSeconds: 300, maxAttempts: 5, lockSeconds: 900, cooldownSeconds: 60, maxPerHour: 5 });
  });

  it('issues a 6-digit code that is stored hashed with a 5-minute expiry', async () => {
    const a = acct();
    const r = await store.issue(a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.expiresInSeconds).toBe(300);

    const stored = await redis.get(`otp:${a}:code`);
    expect(stored).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(stored).not.toContain(r.code!);
    const ttl = await redis.ttl(`otp:${a}:code`);
    expect(ttl).toBeGreaterThan(295);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('accepts the right code once (single use)', async () => {
    const a = acct();
    const r = await store.issue(a);
    if (!r.ok) throw new Error('issue failed');
    expect(await store.verify(a, r.code!)).toEqual({ ok: true });
    expect((await store.verify(a, r.code!)).ok).toBe(false);
  });

  it('rejects an expired code', async () => {
    const quick = createOtpStore(undefined, { ...defaultOtpRules, ttlSeconds: 1 });
    const a = acct();
    const r = await quick.issue(a);
    if (!r.ok) throw new Error('issue failed');
    await new Promise((res) => setTimeout(res, 1200));
    expect(await quick.verify(a, r.code!)).toMatchObject({ ok: false, reason: 'INVALID' });
  });

  it('locks for 15 minutes after 5 wrong attempts — even the right code is then refused', async () => {
    const a = acct();
    const r = await store.issue(a);
    if (!r.ok) throw new Error('issue failed');

    for (let i = 1; i <= 4; i++) {
      expect(await store.verify(a, wrong(r.code!))).toEqual({ ok: false, reason: 'INVALID', attemptsRemaining: 5 - i });
    }
    expect(await store.verify(a, wrong(r.code!))).toEqual({ ok: false, reason: 'LOCKED', retryAfterSeconds: 900, justLocked: true });

    const lockTtl = await redis.ttl(`otp:${a}:lock`);
    expect(lockTtl).toBeGreaterThan(895);
    expect(lockTtl).toBeLessThanOrEqual(900);

    expect(await store.verify(a, r.code!)).toMatchObject({ ok: false, reason: 'LOCKED', justLocked: false });
    expect(await store.issue(a)).toMatchObject({ ok: false, reason: 'LOCKED' });
  });

  it('lock expires after the lock period', async () => {
    const quick = createOtpStore(undefined, { ...defaultOtpRules, lockSeconds: 1, cooldownSeconds: 1 });
    const a = acct();
    for (let i = 0; i < 5; i++) await quick.verify(a, '000000');
    expect(await quick.issue(a)).toMatchObject({ ok: false, reason: 'LOCKED' });
    await new Promise((res) => setTimeout(res, 1200));
    expect(await quick.issue(a)).toMatchObject({ ok: true });
  });

  it('enforces the 60-second resend cooldown', async () => {
    const a = acct();
    expect((await store.issue(a)).ok).toBe(true);
    const again = await store.issue(a);
    expect(again).toMatchObject({ ok: false, reason: 'COOLDOWN' });
    if (!again.ok) {
      expect(again.retryAfterSeconds).toBeGreaterThan(55);
      expect(again.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    // A repeated login inside the cooldown reuses the code already sent instead of failing.
    expect(await store.issue(a, { reuseActive: true })).toMatchObject({ ok: true, code: null });
  });

  it('allows at most 5 codes per hour per account', async () => {
    const a = acct();
    for (let i = 0; i < 5; i++) {
      expect((await store.issue(a)).ok).toBe(true);
      await redis.del(`otp:${a}:cooldown`); // skip the 60 s wait between sends
    }
    const sixth = await store.issue(a);
    expect(sixth).toMatchObject({ ok: false, reason: 'HOURLY_LIMIT' });
    if (!sixth.ok) expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(await redis.ttl(`otp:${a}:hour`)).toBeGreaterThan(3500);
  });

  it('a wrong attempt on an expired / never-issued code still counts towards the lock', async () => {
    const a = acct();
    for (let i = 0; i < 4; i++) await store.verify(a, '123456');
    expect(await store.verify(a, '123456')).toMatchObject({ ok: false, reason: 'LOCKED', justLocked: true });
  });
});
