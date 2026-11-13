import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Result attachments (PDF / image reports) on local disk under server/uploads (git-ignored).
 * Files are never served statically: the orders module streams them after checking who is asking.
 * Stored as <folder>/<id>.<ext>; the type is decided from the file's own bytes, never from the client.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPLOAD_ROOT = path.resolve(SERVER_ROOT, env.UPLOAD_DIR);

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
} as const;
type Ext = keyof typeof TYPES;

/** Recognises PDF, PNG, JPEG and WebP by their magic bytes. */
export function sniffType(buf: Buffer): Ext | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Decodes a base64 upload (plain or data: URL) and checks size and type. */
export function decodeUpload(base64: string) {
  const raw = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw AppError.badRequest('The file is not valid base64');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw AppError.badRequest('The file is empty');
  if (buf.length > MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Reports can be at most 5 MB');
  const ext = sniffType(buf);
  if (!ext) throw new AppError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, PNG, JPEG or WebP file');
  return { buf, ext, mimeType: TYPES[ext] };
}

const dirOf = (folder: string) => path.join(UPLOAD_ROOT, folder);

export async function saveUpload(folder: string, id: string, file: { buf: Buffer; ext: Ext }) {
  await mkdir(dirOf(folder), { recursive: true });
  const full = path.join(dirOf(folder), `${id}.${file.ext}`);
  await writeFile(full, file.buf, { flag: 'wx' });
  return full;
}

/** Absolute path + MIME type of a stored file, or null. `id` must be a UUID (no path tricks). */
export async function findUpload(folder: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const names = await readdir(dirOf(folder)).catch(() => [] as string[]);
  const name = names.find((n) => n.startsWith(`${id}.`));
  if (!name) return null;
  const ext = name.slice(id.length + 1) as Ext;
  if (!(ext in TYPES)) return null;
  return { path: path.join(dirOf(folder), name), mimeType: TYPES[ext], ext };
}

export async function removeUpload(fullPath: string) {
  await unlink(fullPath).catch(() => undefined);
}
