import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { formatPaise, rupeesToPaise } from './lib/money.js';

const app = createApp();

describe('API foundation', () => {
  it('GET /api/health reports status and services', async () => {
    const res = await request(app).get('/api/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body.services).toHaveProperty('database');
    expect(res.body.services).toHaveProperty('redis');
  });

  it('unknown routes return the standard error shape', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('malformed JSON returns BAD_JSON', async () => {
    const res = await request(app).post('/api/patients').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_JSON');
  });
});

describe('money helpers', () => {
  it('stores rupees as integer paise', () => {
    expect(rupeesToPaise(499.99)).toBe(49999);
    expect(formatPaise(49999)).toContain('499.99');
  });
});
