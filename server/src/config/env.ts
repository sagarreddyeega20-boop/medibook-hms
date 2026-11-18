import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6380'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  /** Public URL of the web app, used in emailed links (set-password). */
  APP_URL: z.string().url().default('http://localhost:5173'),

  // Sessions (Redis-backed, httpOnly cookie)
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(15), // staff
  PATIENT_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_MAX_HOURS: z.coerce.number().int().positive().default(12), // absolute lifetime
  COOKIE_SECURE: bool.default(true), // browsers treat http://localhost as secure, so true works in dev

  // Staff passwords
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().default(10),
  PASSWORD_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  PASSWORD_LOCK_MINUTES: z.coerce.number().int().default(15),
  SET_PASSWORD_LINK_HOURS: z.coerce.number().int().default(24),

  OTP_LENGTH: z.coerce.number().int().default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  OTP_LOCK_MINUTES: z.coerce.number().int().default(15),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().default(60),
  OTP_MAX_PER_HOUR: z.coerce.number().int().default(5),
  SLOT_HOLD_SECONDS: z.coerce.number().int().default(600),

  // Request limits on the public auth endpoints (per client IP, fixed window)
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_LOGIN_PER_IP: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_LOGIN_PER_ACCOUNT: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_PER_IP: z.coerce.number().int().positive().default(60),

  /** Result attachments (relative to /server). Never served statically. */
  UPLOAD_DIR: z.string().default('uploads'),

  /** smtp = send through Nodemailer; console = print emails to the server log. Unset → smtp when SMTP_USER + SMTP_PASS are set. */
  MAIL_TRANSPORT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['smtp', 'console']).optional()),
  SMTP_HOST: z.string().optional().transform((v) => v || 'smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().default(465),
  /** Unset → true for port 465 (implicit TLS), false otherwise (STARTTLS). */
  SMTP_SECURE: z.preprocess((v) => (v === '' ? undefined : v), bool.optional()),
  SMTP_USER: z.string().optional().default(''),
  // Gmail shows App Passwords as "abcd efgh ijkl mnop"; the spaces are not part of the password.
  SMTP_PASS: z.string().optional().default('').transform((v) => v.replace(/\s+/g, '')),
  MAIL_FROM: z.string().default('MediBook HMS <no-reply@medibook.local>'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const corsOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);

// CORS is limited to the web app's origin(s): never a wildcard (session cookies are sent with credentials).
if (corsOrigins.some((o) => o === '*' || !/^https?:\/\/[^/*]+$/.test(o))) {
  console.error(`CORS_ORIGIN must list exact origins such as http://localhost:5173 (got "${env.CORS_ORIGIN}")`);
  process.exit(1);
}
// The example secret from .env.example must never reach production.
if (env.NODE_ENV === 'production' && (env.JWT_SECRET.startsWith('change-me') || env.JWT_SECRET.length < 32)) {
  console.error('JWT_SECRET must be a random string of at least 32 characters in production');
  process.exit(1);
}
