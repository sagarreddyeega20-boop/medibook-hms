import type { Gender, Prisma, RoleCode } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, randomToken, tokenKey, verifyPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { displayName, patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';
import { otpStore, type IssueResult } from './otp.service.js';
import { STAFF_ROLES } from './permissions.js';
import { sessionService, type SessionData } from './session.service.js';

/**
 * Auth service — Staff ID + password + email OTP login, patient OTP login, sessions, roles & permissions.
 * Owns: users, roles, user_roles, permissions, role_permissions, otp_requests, access_overrides
 * Other modules must call this service, never these tables directly.
 */

/* ---------------- Generic messages (never reveal whether an account exists) ---------------- */
export const MSG = {
  badCredentials: 'Invalid staff ID or password. After repeated failures the account is locked for 15 minutes.',
  otpSent: 'If an account exists for this email, we’ve sent it a 6-digit code.',
  otpInvalid: 'That code is incorrect or has expired.',
  otpLocked: 'Too many incorrect codes. Please try again later.',
  otpCooldown: 'Please wait before requesting another code.',
  otpHourly: 'Too many codes requested. Please try again later.',
  challengeExpired: 'Your sign-in attempt expired. Please start again.',
  linkInvalid: 'This link is invalid or has expired. Ask your administrator for a new one.',
} as const;

/* ---------------- Login challenges (between step 1 and the OTP step) ---------------- */
interface PendingRegistration {
  fullName: string;
  gender: Gender;
  dateOfBirth: string; // YYYY-MM-DD
  phone: string;
}

interface Challenge {
  kind: 'STAFF' | 'PATIENT';
  acct: string; // OTP limits key
  email: string;
  userId: string | null; // null: unknown patient email (or a new registration)
  registration?: PendingRegistration;
}

const CHALLENGE_TTL = 15 * 60;
const challengeKey = (id: string) => `login-chal:${tokenKey(id)}`;

async function saveChallenge(c: Challenge) {
  const id = randomToken();
  await redis.set(challengeKey(id), JSON.stringify(c), 'EX', CHALLENGE_TTL);
  return id;
}

async function loadChallenge(id: string): Promise<Challenge> {
  const raw = await redis.get(challengeKey(id));
  if (!raw) throw new AppError(400, 'CHALLENGE_EXPIRED', MSG.challengeExpired);
  return JSON.parse(raw) as Challenge;
}

const normEmail = (e: string) => e.trim().toLowerCase();
const patientAcct = (email: string) => `e:${tokenKey(normEmail(email))}`;
const staffAcct = (userId: string) => `u:${userId}`;

export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};

function otpError(r: Extract<IssueResult, { ok: false }>): AppError {
  const message = r.reason === 'LOCKED' ? MSG.otpLocked : r.reason === 'COOLDOWN' ? MSG.otpCooldown : MSG.otpHourly;
  const code = r.reason === 'LOCKED' ? 'OTP_LOCKED' : r.reason === 'COOLDOWN' ? 'OTP_COOLDOWN' : 'OTP_LIMIT';
  return new AppError(429, code, message, { retryAfterSeconds: r.retryAfterSeconds });
}

/** Issues (or reuses) a code for the challenge and emails it. Unknown patient emails get no email. */
async function sendCode(c: Challenge, opts: { reuseActive: boolean; name?: string }) {
  const r = await otpStore.issue(c.acct, { reuseActive: opts.reuseActive });
  if (!r.ok) throw otpError(r);
  const shouldEmail = c.userId !== null || c.registration !== undefined;
  if (r.code && shouldEmail) {
    // Fire-and-forget so response time is the same whether or not an email is sent.
    void notificationsService
      .notify({ userId: c.userId, email: c.email }, 'otp', {
        name: opts.name,
        code: r.code,
        minutes: Math.round(otpStore.rules.ttlSeconds / 60),
        purpose: c.registration ? 'registration' : 'login',
      })
      .catch((err) => console.error('[otp] notify failed', err));
  }
  return { expiresInSeconds: r.expiresInSeconds, resendInSeconds: r.resendInSeconds };
}

/* ---------------- Roles & permissions ---------------- */
async function loadAccess(userId: string, tx: Prisma.TransactionClient = prisma) {
  const rows = await tx.userRole.findMany({
    where: { userId },
    select: { role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } },
  });
  const roles = rows.map((r) => r.role.code);
  const order: RoleCode[] = [...STAFF_ROLES, 'PATIENT'];
  const role = order.find((r) => roles.includes(r));
  const permissions = [...new Set(rows.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))].sort();
  return { role, roles, permissions };
}

