import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** Shared Redis client: slot holds, OTP rate limits, live queue. */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  // Back off up to 10s between reconnects instead of hammering a missing server.
  retryStrategy: (times) => Math.min(times * 500, 10_000),
});

// Log connection problems once per outage, not on every retry.
let lastError = '';
redis.on('error', (err: NodeJS.ErrnoException & { errors?: Error[] }) => {
  const msg = err.message || err.code || err.errors?.[0]?.message || 'connection error';
  if (msg !== lastError && env.NODE_ENV !== 'test') console.error(`[redis] ${msg} (${env.REDIS_URL})`);
  lastError = msg;
});
redis.on('ready', () => {
  if (lastError && env.NODE_ENV !== 'test') console.log('[redis] connected');
  lastError = '';
});

export async function connectRedis() {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
}
