#!/usr/bin/env node
/**
 * npm run db:backup [-- --out <dir>]
 *
 * Backs up the database with pg_dump (custom format, compressed) plus the uploaded result files.
 * Writes backups/<timestamp>/{medibook.dump, uploads/, manifest.json}.
 *
 * pg_dump runs inside the docker-compose `postgres` container, so no PostgreSQL tools are needed on the host
 * and the client always matches the server version. Set PG_TOOLS=host to use pg_dump from your PATH instead
 * (it then connects with DATABASE_URL).
 */
import { cpSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dbConfig, pgDumpTo, ROOT, rowCounts } from './db-lib.mjs';

const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const dir = resolve(outArg ?? join(ROOT, 'backups', stamp));
mkdirSync(dir, { recursive: true });

const cfg = dbConfig();
const dumpFile = join(dir, 'medibook.dump');
console.log(`Backing up database "${cfg.database}" → ${dumpFile}`);
pgDumpTo(cfg, dumpFile);

const uploads = join(ROOT, 'server', cfg.uploadDir);
const hasUploads = existsSync(uploads);
if (hasUploads) cpSync(uploads, join(dir, 'uploads'), { recursive: true });

const counts = rowCounts(cfg);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), database: cfg.database, uploads: hasUploads, rowCounts: counts }, null, 2));

const mb = (statSync(dumpFile).size / 1024 / 1024).toFixed(2);
console.log(`✔ Backup complete (${mb} MB${hasUploads ? ', with uploaded result files' : ''}): ${dir}`);
console.log(`  Restore with: npm run db:restore -- ${dir}`);
