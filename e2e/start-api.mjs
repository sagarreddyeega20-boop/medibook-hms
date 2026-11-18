/**
 * Starts the API for the Playwright run on its own port and copies its output to e2e/.artifacts/server.log,
 * where the tests read the development OTP lines ("[otp:dev] <email> → <code>") — the same codes a person
 * would read from the console. Uses the normal .env (same database and Redis as `npm run dev`).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'e2e', '.artifacts'), { recursive: true });
const log = createWriteStream(join(root, 'e2e', '.artifacts', 'server.log'), { flags: 'w' });

const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--env-file=../.env', 'src/index.ts'], {
  cwd: join(root, 'server'),
  env: {
    ...process.env,
    NODE_ENV: 'development', // OTPs are printed only in development
    PORT: '4400',
    APP_URL: 'http://localhost:5180',
    CORS_ORIGIN: 'http://localhost:5180',
    // The suite signs in as 8 staff accounts per run; repeated runs must not trip the per-hour / per-IP limits.
    OTP_MAX_PER_HOUR: '1000',
    OTP_RESEND_COOLDOWN_SECONDS: '1',
    RATE_LIMIT_LOGIN_PER_IP: '100000',
    RATE_LIMIT_LOGIN_PER_ACCOUNT: '100000',
    RATE_LIMIT_OTP_PER_IP: '100000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [child.stdout, child.stderr]) {
  s.on('data', (d) => {
    log.write(d);
    process.stdout.write(d);
  });
}
const stop = () => child.kill();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', stop);
child.on('exit', (code) => process.exit(code ?? 0));
