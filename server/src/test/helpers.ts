/**
 * Test helpers: fixture accounts for every role, OTP capture and cookie handling.
 * Tests run against the docker-compose Postgres + Redis (run `npm run db:migrate && npm run db:seed` first).
 */
import { randomBytes } from 'node:crypto';
import type { RoleCode } from '@prisma/client';
import request from 'supertest';
import { vi, type MockInstance } from 'vitest';
import type { Express } from 'express';
import { hashPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import { connectRedis, redis } from '../lib/redis.js';
import { STAFF_ROLES, type StaffRole } from '../modules/auth/permissions.js';
import { notificationsService } from '../modules/notifications/notifications.service.js';
import { nextStaffCode } from '../modules/staff/staff.service.js';

export const TEST_PASSWORD = 'Test-Password-2026';
export const tag = () => randomBytes(4).toString('hex');

export interface Fixture {
  role: StaffRole;
  userId: string;
  staffId: string;
  staffCode: string;
  email: string;
}

const created = { userIds: [] as string[] };

export async function setupInfra() {
  await connectRedis();
  const roles = await prisma.role.count();
  if (roles < 9) throw new Error('Roles are not seeded. Run `npm run db:seed` before the tests.');
}

/** Creates an active staff account with a known password, bypassing the invite email. */
export async function createStaff(role: StaffRole, opts: { password?: string | null } = {}): Promise<Fixture> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
  const dept = await prisma.department.findFirstOrThrow({ where: { code: 'ADMIN' } });
  const email = `t-${tag()}-${role.toLowerCase()}@test.medibook.local`;
  const passwordHash = opts.password === null ? null : await hashPassword(opts.password ?? TEST_PASSWORD);
  const staffCode = await nextStaffCode(role);
  const user = await prisma.user.create({
    data: {
      email, passwordHash,
      roles: { create: { roleId: roleRow.id } },
      staff: { create: { staffCode, fullName: `Test ${role}`, departmentId: dept.id } },
    },
    include: { staff: true },
  });
  created.userIds.push(user.id);
  return { role, userId: user.id, staffId: user.staff!.id, staffCode, email };
}

export async function createAllRoles(): Promise<Record<StaffRole, Fixture>> {
  const out = {} as Record<StaffRole, Fixture>;
  for (const r of STAFF_ROLES) out[r] = await createStaff(r);
  return out;
}

export function trackUser(userId: string) {
  created.userIds.push(userId);
}

export async function cleanupFixtures() {
  const ids = created.userIds.splice(0);
  if (!ids.length) return;
  for (const id of ids) {
    const keys = await redis.smembers(`user-sess:${id}`);
    if (keys.length) await redis.del(...keys.map((k) => `sess:${k}`));
    await redis.del(`user-sess:${id}`, `otp:u:${id}:code`, `otp:u:${id}:attempts`, `otp:u:${id}:lock`, `otp:u:${id}:cooldown`, `otp:u:${id}:hour`);
  }
  await prisma.staff.deleteMany({ where: { userId: { in: ids } } });
  await prisma.patient.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { createdById: { in: ids } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Captures notify() calls (no emails are sent or stored during tests). */
export function captureNotifications() {
  const spy = vi.spyOn(notificationsService, 'notify').mockResolvedValue([]) as MockInstance;
  return {
    spy,
    /** The most recent OTP sent to `email`. */
    lastOtp(email: string): string {
      const call = [...spy.mock.calls].reverse().find((c) => c[1] === 'otp' && (c[0] as { email: string }).email === email);
      if (!call) throw new Error(`No OTP was sent to ${email}`);
      return (call[2] as { code: string }).code;
    },
    lastInviteToken(email: string): string {
      const call = [...spy.mock.calls].reverse().find((c) => c[1] === 'staff-invite' && (c[0] as { email: string }).email === email);
      if (!call) throw new Error(`No invite was sent to ${email}`);
      return new URL((call[2] as { link: string }).link).searchParams.get('token')!;
    },
    countFor(email: string, template = 'otp') {
      return spy.mock.calls.filter((c) => c[1] === template && (c[0] as { email: string }).email === email).length;
    },
  };
}

export const sessionCookie = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((x) => x.startsWith('mb_sid='));
  if (!c) throw new Error('No session cookie set');
  return c.split(';')[0]!;
};

/** Full staff login: password → OTP → session cookie. */
export async function loginStaff(app: Express, notes: ReturnType<typeof captureNotifications>, f: Pick<Fixture, 'staffCode' | 'email' | 'userId'>, password = TEST_PASSWORD) {
  await resetOtp(`u:${f.userId}`);
  const step1 = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password });
  if (step1.status !== 200) throw new Error(`staff login failed: ${step1.status} ${JSON.stringify(step1.body)}`);
  const verify = await request(app).post('/api/auth/otp/verify').send({ challengeId: step1.body.challengeId, code: notes.lastOtp(f.email) });
  if (verify.status !== 200) throw new Error(`otp verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  return { cookie: sessionCookie(verify), body: verify.body };
}

export async function resetOtp(acct: string) {
  await redis.del(...(['code', 'attempts', 'lock', 'cooldown', 'hour'] as const).map((p) => `otp:${acct}:${p}`));
}

export async function auditCount(action: string, where: { actorId?: string | null; since: Date }) {
  return prisma.auditLog.count({ where: { action, actorId: where.actorId ?? undefined, createdAt: { gte: where.since } } });
}

export type { RoleCode };

/** A signed-in session without the OTP round-trip (for tests that are not about login). Returns the Cookie header value. */
export async function sessionCookieFor(userId: string, kind: 'STAFF' | 'PATIENT' = 'STAFF') {
  const { authService } = await import('../modules/auth/auth.service.js');
  const { sessionService, SESSION_COOKIE } = await import('../modules/auth/session.service.js');
  const access = await authService.loadAccess(userId);
  const { token } = await sessionService.create({ userId, kind, role: access.role!, permissions: access.permissions, name: 'Test' });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}
