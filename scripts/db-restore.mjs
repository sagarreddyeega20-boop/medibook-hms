#!/usr/bin/env node
/**
 * npm run db:restore [-- <backup dir>] [--yes] [--target-db <name>]
 *
 * Restores a backup made by `npm run db:backup` (the newest one in backups/ when no directory is given).
 * The target database is DROPPED and recreated, then filled with pg_restore; uploaded result files are put back.
 * Stop `npm run dev` first (open connections block the drop).
 *
 *   --yes             skip the confirmation prompt
 *   --target-db name  restore into another database on the same server (e.g. to check a backup without
 *                     touching the live one); uploads are not touched in this mode
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { dbConfig, pgRestoreFrom, psql, ROOT, rowCounts } from './db-lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--target-db');

function latestBackup() {
  const base = join(ROOT, 'backups');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'medibook.dump'))).map((d) => d.name).sort();
  return dirs.length ? join(base, dirs[dirs.length - 1]) : null;
}

const dir = positional[0] ? resolve(positional[0]) : latestBackup();
if (!dir || !existsSync(join(dir, 'medibook.dump'))) {
  console.error('No backup found. Run `npm run db:backup` first, or pass a backup directory.');
  process.exit(1);
}

const cfg = dbConfig();
const target = opt('--target-db') ?? cfg.database;
if (!/^[a-z_][a-z0-9_]*$/i.test(target)) {
  console.error(`Invalid database name: ${target}`);
  process.exit(1);
}
const manifest = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null;

console.log(`Backup:   ${dir}${manifest ? ` (taken ${manifest.createdAt})` : ''}`);
console.log(`Restores: database "${target}" — it will be DROPPED and recreated${target === cfg.database ? ', and uploaded result files replaced' : ''}.`);
if (!flag('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "restore" to continue: ')).trim();
  rl.close();
  if (answer !== 'restore') {
    console.log('Cancelled.');
    process.exit(1);
  }
}

// Drop and recreate (terminating any open connections), then restore.
psql(cfg, 'postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${target}' AND pid <> pg_backend_pid();`);
psql(cfg, 'postgres', `DROP DATABASE IF EXISTS "${target}";`);
psql(cfg, 'postgres', `CREATE DATABASE "${target}" OWNER "${cfg.user}";`);
pgRestoreFrom({ ...cfg, database: target }, join(dir, 'medibook.dump'));

if (target === cfg.database) {
  const uploads = join(ROOT, 'server', cfg.uploadDir);
  if (existsSync(join(dir, 'uploads'))) {
    rmSync(uploads, { recursive: true, force: true });
    cpSync(join(dir, 'uploads'), uploads, { recursive: true });
  }
}

// Verify: row counts must match the counts recorded when the backup was taken.
const after = rowCounts({ ...cfg, database: target });
if (manifest?.rowCounts) {
  const diff = Object.entries(manifest.rowCounts).filter(([t, n]) => after[t] !== n);
  if (diff.length) {
    console.error('✖ Restore finished but row counts differ from the backup:', Object.fromEntries(diff.map(([t, n]) => [t, { backup: n, restored: after[t] }])));
    process.exit(2);
  }
}
console.log(`✔ Restored "${target}" (${Object.values(after).reduce((a, b) => a + b, 0)} rows in ${Object.keys(after).length} key tables, matching the backup).`);
