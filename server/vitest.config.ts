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
    },
  },
});
