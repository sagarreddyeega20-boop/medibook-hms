/**
 * Security pass, enforced:
 *  - every route is listed and must be protected (requireAuth + a role/permission guard), except an explicit
 *    list of public auth routes (which must be rate limited) and of own-data routes (checked in the handler);
 *  - every protected route answers 401 without a session;
 *  - every route parses its params and body with Zod;
 *  - helmet headers, CORS limited to the web origin, rate limiting, no static file serving, no secrets in code.
 * A new route that skips any of this fails here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { rateLimit } from './lib/rateLimit.js';
import { routeInventory } from './lib/routeInventory.js';
import { errorHandler } from './middleware/errorHandler.js';
import { moduleRouters } from './modules/index.js';
import { connectRedis } from './lib/redis.js';

const app = createApp();
const routes = routeInventory(moduleRouters);
const id = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

/** Public by nature: signing in, registering, setting a password from an emailed link. Each is rate limited. */
const PUBLIC = [
  'POST /api/auth/staff/login',
  'POST /api/auth/patient/otp',
  'POST /api/auth/patient/register',
  'POST /api/auth/otp/resend',
  'POST /api/auth/otp/verify',
  'GET /api/auth/password/link',
  'POST /api/auth/password/set',
];

/** Signed in; access is decided against the record itself inside the handler. */
const OWN_DATA = {
  'GET /api/auth/me': 'the caller’s own session',
  'POST /api/auth/logout': 'ends the caller’s own session',
  'GET /api/notifications': 'the caller’s own inbox (filtered by session user id)',
  'POST /api/notifications/:id/read': 'only marks the caller’s own notification',
  'GET /api/orders/results/:resultId/file': 'queue technician, treating clinician (care relationship / break-glass, audited) or the patient’s household; everyone else 403 + audit',
} as const;

beforeAll(async () => {
  await connectRedis();
});

