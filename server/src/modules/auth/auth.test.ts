import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { tokenKey } from '../../lib/password.js';
import {
  auditCount, captureNotifications, cleanupFixtures, createAllRoles, createStaff, loginStaff, resetOtp,
  sessionCookie, setupInfra, tag, trackUser, TEST_PASSWORD, type Fixture,
} from '../../test/helpers.js';
import type { StaffRole } from './permissions.js';

const app = createApp();
let notes: ReturnType<typeof captureNotifications>;
let users: Record<StaffRole, Fixture>;
const since = new Date();

beforeAll(async () => {
  await setupInfra();
  notes = captureNotifications();
  users = await createAllRoles();
});
afterEach(() => notes.spy.mockClear());
afterAll(async () => {
  await cleanupFixtures();
  vi.restoreAllMocks();
});

/** Each role's own API (placeholder homes + the admin console). */
const ROLE_API: Record<StaffRole, string> = {
  SUPER_ADMIN: '/api/staff',
  ADMIN: '/api/audit',
  RECEPTIONIST: '/api/reception/board',
  DOCTOR: '/api/visits/dashboard',
  LAB_TECH: '/api/orders/lab/dashboard',
  RADIOLOGY_TECH: '/api/orders/radiology/dashboard',
  PHARMACIST: '/api/pharmacy/dashboard',
  ACCOUNTS: '/api/accounts/dashboard',
};
const ADMIN_ROLES: StaffRole[] = ['SUPER_ADMIN', 'ADMIN'];

