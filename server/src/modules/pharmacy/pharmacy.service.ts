import { prisma } from '../../lib/prisma.js';

/**
 * Pharmacy service — Medicines, stock movements, dispensing, low-stock alerts.
 * Owns: medicines, stock_movements, dispensations
 * Other modules must call this service, never these tables directly.
 */
const medicineSelect = { id: true, code: true, name: true, genericName: true, form: true, strength: true, unit: true, sellingPricePaise: true, stockQuantity: true } as const;

export const pharmacyService = {
  /** Formulary search for the prescription form (name, generic name or code). */
  searchMedicines(q: string, limit = 15) {
    const term = q.trim();
    return prisma.medicine.findMany({
      where: {
        isActive: true,
        ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { genericName: { contains: term, mode: 'insensitive' } }, { code: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: limit,
      select: medicineSelect,
    });
  },

  async medicinesByIds(ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; name: string; strength: string | null; form: string | null }>();
    const rows = await prisma.medicine.findMany({ where: { id: { in: ids }, isActive: true }, select: medicineSelect });
    return new Map(rows.map((r) => [r.id, r]));
  },
};
