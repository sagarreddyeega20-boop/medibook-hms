import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEYLEN = 64;

/* ---------- Staff passwords: bcrypt (cost from BCRYPT_COST, default 12) ---------- */

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_COST);
}

// Compared against when the staff ID does not exist (or has no password yet),
// so response time doesn't reveal which staff IDs exist.
let dummyHash: string | undefined;

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !hash.startsWith('$2')) {
    dummyHash ??= await bcrypt.hash('not-a-real-password', env.BCRYPT_COST);
    await bcrypt.compare(password, dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/* ---------- Short-lived secrets (OTP codes): salted scrypt ---------- */

/** Format: scrypt$<saltHex>$<hashHex>. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(secret, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/* ---------- Random tokens (session IDs, login challenges, set-password links) ---------- */

/** 256-bit URL-safe random token. */
export const randomToken = () => randomBytes(32).toString('base64url');

/** Keyed hash used as the Redis key for a token or email, so a Redis dump never contains usable tokens. */
export const tokenKey = (token: string) => createHmac('sha256', env.JWT_SECRET).update(token).digest('hex');