describe('route inventory: every route is protected', () => {
  it('lists every API route (sanity)', () => {
    expect(routes.length).toBeGreaterThan(90);
    expect(new Set(routes.map(id)).size).toBe(routes.length);
  });

  it('the only routes without requireAuth are the public auth routes, and each is rate limited', () => {
    const open = routes.filter((r) => !r.guards.includes('auth'));
    expect(open.map(id).sort()).toEqual([...PUBLIC].sort());
    for (const r of open) expect(r.guards, id(r)).toContain('rateLimit');
  });

  it('every signed-in route also checks the role/permission (or is a listed own-data route)', () => {
    const unguarded = routes.filter((r) => r.guards.includes('auth') && !r.guards.some((g) => g === 'role' || g === 'permission' || g === 'own'));
    expect(unguarded.map(id)).toEqual([]);
    const own = routes.filter((r) => r.guards.includes('own')).map(id).sort();
    expect(own).toEqual(Object.keys(OWN_DATA).sort());
  });

  it('every route validates its path params and request body with Zod', () => {
    const missingParams = routes.filter((r) => r.path.includes(':') && !r.validates.params).map(id);
    const missingBody = routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && !r.validates.body).map(id);
    expect({ missingParams, missingBody }).toEqual({ missingParams: [], missingBody: [] });
  });

  it('every protected route answers 401 UNAUTHORIZED without a session', async () => {
    const failures: string[] = [];
    for (const r of routes.filter((x) => !PUBLIC.includes(id(x)))) {
      const url = r.path.replace(/:ref\b/, 'APT-000001').replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[r.method.toLowerCase() as 'get'](url).send({});
      if (res.status !== 401 || res.body?.error?.code !== 'UNAUTHORIZED') failures.push(`${id(r)} → ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('a forged or expired session cookie is refused', async () => {
    const res = await request(app).get('/api/reception/board').set('Cookie', 'mb_sid=forged-session-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('HTTP hardening', () => {
  it('helmet security headers are set and the framework is not advertised', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS allows only the web origin, with credentials', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app).options('/api/auth/staff/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('nothing is served statically: uploaded result files are reachable only through the guarded route', async () => {
    for (const path of ['/uploads/results/x.pdf', '/api/uploads/results/x.pdf', '/results/x.pdf']) {
      expect((await request(app).get(path)).status, path).toBe(404);
    }
    const stack = (app as unknown as { router: { stack: { name: string }[] } }).router.stack;
    expect(stack.some((l) => l.name === 'serveStatic')).toBe(false);
  });

  it('request bodies are size-limited', async () => {
    const big = { reason: 'x'.repeat(1_100_000) };
    const res = await request(app).post('/api/auth/staff/login').send(big);
    expect(res.status).toBe(413);
  });
});

describe('rate limiting on login and OTP', () => {
  const r = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
  const name = `test-${Date.now()}`;
  afterAll(async () => {
    const keys = await r.keys(`rl:${name}*`);
    if (keys.length) await r.del(...keys);
    await r.quit();
  });

  it('allows `max` requests per window, then 429 RATE_LIMITED with Retry-After; identifiers are counted separately', async () => {
    await r.connect();
    const mini = express();
    mini.use(express.json());
    mini.post('/login', rateLimit({ name, max: 3, windowSeconds: 60, key: (req) => req.body?.staffId, redis: r }), (_req, res) => { res.json({ ok: true }); });
    mini.use(errorHandler);
    for (let i = 0; i < 3; i++) expect((await request(mini).post('/login').send({ staffId: 'HMS-DOC-0001' })).status).toBe(200);
    const blocked = await request(mini).post('/login').send({ staffId: 'HMS-DOC-0001' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(mini).post('/login').send({ staffId: 'HMS-DOC-0002' })).status).toBe(200);
  });

  it('the auth routes carry the limiter (per IP and per account on login / OTP request)', () => {
    const byId = new Map(routes.map((x) => [id(x), x]));
    expect(byId.get('POST /api/auth/staff/login')!.guards.filter((g) => g === 'rateLimit')).toHaveLength(2);
    expect(byId.get('POST /api/auth/patient/otp')!.guards.filter((g) => g === 'rateLimit')).toHaveLength(2);
    expect(byId.get('POST /api/auth/otp/verify')!.guards).toContain('rateLimit');
  });
});

describe('no secrets in code', () => {
  const root = resolve(__dirname, '../..');
  const tracked = execFileSync('git', ['ls-files'], { cwd: root }).toString().split('\n').filter((f) => f && !f.startsWith('docs/ui-reference/') && !f.endsWith('.png') && !f.endsWith('.pdf') && !f.endsWith('package-lock.json'));

  it('.env is git-ignored and not tracked', () => {
    expect(tracked).not.toContain('.env');
    expect(execFileSync('git', ['check-ignore', '.env'], { cwd: root }).toString().trim()).toBe('.env');
  });

  it('no tracked file contains a private key, a live API key or a value of the local .env secrets', () => {
    const envFile = join(root, '.env');
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    const secrets = existsSync(envFile)
      ? readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => l.match(/^(JWT_SECRET|SMTP_PASS|SEED_SUPERADMIN_PASSWORD|POSTGRES_PASSWORD)=(.+)$/)).filter((m): m is RegExpMatchArray => !!m)
          .map((m) => m[2]!.replace(/^"|"$/g, '')).filter((v) => v.length >= 8 && !example.includes(v))
      : [];
    const patterns = [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk_live_[0-9a-zA-Z]{10,}/, /\bxox[bp]-[0-9A-Za-z-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/];
    const hits: string[] = [];
    for (const f of tracked) {
      const text = readFileSync(join(root, f), 'utf8');
      for (const p of patterns) if (p.test(text)) hits.push(`${f}: ${p}`);
      for (const s of secrets) if (text.includes(s)) hits.push(`${f}: contains a value from .env`);
    }
    expect(hits).toEqual([]);
  });
});
