/** Shared helpers for the backup/restore scripts. Reads connection settings from the root .env. */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readEnv() {
  const file = join(ROOT, '.env');
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return { ...out, ...process.env };
}

export function dbConfig() {
  const env = readEnv();
  const url = new URL(env.DATABASE_URL ?? 'postgresql://medibook:medibook@localhost:5434/medibook_hms');
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    uploadDir: env.UPLOAD_DIR || 'uploads',
    hostTools: env.PG_TOOLS === 'host',
  };
}

/** Runs a PostgreSQL client tool in the docker-compose `postgres` service (default) or on the host. */
function run(cfg, tool, toolArgs, io = {}) {
  const opts = { stdio: [io.stdin ?? 'ignore', io.stdout ?? 'pipe', 'inherit'], cwd: ROOT, env: { ...process.env, PGPASSWORD: cfg.password }, maxBuffer: 64 * 1024 * 1024 };
  if (cfg.hostTools) return execFileSync(tool, ['-h', cfg.host, '-p', cfg.port, '-U', cfg.user, ...toolArgs], opts);
  // Inside the container the server listens on the default socket; PGPASSWORD is passed through.
  return execFileSync('docker', ['compose', 'exec', '-T', '-e', `PGPASSWORD=${cfg.password}`, 'postgres', tool, '-U', cfg.user, ...toolArgs], opts);
}

export function pgDumpTo(cfg, file) {
  const fd = openSync(file, 'w');
  try {
    run(cfg, 'pg_dump', ['-d', cfg.database, '-Fc', '--no-owner', '--no-privileges'], { stdout: fd });
  } finally {
    closeSync(fd);
  }
}

export function pgRestoreFrom(cfg, file) {
  const fd = openSync(file, 'r');
  try {
    run(cfg, 'pg_restore', ['-d', cfg.database, '--no-owner', '--no-privileges', '--exit-on-error'], { stdin: fd, stdout: 'inherit' });
  } finally {
    closeSync(fd);
  }
}

export function psql(cfg, database, sql) {
  return run(cfg, 'psql', ['-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]).toString().trim();
}

/** Exact row counts of the key tables (used to verify a restore). */
export const KEY_TABLES = ['users', 'staff', 'patients', 'appointments', 'visits', 'clinical_notes', 'orders', 'order_results', 'prescriptions', 'dispensations', 'stock_movements', 'charges', 'invoices', 'payments', 'payment_allocations', 'audit_logs'];
export function rowCounts(cfg) {
  const sql = KEY_TABLES.map((t) => `SELECT '${t}', count(*) FROM ${t}`).join(' UNION ALL ');
  const out = psql(cfg, cfg.database, sql);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const [t, n] = l.split('|'); return [t, Number(n)]; }));
}
