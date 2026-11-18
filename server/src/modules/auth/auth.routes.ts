import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { noBody, validate } from '../../lib/validate.js';
import { authLimits } from '../../lib/rateLimit.js';
import { clientIp, getSession, getSessionToken, ownDataOnly, requireAuth } from './auth.middleware.js';
import { authService } from './auth.service.js';
import { cookieOptions, SESSION_COOKIE } from './session.service.js';

/**
 * HTTP routes for the auth module, mounted at /api/auth.
 * The login/registration/set-password steps are public by nature; everything else uses requireAuth.
 */
export const authRouter: Router = Router();

const email = z.string().trim().toLowerCase().email().max(254);
const challengeId = z.string().min(20).max(100);

export const passwordRule = z
  .string()
  .min(env.PASSWORD_MIN_LENGTH, `Password must be at least ${env.PASSWORD_MIN_LENGTH} characters`)
  .max(128, 'Password must be at most 128 characters');

const today = () => new Date().toISOString().slice(0, 10);
export const RegisterBody = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(120),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(d)) && d <= today() && d >= '1900-01-01', 'Enter a valid date of birth'),
  email,
  phone: z.string().trim().regex(/^\+?[0-9 ]{10,16}$/, 'Enter a valid mobile number'),
});

/** Step 1 (staff): staff ID + password → OTP emailed. */
authRouter.post(
  '/staff/login',
  ...authLimits.login,
  validate({ body: z.object({ staffId: z.string().trim().min(1).max(40), password: z.string().min(1).max(128) }) }),
  async (req, res) => {
    res.json(await authService.staffLogin(res.locals.valid.body, { ip: clientIp(req) }));
  },
);

/** Step 1 (patient): email → OTP emailed (same response whether or not the account exists). */
authRouter.post('/patient/otp', ...authLimits.login, validate({ body: z.object({ email }) }), async (_req, res) => {
  res.json(await authService.patientRequestOtp(res.locals.valid.body));
});

/** Patient self-registration: details → OTP; the account is created when the code is verified. */
authRouter.post('/patient/register', ...authLimits.login, validate({ body: RegisterBody }), async (_req, res) => {
  res.json(await authService.patientRegister(res.locals.valid.body));
});

/** Step 2: resend the code (60 s cooldown, max 5 per hour). */
authRouter.post('/otp/resend', ...authLimits.otp, validate({ body: z.object({ challengeId }) }), async (_req, res) => {
  res.json(await authService.resendOtp(res.locals.valid.body.challengeId));
});

/** Step 2: verify the code → session cookie. */
authRouter.post(
  '/otp/verify',
  ...authLimits.otp,
  validate({ body: z.object({ challengeId, code: z.string().trim().regex(/^\d{4,8}$/, 'Enter the code from the email') }) }),
  async (req, res) => {
    const { token, session, newlyRegistered } = await authService.verifyOtp(res.locals.valid.body, { ip: clientIp(req) });
    res.cookie(SESSION_COOKIE, token, cookieOptions());
    res.json({ ...authService.me(session), newlyRegistered });
  },
);

/** Set-password link from the staff invite email. */
authRouter.get('/password/link', ...authLimits.otp, validate({ query: z.object({ token: z.string().min(20).max(100) }) }), async (_req, res) => {
  const { staff } = await authService.checkSetPasswordToken(res.locals.valid.query.token);
  res.json({ name: staff.fullName, staffCode: staff.staffCode, minLength: env.PASSWORD_MIN_LENGTH });
});

authRouter.post(
  '/password/set',
  ...authLimits.otp,
  validate({ body: z.object({ token: z.string().min(20).max(100), password: passwordRule }) }),
  async (req, res) => {
    const { token, password } = res.locals.valid.body;
    res.json(await authService.setPassword(token, password, { ip: clientIp(req) }));
  },
);

/** Current user (also refreshes the idle timer). */
authRouter.get('/me', requireAuth, ownDataOnly, (_req, res) => {
  res.json(authService.me(getSession(res)));
});

authRouter.post('/logout', requireAuth, ownDataOnly, validate({ body: noBody }), async (req, res) => {
  await authService.logout(getSessionToken(res), getSession(res), { ip: clientIp(req) });
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});
