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

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
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
