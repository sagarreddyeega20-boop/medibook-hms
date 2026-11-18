/**
 * Backups are only real if the restore works: `npm run db:backup` then `npm run db:restore` into a scratch
 * database on the same server, which must come back with exactly the row counts recorded at backup time.
 * (The restore script itself compares them and exits non-zero on any difference.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const out = mkdtempSync(join(tmpdir(), 'medibook-backup-'));
const scratchDb = `medibook_restore_test_${process.pid}`;
const node = (script: string, args: string[]) => execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const psql = (sql: string) => execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'medibook', '-d', 'postgres', '-At', '-c', sql], { cwd: root, encoding: 'utf8' }).trim();

afterAll(() => {
  try {
    psql(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
  } catch { /* already gone */ }
  rmSync(out, { recursive: true, force: true });
});

describe('db:backup → db:restore', () => {
  it('backs up with pg_dump (custom format) and records row counts', () => {
    const log = node('db-backup.mjs', ['--out', out]);
    expect(log).toContain('Backup complete');
    expect(existsSync(join(out, 'medibook.dump'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.rowCounts.users).toBeGreaterThan(0);
    expect(readFileSync(join(out, 'medibook.dump')).subarray(0, 5).toString()).toBe('PGDMP'); // pg_dump custom-format signature
  }, 120_000);

  it('restores into a fresh database with identical row counts', () => {
    const log = node('db-restore.mjs', [out, '--yes', '--target-db', scratchDb]);
    expect(log).toContain(`Restored "${scratchDb}"`);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const restored = Number(execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'medibook', '-d', scratchDb, '-At', '-c', 'SELECT count(*) FROM visits'], { cwd: root, encoding: 'utf8' }).trim());
    expect(restored).toBe(manifest.rowCounts.visits);
    // The restored copy is a working schema: the double-booking index came back too.
    const idx = execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'medibook', '-d', scratchDb, '-At', '-c', "SELECT count(*) FROM pg_indexes WHERE tablename = 'appointments' AND indexdef ILIKE '%status <> %CANCELLED%'"], { cwd: root, encoding: 'utf8' }).trim();
    expect(Number(idx)).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('refuses to run without confirmation', () => {
    expect(() => execFileSync(process.execPath, [join(root, 'scripts', 'db-restore.mjs'), out, '--target-db', scratchDb], { cwd: root, input: 'no\n', stdio: ['pipe', 'pipe', 'pipe'] })).toThrow();
  });
});
