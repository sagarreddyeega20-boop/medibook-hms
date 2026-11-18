import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests share the docker-compose Postgres + Redis, so run files one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://medibook:medibook@localhost:5434/medibook_hms?schema=public',
      REDIS_URL: 'redis://localhost:6380',
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      APP_URL: 'http://localhost:5173',
      CORS_ORIGIN: 'http://localhost:5173',
      // Tests must never send real email (mailer.ts also forces console when NODE_ENV=test).
      MAIL_TRANSPORT: 'console',
      SMTP_USER: '',
      SMTP_PASS: '',
      // The suites log in hundreds of times from 127.0.0.1; src/security.test.ts tests the limiter itself.
      RATE_LIMIT_LOGIN_PER_IP: '100000',
      RATE_LIMIT_LOGIN_PER_ACCOUNT: '100000',
      RATE_LIMIT_OTP_PER_IP: '100000',
    },
  },
});
