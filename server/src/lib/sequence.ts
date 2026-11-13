import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Atomically increments and returns the counter for `key` (first call returns 1).
 * Backs human-readable IDs: staff codes ("staff:DOC" → HMS-DOC-0007) and MRNs ("mrn:2026" → MB-2026-000001).
 */
export async function nextSequence(key: string, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO id_sequences (key, value, updated_at) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET value = id_sequences.value + 1, updated_at = now()
    RETURNING value`;
  return rows[0]!.value;
}
