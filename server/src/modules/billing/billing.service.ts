import type { Prisma } from '@prisma/client';
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
};
