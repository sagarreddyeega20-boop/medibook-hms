import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite: the "MVP done when" list from docs/mvp-structure.md, driven through the real web app.
 * Starts its own API (port 4400) and web app (port 5180) against the docker-compose database, so it never
 * collides with `npm run dev`. Needs `docker compose up -d` and a seeded database (`npm run db:seed`).
 *
 *   npm run test:e2e            headless
 *   npm run test:e2e -- --headed --slow-mo 300   watch it
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5180',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: 'http://localhost:4400/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -w web',
      url: 'http://localhost:5180',
      env: { WEB_PORT: '5180', API_PROXY_TARGET: 'http://localhost:4400' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