/* ---------------- Set-password links ---------------- */
const setPwKey = (tk: string) => `setpw:${tk}`;
const setPwUserKey = (userId: string) => `setpw-user:${userId}`;

export interface AuthContext {
  ip?: string | null;
}

export const authService = {
  MSG,
  loadAccess,

  /* ======== Accounts (used by the staff module) ======== */

  async createUserAccount(input: { email: string; role: RoleCode; createdById?: string }, tx: Prisma.TransactionClient) {
    const role = await tx.role.findUniqueOrThrow({ where: { code: input.role } });
    return tx.user.create({
      data: { email: normEmail(input.email), createdById: input.createdById, roles: { create: { roleId: role.id } } },
      select: { id: true, email: true },
    });
  },

  emailInUse(email: string) {
    return prisma.user.findUnique({ where: { email: normEmail(email) }, select: { id: true } }).then(Boolean);
  },

  /** Replaces the user's roles with `role` and ends their sessions. */
  async setRole(userId: string, role: RoleCode, tx: Prisma.TransactionClient = prisma) {
    const r = await tx.role.findUniqueOrThrow({ where: { code: role } });
    await tx.userRole.deleteMany({ where: { userId } });
    await tx.userRole.create({ data: { userId, roleId: r.id } });
  },

  async disableUser(userId: string, tx: Prisma.TransactionClient = prisma) {
    await tx.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
  },

  revokeSessions: (userId: string) => sessionService.revokeUser(userId),

  /** For the staff list: role, whether a password is set, lock state. */
  async accountSummaries(userIds: string[]) {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true, email: true, status: true, lockedUntil: true, lastLoginAt: true,
        passwordHash: true, roles: { select: { role: { select: { code: true } } } },
      },
    });
    const now = new Date();
    return new Map(
      users.map((u) => [
        u.id,
        {
          email: u.email,
          role: u.roles[0]?.role.code ?? null,
          status: u.status,
          hasPassword: !!u.passwordHash,
          locked: !!u.lockedUntil && u.lockedUntil > now,
          lastLoginAt: u.lastLoginAt,
        },
      ]),
    );
  },

  /** Creates a 24h set-password link (invalidating any earlier one) and emails it. */
  async sendSetPasswordLink(user: { userId: string; email: string; name: string; staffCode: string; roleName: string }) {
    const token = randomToken();
    const tk = tokenKey(token);
    const ttl = env.SET_PASSWORD_LINK_HOURS * 3600;
    const previous = await redis.get(setPwUserKey(user.userId));
    const multi = redis.multi();
    if (previous) multi.del(setPwKey(previous));
    await multi.set(setPwKey(tk), user.userId, 'EX', ttl).set(setPwUserKey(user.userId), tk, 'EX', ttl).exec();
    const link = `${env.APP_URL.replace(/\/$/, '')}/set-password?token=${encodeURIComponent(token)}`;
    await notificationsService.notify({ userId: user.userId, email: user.email }, 'staff-invite', {
      name: user.name, staffCode: user.staffCode, role: user.roleName, link, hours: env.SET_PASSWORD_LINK_HOURS,
    });
    return { expiresInHours: env.SET_PASSWORD_LINK_HOURS };
  },

  async checkSetPasswordToken(token: string) {
    const userId = await redis.get(setPwKey(tokenKey(token)));
    if (!userId) throw new AppError(400, 'LINK_INVALID', MSG.linkInvalid);
    const staff = await staffService.profileByUserId(userId);
    if (!staff || !staff.isActive) throw new AppError(400, 'LINK_INVALID', MSG.linkInvalid);
    return { userId, staff };
  },

  async setPassword(token: string, password: string, ctx: AuthContext) {
    const { userId, staff } = await this.checkSetPasswordToken(token);
    const passwordHash = await hashPassword(password);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    await redis.del(setPwKey(tokenKey(token)), setPwUserKey(userId));
    await sessionService.revokeUser(userId);
    await auditService.recordSafe({ actorId: userId, action: AuditAction.PASSWORD_SET, entity: 'users', entityId: userId, ip: ctx.ip });
    return { staffCode: staff.staffCode };
  },

  /* ======== Staff login: staff ID + password → email OTP ======== */

  async staffLogin(input: { staffId: string; password: string }, ctx: AuthContext) {
    const staffCode = input.staffId.trim().toUpperCase();
    const staff = await staffService.findByStaffCode(staffCode);
    const user = staff ? await prisma.user.findUnique({ where: { id: staff.userId } }) : null;

    const fail = async (reason: string, actorId: string | null = null): Promise<never> => {
      await auditService.recordSafe({
        actorId, action: AuditAction.LOGIN_FAILED, entity: 'users', entityId: actorId, ip: ctx.ip,
        metadata: { staffId: staffCode.slice(0, 40), reason, step: 'password' },
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', MSG.badCredentials);
    };

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await verifyPassword(input.password, null); // same work as a real check
      return fail('LOCKED', user.id);
    }

    const ok = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !staff) return fail('UNKNOWN_STAFF_ID');

    if (!ok) {
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (updated.failedLoginCount >= env.PASSWORD_MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + env.PASSWORD_LOCK_MINUTES * 60_000);
        await prisma.user.update({ where: { id: user.id }, data: { lockedUntil, failedLoginCount: 0 } });
        await auditService.recordSafe({
          actorId: user.id, action: AuditAction.ACCOUNT_LOCKED, entity: 'users', entityId: user.id, ip: ctx.ip,
          metadata: { reason: 'TOO_MANY_PASSWORD_ATTEMPTS', lockedUntil: lockedUntil.toISOString() },
        });
        void notificationsService
          .notify({ userId: user.id, email: user.email }, 'account-locked', { name: staff.fullName, minutes: env.PASSWORD_LOCK_MINUTES })
          .catch(() => undefined);
      }
      return fail(user.passwordHash ? 'BAD_PASSWORD' : 'PASSWORD_NOT_SET', user.id);
    }
    if (user.status !== 'ACTIVE' || !staff.isActive) return fail('INACTIVE', user.id);

    if (user.failedLoginCount > 0) await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });

    const challenge: Challenge = { kind: 'STAFF', acct: staffAcct(user.id), email: user.email, userId: user.id };
    const timing = await sendCode(challenge, { reuseActive: true, name: staff.fullName });
    const challengeId = await saveChallenge(challenge);
    return { challengeId, sentTo: maskEmail(user.email), ...timing };
  },

  /* ======== Patient login / registration: email → OTP ======== */

  async patientRequestOtp(input: { email: string }) {
    const email = normEmail(input.email);
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true, roles: { select: { role: { select: { code: true } } } } } });
    const isPatient = !!user && user.status === 'ACTIVE' && user.roles.some((r) => r.role.code === 'PATIENT');
    const challenge: Challenge = { kind: 'PATIENT', acct: patientAcct(email), email, userId: isPatient ? user!.id : null };
    const timing = await sendCode(challenge, { reuseActive: true });
    const challengeId = await saveChallenge(challenge);
    return { challengeId, sentTo: email, message: MSG.otpSent, ...timing };
  },

  /**
   * Self-registration. Nothing is created until the email is verified with the OTP.
   * If the email already has an account, this behaves exactly like a login request (same response).
   */
  async patientRegister(input: PendingRegistration & { email: string }) {
    const email = normEmail(input.email);
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true, roles: { select: { role: { select: { code: true } } } } } });
    const isPatient = !!existing && existing.status === 'ACTIVE' && existing.roles.some((r) => r.role.code === 'PATIENT');
    const challenge: Challenge = {
      kind: 'PATIENT',
      acct: patientAcct(email),
      email,
      userId: isPatient ? existing!.id : null,
      // An email used by a staff account can't also be a patient login; treat like an unknown email.
      registration: existing ? undefined : { fullName: input.fullName.trim(), gender: input.gender, dateOfBirth: input.dateOfBirth, phone: input.phone.trim() },
    };
    const timing = await sendCode(challenge, { reuseActive: true, name: input.fullName.trim() });
    const challengeId = await saveChallenge(challenge);
    return { challengeId, sentTo: email, message: MSG.otpSent, ...timing };
  },

  /* ======== Shared OTP steps ======== */

  async resendOtp(challengeId: string) {
    const c = await loadChallenge(challengeId);
    const timing = await sendCode(c, { reuseActive: false });
    await redis.expire(challengeKey(challengeId), CHALLENGE_TTL);
    return { sentTo: c.kind === 'STAFF' ? maskEmail(c.email) : c.email, ...timing };
  },

  /** Verifies the code and opens a session. Returns the session token (for the cookie) and the session. */
  async verifyOtp(input: { challengeId: string; code: string }, ctx: AuthContext) {
    const c = await loadChallenge(input.challengeId);
    const result = await otpStore.verify(c.acct, input.code.trim());

    if (!result.ok) {
      const meta = { kind: c.kind, step: 'otp', ...(c.userId ? {} : { emailHash: c.acct }) };
      if (result.reason === 'LOCKED') {
        if (result.justLocked) {
          await auditService.recordSafe({ actorId: c.userId, action: AuditAction.OTP_LOCKED, entity: 'users', entityId: c.userId, ip: ctx.ip, metadata: meta });
        }
        await redis.del(challengeKey(input.challengeId));
        throw new AppError(429, 'OTP_LOCKED', MSG.otpLocked, { retryAfterSeconds: result.retryAfterSeconds });
      }
      await auditService.recordSafe({ actorId: c.userId, action: AuditAction.OTP_FAILED, entity: 'users', entityId: c.userId, ip: ctx.ip, metadata: { ...meta, attemptsRemaining: result.attemptsRemaining } });
      throw new AppError(400, 'OTP_INVALID', MSG.otpInvalid, { attemptsRemaining: result.attemptsRemaining });
    }

    await redis.del(challengeKey(input.challengeId));

    let userId = c.userId;
    let newlyRegistered = false;
    if (!userId && c.registration) {
      const reg = c.registration;
      const created = await prisma.$transaction(async (tx) => {
        const user = await authService.createUserAccount({ email: c.email, role: 'PATIENT' }, tx);
        const patient = await patientsService.register(
          { userId: user.id, fullName: reg.fullName, gender: reg.gender, dateOfBirth: new Date(`${reg.dateOfBirth}T00:00:00Z`), email: c.email, phone: reg.phone, source: 'ONLINE' },
          tx,
        );
        await auditService.record({ actorId: user.id, action: AuditAction.PATIENT_REGISTERED, entity: 'patients', entityId: patient.id, patientId: patient.id, ip: ctx.ip, metadata: { mrn: patient.mrn } }, tx);
        return user;
      });
      userId = created.id;
      newlyRegistered = true;
    }
    if (!userId) throw new AppError(400, 'OTP_INVALID', MSG.otpInvalid); // unknown email: nobody could have the code

    return this.openSession(userId, c.kind, ctx, { newlyRegistered });
  },

  async openSession(userId: string, kind: SessionData['kind'], ctx: AuthContext, extra: { newlyRegistered?: boolean } = {}) {
    const access = await loadAccess(userId);
    const fail = () => new AppError(401, 'INVALID_CREDENTIALS', kind === 'STAFF' ? MSG.badCredentials : MSG.otpInvalid);
    if (!access.role) throw fail();

    let name: string;
    let staffCode: string | undefined;
    let mrn: string | undefined;
    if (kind === 'STAFF') {
      const staff = await staffService.profileByUserId(userId);
      if (!staff || !staff.isActive || access.role === 'PATIENT') throw fail();
      name = staff.fullName;
      staffCode = staff.staffCode;
    } else {
      const patient = await patientsService.findByUserId(userId);
      if (!patient || access.role !== 'PATIENT') throw fail();
      name = displayName(patient);
      mrn = patient.mrn;
    }

    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), failedLoginCount: 0 } });
    const { token, session } = await sessionService.create({ userId, kind, role: access.role, permissions: access.permissions, name, staffCode, mrn });
    await auditService.recordSafe({
      actorId: userId, action: AuditAction.LOGIN_SUCCESS, entity: 'users', entityId: userId, ip: ctx.ip,
      metadata: { kind, role: access.role, ...(staffCode ? { staffCode } : { mrn }) },
    });
    return { token, session, newlyRegistered: extra.newlyRegistered ?? false };
  },

  async logout(token: string, session: SessionData, ctx: AuthContext) {
    await sessionService.destroy(token);
    await auditService.recordSafe({ actorId: session.userId, action: AuditAction.LOGOUT, entity: 'users', entityId: session.userId, ip: ctx.ip });
  },

  /** Public view of a session for the web app. */
  me(session: SessionData) {
    return {
      user: {
        id: session.userId,
        kind: session.kind,
        role: session.role,
        name: session.name,
        staffCode: session.staffCode ?? null,
        mrn: session.mrn ?? null,
        permissions: session.permissions,
      },
      idleTimeoutSeconds: session.idleSeconds,
    };
  },
};