describe('staff login: staff ID + password → email OTP → session', () => {
  it('every role can log in, gets its role in /me, and a 15-minute idle session', async () => {
    for (const role of Object.keys(users) as StaffRole[]) {
      const { cookie, body } = await loginStaff(app, notes, users[role]);
      expect(body.user).toMatchObject({ role, kind: 'STAFF', staffCode: users[role].staffCode });
      expect(body.idleTimeoutSeconds).toBe(15 * 60);

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
      expect(me.body.user.role).toBe(role);

      const ttl = await redis.ttl(`sess:${tokenKey(cookie.split('=')[1]!)}`);
      expect(ttl).toBeGreaterThan(890);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });

  it('sets an httpOnly, secure, SameSite=Strict cookie', async () => {
    await resetOtp(`u:${users.DOCTOR.userId}`);
    const s1 = await request(app).post('/api/auth/staff/login').send({ staffId: users.DOCTOR.staffCode, password: TEST_PASSWORD });
    const v = await request(app).post('/api/auth/otp/verify').send({ challengeId: s1.body.challengeId, code: notes.lastOtp(users.DOCTOR.email) });
    const raw = (v.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('mb_sid='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Strict/);
  });

  it('staff IDs are case-insensitive and the password step masks the email', async () => {
    await resetOtp(`u:${users.LAB_TECH.userId}`);
    const r = await request(app).post('/api/auth/staff/login').send({ staffId: users.LAB_TECH.staffCode.toLowerCase(), password: TEST_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.sentTo).toContain('•');
    expect(r.body.sentTo).not.toBe(users.LAB_TECH.email);
  });

  it('wrong password and unknown staff ID give the same generic error', async () => {
    const a = await request(app).post('/api/auth/staff/login').send({ staffId: users.PHARMACIST.staffCode, password: 'wrong-password-1' });
    const b = await request(app).post('/api/auth/staff/login').send({ staffId: 'HMS-DOC-9999', password: 'wrong-password-1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(notes.countFor(users.PHARMACIST.email)).toBe(0); // no OTP before a correct password
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const f = await createStaff('RECEPTIONIST');
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: `wrong-password-${i}` });
      expect(r.status).toBe(401);
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: f.userId } });
    expect(user.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // The right password is refused while locked, with the same generic message.
    const r = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await auditCount('ACCOUNT_LOCKED', { actorId: f.userId, since })).toBe(1);
    expect(await auditCount('LOGIN_FAILED', { actorId: f.userId, since })).toBe(6);

    // After the lock period it works again.
    await prisma.user.update({ where: { id: f.userId }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const ok = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('a staff member whose invite is pending (no password yet) cannot log in', async () => {
    const f = await createStaff('ACCOUNTS', { password: null });
    const r = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    expect(r.status).toBe(401);
  });
});

describe('OTP limits through the API', () => {
  it('5 wrong codes → 429 OTP_LOCKED (audited); the right code is then refused', async () => {
    const f = await createStaff('DOCTOR');
    const s1 = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    const code = notes.lastOtp(f.email);
    const bad = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await request(app).post('/api/auth/otp/verify').send({ challengeId: s1.body.challengeId, code: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsRemaining: 5 - i } });
    }
    const locked = await request(app).post('/api/auth/otp/verify').send({ challengeId: s1.body.challengeId, code: bad });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_LOCKED');
    expect(await auditCount('OTP_LOCKED', { actorId: f.userId, since })).toBe(1);
    expect(await auditCount('OTP_FAILED', { actorId: f.userId, since })).toBe(4);

    // Logging in again during the lock is refused before any code is sent.
    notes.spy.mockClear();
    const again = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('OTP_LOCKED');
    expect(notes.countFor(f.email)).toBe(0);
  });

  it('resend has a 60-second cooldown; a new code replaces the old one', async () => {
    const f = await createStaff('PHARMACIST');
    const s1 = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    expect(s1.body.resendInSeconds).toBe(60);
    expect(s1.body.expiresInSeconds).toBe(300);
    const first = notes.lastOtp(f.email);

    const tooSoon = await request(app).post('/api/auth/otp/resend').send({ challengeId: s1.body.challengeId });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('OTP_COOLDOWN');
    expect(tooSoon.body.error.details.retryAfterSeconds).toBeGreaterThan(50);

    await redis.del(`otp:u:${f.userId}:cooldown`); // simulate 60 s passing
    const resent = await request(app).post('/api/auth/otp/resend').send({ challengeId: s1.body.challengeId });
    expect(resent.status).toBe(200);
    const second = notes.lastOtp(f.email);
    expect(notes.countFor(f.email)).toBe(2);

    if (first !== second) {
      const old = await request(app).post('/api/auth/otp/verify').send({ challengeId: s1.body.challengeId, code: first });
      expect(old.status).toBe(400);
    }
    const ok = await request(app).post('/api/auth/otp/verify').send({ challengeId: s1.body.challengeId, code: second });
    expect(ok.status).toBe(200);
  });

  it('at most 5 codes per hour per account', async () => {
    const f = await createStaff('LAB_TECH');
    const s1 = await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD });
    for (let i = 0; i < 4; i++) {
      await redis.del(`otp:u:${f.userId}:cooldown`);
      expect((await request(app).post('/api/auth/otp/resend').send({ challengeId: s1.body.challengeId })).status).toBe(200);
    }
    await redis.del(`otp:u:${f.userId}:cooldown`);
    const sixth = await request(app).post('/api/auth/otp/resend').send({ challengeId: s1.body.challengeId });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('OTP_LIMIT');
    expect(notes.countFor(f.email)).toBe(5);
  });

  it('an unknown challenge is rejected', async () => {
    const r = await request(app).post('/api/auth/otp/verify').send({ challengeId: 'x'.repeat(43), code: '123456' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CHALLENGE_EXPIRED');
  });
});

describe('role-based access: requireAuth / requirePermission', () => {
  it('no session → 401 on protected routes', async () => {
    for (const path of [...Object.values(ROLE_API), '/api/auth/me', '/api/patients/me']) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(401);
    }
  });

  it("each role reaches its own API and gets 403 on every other role's API", async () => {
    for (const role of Object.keys(users) as StaffRole[]) {
      const { cookie } = await loginStaff(app, notes, users[role]);
      for (const [owner, path] of Object.entries(ROLE_API) as [StaffRole, string][]) {
        const r = await request(app).get(path).set('Cookie', cookie);
        const allowed = owner === role || (ADMIN_ROLES.includes(owner) && ADMIN_ROLES.includes(role));
        expect(r.status, `${role} → ${path}`).toBe(allowed ? 200 : 403);
      }
      expect((await request(app).get('/api/patients/me').set('Cookie', cookie)).status).toBe(403);
    }
    expect(await auditCount('ACCESS_DENIED', { actorId: users.DOCTOR.userId, since })).toBeGreaterThan(0);
  });

  it('logout ends the session', async () => {
    const { cookie } = await loginStaff(app, notes, users.ACCOUNTS);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('an idle-expired session is refused', async () => {
    const { cookie } = await loginStaff(app, notes, users.RADIOLOGY_TECH);
    await redis.del(`sess:${tokenKey(cookie.split('=')[1]!)}`); // what Redis does after 15 idle minutes
    const r = await request(app).get('/api/orders/radiology/dashboard').set('Cookie', cookie);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('Staff & roles (admin console)', () => {
  const newStaff = (role: string, departmentId: string) => ({ fullName: `New ${role} ${tag()}`, email: `t-new-${tag()}@test.medibook.local`, role, departmentId });

  it('admin creates staff → HMS-<ROLE>-NNNN ID, invite emailed, audited; invited user sets a password and logs in', async () => {
    const { cookie } = await loginStaff(app, notes, users.ADMIN);
    const options = await request(app).get('/api/staff/options').set('Cookie', cookie);
    expect(options.body.roles.map((r: { code: string }) => r.code)).not.toContain('ADMIN');
    const dept = options.body.departments.find((d: { code: string }) => d.code === 'CARD');

    const body = newStaff('DOCTOR', dept.id);
    const r = await request(app).post('/api/staff').set('Cookie', cookie).send(body);
    expect(r.status).toBe(201);
    const staff = r.body.staff;
    trackUser((await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })).userId);
    expect(staff.staffCode).toMatch(/^HMS-DOC-\d{4}$/);
    expect(staff).toMatchObject({ role: 'DOCTOR', status: 'INVITED', department: { code: 'CARD' } });
    expect(await auditCount('STAFF_CREATED', { actorId: users.ADMIN.userId, since })).toBeGreaterThan(0);

    // Set-password link: 24 h, min 10 chars, single use.
    const token = notes.lastInviteToken(body.email);
    expect(await redis.ttl(`setpw:${tokenKey(token)}`)).toBeGreaterThan(24 * 3600 - 10);
    const info = await request(app).get('/api/auth/password/link').query({ token });
    expect(info.body).toMatchObject({ staffCode: staff.staffCode, minLength: 10 });
    expect((await request(app).post('/api/auth/password/set').send({ token, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/password/set').send({ token, password: 'A-good-password-1' })).status).toBe(200);
    expect((await request(app).post('/api/auth/password/set').send({ token, password: 'A-good-password-1' })).status).toBe(400);

    const userId = (await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })).userId;
    const hash = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash!;
    expect(hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    const login = await loginStaff(app, notes, { staffCode: staff.staffCode, email: body.email, userId }, 'A-good-password-1');
    expect(login.body.user.role).toBe('DOCTOR');
  });

  it('only a Super Admin can create Admins', async () => {
    const admin = await loginStaff(app, notes, users.ADMIN);
    const sup = await loginStaff(app, notes, users.SUPER_ADMIN);
    const dept = await prisma.department.findFirstOrThrow({ where: { code: 'ADMIN' } });

    const denied = await request(app).post('/api/staff').set('Cookie', admin.cookie).send(newStaff('ADMIN', dept.id));
    expect(denied.status).toBe(403);
    const superAdmin = await request(app).post('/api/staff').set('Cookie', admin.cookie).send(newStaff('SUPER_ADMIN', dept.id));
    expect(superAdmin.status).toBe(403);

    const ok = await request(app).post('/api/staff').set('Cookie', sup.cookie).send(newStaff('ADMIN', dept.id));
    expect(ok.status).toBe(201);
    expect(ok.body.staff.staffCode).toMatch(/^HMS-ADM-\d{4}$/);
    trackUser((await prisma.staff.findUniqueOrThrow({ where: { id: ok.body.staff.id } })).userId);

    // An Admin cannot deactivate or re-role another Admin.
    expect((await request(app).post(`/api/staff/${ok.body.staff.id}/deactivate`).set('Cookie', admin.cookie)).status).toBe(403);
    expect((await request(app).patch(`/api/staff/${ok.body.staff.id}/role`).set('Cookie', admin.cookie).send({ role: 'DOCTOR' })).status).toBe(403);
  });

  it('non-admin roles cannot create staff', async () => {
    const { cookie } = await loginStaff(app, notes, users.RECEPTIONIST);
    const dept = await prisma.department.findFirstOrThrow({ where: { code: 'ADMIN' } });
    expect((await request(app).post('/api/staff').set('Cookie', cookie).send(newStaff('DOCTOR', dept.id))).status).toBe(403);
  });

  it('role change is audited and ends the user’s sessions; deactivation blocks login (never deletes)', async () => {
    const admin = await loginStaff(app, notes, users.ADMIN);
    const f = await createStaff('LAB_TECH');
    const theirs = await loginStaff(app, notes, f);

    const changed = await request(app).patch(`/api/staff/${f.staffId}/role`).set('Cookie', admin.cookie).send({ role: 'RADIOLOGY_TECH' });
    expect(changed.status).toBe(200);
    expect(changed.body.staff.role).toBe('RADIOLOGY_TECH');
    expect(await auditCount('ROLE_CHANGED', { actorId: users.ADMIN.userId, since })).toBeGreaterThan(0);
    expect((await request(app).get('/api/auth/me').set('Cookie', theirs.cookie)).status).toBe(401);

    const again = await loginStaff(app, notes, f);
    expect(again.body.user.role).toBe('RADIOLOGY_TECH');
    expect((await request(app).get('/api/orders/radiology/dashboard').set('Cookie', again.cookie)).status).toBe(200);
    expect((await request(app).get('/api/orders/lab/dashboard').set('Cookie', again.cookie)).status).toBe(403);

    const off = await request(app).post(`/api/staff/${f.staffId}/deactivate`).set('Cookie', admin.cookie);
    expect(off.body.staff.status).toBe('DEACTIVATED');
    expect(await auditCount('STAFF_DEACTIVATED', { actorId: users.ADMIN.userId, since })).toBeGreaterThan(0);
    expect((await request(app).get('/api/auth/me').set('Cookie', again.cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/staff/login').send({ staffId: f.staffCode, password: TEST_PASSWORD })).status).toBe(401);
    expect(await prisma.staff.findUnique({ where: { id: f.staffId } })).not.toBeNull();
  });

  it('admins cannot change their own role or deactivate themselves', async () => {
    const { cookie } = await loginStaff(app, notes, users.SUPER_ADMIN);
    expect((await request(app).post(`/api/staff/${users.SUPER_ADMIN.staffId}/deactivate`).set('Cookie', cookie)).status).toBe(403);
  });
});

describe('patients: email → OTP; self-registration with MRN', () => {
  it('responses are identical for known and unknown emails; only real accounts get an email', async () => {
    const patientEmail = 'patient@medibook.local';
    await resetOtp(`e:${tokenKey(patientEmail)}`);
    const unknownEmail = `nobody-${tag()}@test.medibook.local`;
    const a = await request(app).post('/api/auth/patient/otp').send({ email: patientEmail });
    const b = await request(app).post('/api/auth/patient/otp').send({ email: unknownEmail });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const strip = (x: Record<string, unknown>) => ({ ...x, challengeId: '', sentTo: '' });
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(notes.countFor(patientEmail)).toBe(1);
    expect(notes.countFor(unknownEmail)).toBe(0);
    await resetOtp(`e:${tokenKey(unknownEmail)}`);
  });

  it('registration creates the patient only after the email is verified; MRN is MB-YYYY-NNNNNN; 30-minute session', async () => {
    const email = `t-pat-${tag()}@test.medibook.local`;
    const reg = await request(app).post('/api/auth/patient/register').send({
      fullName: 'Priya Sharma', gender: 'FEMALE', dateOfBirth: '1990-05-17', email, phone: '+91 98450 14410',
    });
    expect(reg.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    const v = await request(app).post('/api/auth/otp/verify').send({ challengeId: reg.body.challengeId, code: notes.lastOtp(email) });
    expect(v.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    trackUser(user.id);
    expect(v.body.newlyRegistered).toBe(true);
    expect(v.body.user).toMatchObject({ role: 'PATIENT', kind: 'PATIENT', name: 'Priya Sharma' });
    expect(v.body.user.mrn).toMatch(new RegExp(`^MB-${new Date().getUTCFullYear()}-\\d{6}$`));
    expect(v.body.idleTimeoutSeconds).toBe(30 * 60);
    expect(await auditCount('PATIENT_REGISTERED', { actorId: user.id, since })).toBe(1);
    expect(await auditCount('LOGIN_SUCCESS', { actorId: user.id, since })).toBe(1);

    const cookie = sessionCookie(v);
    const me = await request(app).get('/api/patients/me').set('Cookie', cookie);
    expect(me.body.patient.mrn).toBe(v.body.user.mrn);
    for (const path of Object.values(ROLE_API)) {
      expect((await request(app).get(path).set('Cookie', cookie)).status, path).toBe(403);
    }
    await resetOtp(`e:${tokenKey(email)}`);
  });

  it('validates registration fields', async () => {
    const r = await request(app).post('/api/auth/patient/register').send({ fullName: 'X', gender: 'NA', dateOfBirth: '2999-01-01', email: 'bad', phone: '12' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});
