import type { CatalogueCategory, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { assertPaise } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Billing service — Service catalogue, charges, one invoice per visit, counter payments, allocations, refunds.
 * Owns: service_catalogue, charges, invoices, invoice_lines, payments, payment_allocations, refunds
 * Other modules must call this service, never these tables directly.
 */

/** A doctor's own consultation item: CONS-HMS-DOC-0007. Falls back to the department's CONS-<dept code>. */
export const doctorConsultationCode = (staffCode: string) => `CONS-${staffCode}`;
export const departmentConsultationCode = (deptCode: string) => `CONS-${deptCode}`;

export const billingService = {
  /** Creates or updates the doctor's consultation price in the service catalogue. */
  async setConsultationFee(
    input: { staffCode: string; doctorName: string; departmentId: string; pricePaise: number },
    tx: Prisma.TransactionClient = prisma,
  ) {
    assertPaise(input.pricePaise);
    const code = doctorConsultationCode(input.staffCode);
    const data = {
      name: `Consultation – ${input.doctorName}`,
      category: 'CONSULTATION' as const,
      departmentId: input.departmentId,
      pricePaise: input.pricePaise,
      isActive: true,
    };
    return tx.serviceCatalogue.upsert({ where: { code }, update: data, create: { code, ...data }, select: { id: true, code: true, pricePaise: true } });
  },

  /**
   * Consultation fee per doctor (paise): the doctor's own catalogue item, else their department's.
   * Returns staffCode → { pricePaise, source }.
   */
  async consultationFees(doctors: { staffCode: string; departmentCode: string | null }[]) {
    const codes = [
      ...doctors.map((d) => doctorConsultationCode(d.staffCode)),
      ...doctors.filter((d) => d.departmentCode).map((d) => departmentConsultationCode(d.departmentCode!)),
    ];
    const items = await prisma.serviceCatalogue.findMany({ where: { code: { in: [...new Set(codes)] }, isActive: true }, select: { code: true, pricePaise: true } });
    const byCode = new Map(items.map((i) => [i.code, i.pricePaise]));
    return new Map(
      doctors.map((d) => {
        const own = byCode.get(doctorConsultationCode(d.staffCode));
        const dept = d.departmentCode ? byCode.get(departmentConsultationCode(d.departmentCode)) : undefined;
        return [d.staffCode, own !== undefined ? { pricePaise: own, source: 'DOCTOR' as const } : dept !== undefined ? { pricePaise: dept, source: 'DEPARTMENT' as const } : null];
      }),
    );
  },

  /** Active catalogue items of these categories (doctor's order picker). */
  catalogue(categories: CatalogueCategory[]) {
    return prisma.serviceCatalogue.findMany({
      where: { category: { in: categories }, isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: catalogueSelect,
    });
  },

  async catalogueItem(id: string) {
    const item = await prisma.serviceCatalogue.findUnique({ where: { id }, select: catalogueSelect });
    if (!item || !item.isActive) throw AppError.notFound('That test or scan is not in the service catalogue');
    return item;
  },

  /**
   * One consultation charge per completed consult: the doctor's own catalogue item, else their department's.
   * Idempotent per visit. Returns null (and logs) when no price is set, so a missing fee never blocks the doctor.
   */
  async addConsultationCharge(input: { visitId: string; staffCode: string; departmentCode: string | null; doctorName: string; createdById: string }, tx: Prisma.TransactionClient) {
    const existing = await tx.charge.findFirst({ where: { visitId: input.visitId, catalogueItem: { category: 'CONSULTATION' }, status: { not: 'VOID' } }, select: { id: true } });
    if (existing) return null;
    const codes = [doctorConsultationCode(input.staffCode), ...(input.departmentCode ? [departmentConsultationCode(input.departmentCode)] : [])];
    const items = await tx.serviceCatalogue.findMany({ where: { code: { in: codes }, isActive: true }, select: { id: true, code: true, name: true, pricePaise: true, departmentId: true } });
    const item = items.find((i) => i.code === codes[0]) ?? items.find((i) => i.code === codes[1]);
    if (!item) {
      console.warn(`[billing] no consultation fee for ${input.staffCode}; visit ${input.visitId} has no consultation charge`);
      return null;
    }
    return tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: item.id, departmentId: item.departmentId, description: `Consultation – ${input.doctorName}`,
        quantity: 1, unitPricePaise: assertPaise(item.pricePaise), totalPaise: item.pricePaise, createdById: input.createdById,
      },
      select: { id: true, description: true, totalPaise: true, departmentId: true, status: true },
    });
  },

  /**
   * Charge for a completed lab test / radiology scan: price and department come from the catalogue item.
   * Idempotent per order (a re-upload never bills twice).
   */
  async addOrderCharge(input: { visitId: string; orderId: string; catalogueItemId: string; createdById: string }, tx: Prisma.TransactionClient) {
    const existing = await tx.charge.findFirst({ where: { orderId: input.orderId, status: { not: 'VOID' } }, select: { id: true, description: true, totalPaise: true, departmentId: true, status: true } });
    if (existing) return existing;
    const item = await tx.serviceCatalogue.findUnique({ where: { id: input.catalogueItemId }, select: { id: true, name: true, pricePaise: true, departmentId: true } });
    if (!item) throw AppError.notFound('That test or scan is not in the service catalogue');
    return tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: item.id, departmentId: item.departmentId, orderId: input.orderId, description: item.name,
        quantity: 1, unitPricePaise: assertPaise(item.pricePaise), totalPaise: item.pricePaise, createdById: input.createdById,
      },
      select: { id: true, description: true, totalPaise: true, departmentId: true, status: true },
    });
  },

  /** The catalogue item that bills a medicine (MEDICINE category, pharmacy department, selling price). Created or repriced here. */
  async upsertMedicineItem(input: { code: string; name: string; departmentId: string; pricePaise: number }, tx: Prisma.TransactionClient = prisma) {
    assertPaise(input.pricePaise);
    const code = `MED-ITEM-${input.code}`;
    const data = { name: input.name, category: 'MEDICINE' as const, departmentId: input.departmentId, pricePaise: input.pricePaise, isActive: true };
    return tx.serviceCatalogue.upsert({ where: { code }, update: data, create: { code, ...data }, select: { id: true, departmentId: true } });
  },

  /** Charge for one dispensation, at the selling price on the day it was dispensed. */
  async addDispensationCharge(
    input: { visitId: string; dispensationId: string; catalogueItemId: string; departmentId: string; description: string; quantity: number; unitPricePaise: number; createdById: string },
    tx: Prisma.TransactionClient,
  ) {
    assertPaise(input.unitPricePaise);
    return tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: input.catalogueItemId, departmentId: input.departmentId, dispensationId: input.dispensationId,
        description: input.description, quantity: input.quantity, unitPricePaise: input.unitPricePaise, totalPaise: input.unitPricePaise * input.quantity, createdById: input.createdById,
      },
      select: { id: true, totalPaise: true },
    });
  },

  /** Charges on a visit (consultation screen summary). */
  chargesForVisit(visitId: string) {
    return prisma.charge.findMany({
      where: { visitId, status: { not: 'VOID' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, description: true, totalPaise: true, status: true, createdAt: true, department: { select: { name: true } } },
    });
  },
};

const catalogueSelect = {
  id: true, code: true, name: true, category: true, pricePaise: true, isActive: true,
  department: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ServiceCatalogueSelect;
