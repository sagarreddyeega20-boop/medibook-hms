import { Prisma, type CatalogueCategory, type InvoiceStatus, type PaymentMethod, type RefundStatus } from '@prisma/client';
import { AppError, isUniqueViolation } from '../../lib/errors.js';
import { assertPaise } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitTo, Rooms } from '../../lib/socket.js';
import { localDateKey, localDayRange } from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';
import { visitsService } from '../visits/visits.service.js';

/**
 * Billing service — Service catalogue, charges, one invoice per visit, counter payments, allocations, refunds,
 * end-of-day cash reconciliation.
 * Owns: service_catalogue, charges, invoices, invoice_lines, payments, payment_allocations, refunds, cash_reconciliations
 * Other modules must call this service, never these tables directly.
 *
 * Money rules: integer paise everywhere. An invoice line's totalPaise is net of discount and BEFORE tax;
 * its taxPaise comes from the catalogue item's rate (snapshotted on the line). Invoice total = Σ line totals + Σ line tax.
 * Payments reach invoices only through payment_allocations; invoice.paidPaise = Σ allocations − Σ approved refunds.
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

/** A doctor's own consultation item: CONS-HMS-DOC-0007. Falls back to the department's CONS-<dept code>. */
export const doctorConsultationCode = (staffCode: string) => `CONS-${staffCode}`;
export const departmentConsultationCode = (deptCode: string) => `CONS-${deptCode}`;

/** GST on medicines sold at the hospital pharmacy; consultations, tests and scans are exempt (0). Editable per item by admin. */
export const MEDICINE_TAX_PERCENT = 5;

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'] as const satisfies readonly PaymentMethod[];

export const lineTaxPaise = (netPaise: number, taxPercent: number) => Math.round((netPaise * taxPercent) / 100);

export const invoiceStatusFor = (totalPaise: number, paidPaise: number): InvoiceStatus =>
  totalPaise > 0 && paidPaise >= totalPaise ? 'PAID' : paidPaise > 0 ? 'PARTIALLY_PAID' : 'ISSUED';

const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);

/** Refund states where the money has gone back to the patient (counter: approved by accounts; online: processed by the gateway). */
export const MONEY_BACK: RefundStatus[] = ['APPROVED', 'REFUNDED'];

/** How a booking's consultation is paid, for My appointments, the reception board and the counter. */
export type PrepaidState = 'PAID_ONLINE' | 'REFUNDED';

/** INV-20261114-0001 / RCPT-20261114-0001: per-day counters, never reused. */
async function nextNumber(prefix: 'INV' | 'RCPT', tx: Prisma.TransactionClient) {
  const day = localDateKey().replace(/-/g, '');
  return `${prefix}-${day}-${String(await nextSequence(`${prefix.toLowerCase()}:${day}`, tx)).padStart(4, '0')}`;
}

/** Serialises invoice creation per visit (one bill per visit, even when two departments bill at the same moment). */
async function lockVisitInvoice(tx: Prisma.TransactionClient, visitId: string) {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`invoice:${visitId}`}))`;
}

async function lockInvoices(tx: Prisma.TransactionClient, ids: string[]) {
  if (ids.length) await tx.$queryRaw`SELECT id FROM invoices WHERE id = ANY(${[...ids].sort()}::uuid[]) ORDER BY id FOR UPDATE`;
}

async function staffOf(actor: Actor) {
  const me = await staffService.profileByUserId(actor.session.userId);
  if (!me || !me.isActive) throw AppError.forbidden('Only active staff can do this');
  return me;
}

/** Recomputes an invoice's totals from its lines and its status from what has been paid. */
async function recomputeInvoice(tx: Prisma.TransactionClient, invoiceId: string) {
  const [lines, inv] = await Promise.all([
    tx.invoiceLine.findMany({ where: { invoiceId }, select: { quantity: true, unitPricePaise: true, discountPaise: true, totalPaise: true, taxPaise: true } }),
    tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paidPaise: true } }),
  ]);
  const totalPaise = sum(lines, (l) => l.totalPaise + l.taxPaise);
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      subtotalPaise: sum(lines, (l) => l.quantity * l.unitPricePaise),
      discountPaise: sum(lines, (l) => l.discountPaise),
      taxPaise: sum(lines, (l) => l.taxPaise),
      totalPaise,
      status: invoiceStatusFor(totalPaise, inv.paidPaise),
    },
  });
}

/**
 * Gathers a visit's un-invoiced charges onto its one invoice (created on the first charge).
 * Called in the same transaction that creates a charge, and as a backfill before bills are shown.
 */
async function syncVisitInvoice(tx: Prisma.TransactionClient, visitId: string) {
  await lockVisitInvoice(tx, visitId);
  const pending = await tx.charge.findMany({
    where: { visitId, status: 'PENDING', invoiceLine: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, departmentId: true, description: true, quantity: true, unitPricePaise: true, discountPaise: true, totalPaise: true, catalogueItem: { select: { taxPercent: true } } },
  });
  let invoice = await tx.invoice.findUnique({ where: { visitId }, select: { id: true } });
  if (!pending.length) return invoice?.id ?? null;
  if (!invoice) {
    const visit = await visitsService.get(visitId);
    invoice = await tx.invoice.create({
      data: { invoiceNumber: await nextNumber('INV', tx), visitId, patientId: visit.patientId, status: 'ISSUED', issuedAt: new Date() },
      select: { id: true },
    });
  }
  await tx.invoiceLine.createMany({
    data: pending.map((c) => ({
      invoiceId: invoice.id, chargeId: c.id, departmentId: c.departmentId, description: c.description, quantity: c.quantity,
      unitPricePaise: c.unitPricePaise, discountPaise: c.discountPaise, totalPaise: c.totalPaise,
      taxPercent: c.catalogueItem.taxPercent, taxPaise: lineTaxPaise(c.totalPaise, c.catalogueItem.taxPercent),
    })),
  });
  await tx.charge.updateMany({ where: { id: { in: pending.map((c) => c.id) } }, data: { status: 'INVOICED' } });
  await recomputeInvoice(tx, invoice.id);
  return invoice.id;
}

/** Backfill: puts any charge that is not yet on an invoice onto its visit's invoice. */
async function syncPendingCharges(visitIds?: string[]) {
  const rows = await prisma.charge.findMany({
    where: { status: 'PENDING', invoiceLine: null, visitId: visitIds ? { in: visitIds } : { not: null } },
    distinct: ['visitId'],
    select: { visitId: true },
  });
  for (const r of rows) if (r.visitId) await prisma.$transaction((tx) => syncVisitInvoice(tx, r.visitId!));
}

const changed = (kind: string, patientId?: string) => emitTo(Rooms.billing, 'billing:changed', { kind, patientId });

/* ---------------- Read models ---------------- */

const invoiceSelect = {
  id: true, invoiceNumber: true, visitId: true, appointmentId: true, patientId: true, status: true, issuedAt: true, createdAt: true,
  subtotalPaise: true, discountPaise: true, taxPaise: true, totalPaise: true, paidPaise: true,
  allocations: { where: { payment: { channel: 'ONLINE' } }, select: { amountPaise: true } },
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceSelect }>;

const visitIdsOf = (ids: (string | null)[]) => ids.filter((x): x is string => !!x);

async function presentInvoices(rows: InvoiceRow[]) {
  const [visits, patients] = await Promise.all([visitsService.billingHeaders(visitIdsOf(rows.map((r) => r.visitId))), patientsService.summaries(rows.map((r) => r.patientId))]);
  return rows.map(({ allocations, ...r }) => {
    const p = patients.get(r.patientId);
    return {
      ...r,
      balancePaise: r.totalPaise - r.paidPaise,
      /** Paid in advance through the online gateway (prepaid consultation). */
      paidOnlinePaise: sum(allocations, (a) => a.amountPaise),
      visit: r.visitId ? (visits.get(r.visitId) ?? null) : null,
      patient: p ? { id: p.id, name: p.name, mrn: p.mrn } : null,
    };
  });
}
export type InvoiceSummary = Awaited<ReturnType<typeof presentInvoices>>[number];

const paymentSelect = {
  id: true, receiptNumber: true, patientId: true, method: true, channel: true, provider: true, last4: true, status: true, amountPaise: true, reference: true, receivedAt: true,
  receivedBy: { select: { fullName: true, staffCode: true } },
  allocations: { orderBy: { createdAt: 'asc' }, select: { invoiceId: true, amountPaise: true, invoice: { select: { invoiceNumber: true, visitId: true, totalPaise: true, paidPaise: true, status: true } } } },
  refunds: { orderBy: { createdAt: 'asc' }, select: { id: true, invoiceId: true, amountPaise: true, status: true, reason: true, createdAt: true, processedAt: true } },
} satisfies Prisma.PaymentSelect;
type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

async function presentPayments(rows: PaymentRow[]) {
  const [patients, visits] = await Promise.all([
    patientsService.summaries(rows.map((r) => r.patientId)),
    visitsService.billingHeaders(visitIdsOf(rows.flatMap((r) => r.allocations.map((a) => a.invoice.visitId)))),
  ]);
  return rows.map((r) => {
    const p = patients.get(r.patientId);
    return {
      id: r.id, receiptNumber: r.receiptNumber, method: r.method, channel: r.channel, provider: r.provider, last4: r.last4, status: r.status, amountPaise: r.amountPaise, reference: r.reference, receivedAt: r.receivedAt,
      receivedBy: r.receivedBy ? { name: r.receivedBy.fullName, staffCode: r.receivedBy.staffCode } : null,
      patient: p ? { id: p.id, name: p.name, mrn: p.mrn } : null,
      allocations: r.allocations.map((a) => ({
        invoiceId: a.invoiceId, invoiceNumber: a.invoice.invoiceNumber, amountPaise: a.amountPaise,
        invoiceTotalPaise: a.invoice.totalPaise, invoiceBalancePaise: a.invoice.totalPaise - a.invoice.paidPaise, invoiceStatus: a.invoice.status,
        visit: a.invoice.visitId ? (visits.get(a.invoice.visitId) ?? null) : null,
      })),
      refunds: r.refunds,
      refundedPaise: sum(r.refunds.filter((x) => MONEY_BACK.includes(x.status)), (x) => x.amountPaise),
    };
  });
}
export type Receipt = Awaited<ReturnType<typeof presentPayments>>[number];

const refundSelect = {
  id: true, paymentId: true, invoiceId: true, amountPaise: true, method: true, reason: true, status: true, decisionNote: true, createdAt: true, processedAt: true,
  payment: { select: { receiptNumber: true, patientId: true, amountPaise: true } },
  invoice: { select: { invoiceNumber: true } },
  requestedBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
} satisfies Prisma.RefundSelect;

async function presentRefunds(rows: Prisma.RefundGetPayload<{ select: typeof refundSelect }>[]) {
  const patients = await patientsService.summaries(rows.map((r) => r.payment.patientId));
  return rows.map((r) => {
    const p = patients.get(r.payment.patientId);
    return {
      id: r.id, paymentId: r.paymentId, invoiceId: r.invoiceId, amountPaise: r.amountPaise, method: r.method, reason: r.reason, status: r.status,
      decisionNote: r.decisionNote, createdAt: r.createdAt, processedAt: r.processedAt,
      receiptNumber: r.payment.receiptNumber, invoiceNumber: r.invoice?.invoiceNumber ?? null,
      patient: p ? { id: p.id, name: p.name, mrn: p.mrn } : null,
      requestedBy: r.requestedBy?.fullName ?? null, decidedBy: r.approvedBy?.fullName ?? null,
    };
  });
}
export type RefundView = Awaited<ReturnType<typeof presentRefunds>>[number];

/**
 * Expected counter takings for one local day: confirmed COUNTER payments by method minus counter refunds approved
 * (paid out) that day. Online prepayments never pass through the cash drawer, so they are not part of it.
 */
async function dayTotals(dateKey: string) {
  const { start, end } = localDayRange(dateKey);
  const [payments, refunds] = await Promise.all([
    prisma.payment.groupBy({ by: ['method'], where: { status: 'CONFIRMED', channel: 'COUNTER', receivedAt: { gte: start, lt: end } }, _sum: { amountPaise: true }, _count: true }),
    prisma.refund.groupBy({ by: ['method'], where: { status: 'APPROVED', payment: { channel: 'COUNTER' }, processedAt: { gte: start, lt: end } }, _sum: { amountPaise: true }, _count: true }),
  ]);
  const by = (rows: typeof payments, m: PaymentMethod) => rows.find((r) => r.method === m)?._sum.amountPaise ?? 0;
  const methods = PAYMENT_METHODS.map((m) => ({ method: m, receivedPaise: by(payments, m), refundedPaise: by(refunds, m), expectedPaise: by(payments, m) - by(refunds, m) }));
  return { methods, paymentCount: sum(payments, (r) => r._count), refundCount: sum(refunds, (r) => r._count) };
}

const reconciliationSelect = {
  id: true, businessDate: true, expectedCashPaise: true, expectedUpiPaise: true, expectedCardPaise: true, countedCashPaise: true,
  differencePaise: true, paymentCount: true, note: true, createdAt: true, closedBy: { select: { fullName: true, staffCode: true } },
} satisfies Prisma.CashReconciliationSelect;

const catalogueSelect = {
  id: true, code: true, name: true, category: true, pricePaise: true, taxPercent: true, isActive: true,
  department: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ServiceCatalogueSelect;

/** Local-day expression for GROUP BY in reports. */
const DAY_SQL = (col: Prisma.Sql) => Prisma.sql`to_char((${col} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;

export const billingService = {
  /* ================= Service catalogue ================= */

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
    return tx.serviceCatalogue.upsert({ where: { code }, update: data, create: { code, ...data, taxPercent: 0 }, select: { id: true, code: true, pricePaise: true } });
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

  /** The full price list (admin), every category. */
  priceList() {
    return prisma.serviceCatalogue.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: catalogueSelect });
  },

  /** Admin edits an item's price or tax rate. Already-invoiced lines keep the price and rate they were billed at. */
  async updateCatalogueItem(actor: Actor, id: string, input: { pricePaise?: number; taxPercent?: number; isActive?: boolean }) {
    const before = await prisma.serviceCatalogue.findUnique({ where: { id }, select: catalogueSelect });
    if (!before) throw AppError.notFound('Catalogue item not found');
    if (input.pricePaise !== undefined) assertPaise(input.pricePaise);
    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.serviceCatalogue.update({ where: { id }, data: input, select: catalogueSelect });
      const diff = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && (before as Record<string, unknown>)[k] !== v).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k], to: v }]));
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.CATALOGUE_UPDATED, entity: 'service_catalogue', entityId: id, ip: actor.ip ?? null, metadata: { code: before.code, changed: diff } as Prisma.InputJsonValue }, tx);
      return updated;
    });
    return item;
  },

  /* ================= Charges (created by other modules, in their transaction) ================= */

  /**
   * One consultation charge per completed consult: the doctor's own catalogue item, else their department's.
   * Idempotent per visit. Returns null (and logs) when no price is set, so a missing fee never blocks the doctor.
   */
  async addConsultationCharge(input: { visitId: string; staffCode: string; departmentCode: string | null; doctorName: string; createdById: string }, tx: Prisma.TransactionClient) {
    const existing = await tx.charge.findFirst({ where: { visitId: input.visitId, catalogueItem: { category: 'CONSULTATION' }, status: { not: 'VOID' } }, select: { id: true } });
    if (existing) return null;
    // Prepaid online: the consultation was charged (and paid) at booking. Never charge it a second time.
    const visit = await tx.visit.findUnique({ where: { id: input.visitId }, select: { appointmentId: true } });
    if (visit?.appointmentId) {
      const prepaid = await tx.charge.findFirst({ where: { appointmentId: visit.appointmentId, status: { not: 'VOID' } }, select: { id: true } });
      if (prepaid) {
        await this.attachPrepaidToVisit(visit.appointmentId, input.visitId, tx);
        return null;
      }
    }
    const codes = [doctorConsultationCode(input.staffCode), ...(input.departmentCode ? [departmentConsultationCode(input.departmentCode)] : [])];
    const items = await tx.serviceCatalogue.findMany({ where: { code: { in: codes }, isActive: true }, select: { id: true, code: true, name: true, pricePaise: true, departmentId: true } });
    const item = items.find((i) => i.code === codes[0]) ?? items.find((i) => i.code === codes[1]);
    if (!item) {
      console.warn(`[billing] no consultation fee for ${input.staffCode}; visit ${input.visitId} has no consultation charge`);
      return null;
    }
    const charge = await tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: item.id, departmentId: item.departmentId, description: `Consultation – ${input.doctorName}`,
        quantity: 1, unitPricePaise: assertPaise(item.pricePaise), totalPaise: item.pricePaise, createdById: input.createdById,
      },
      select: { id: true, description: true, totalPaise: true, departmentId: true, status: true },
    });
    await syncVisitInvoice(tx, input.visitId);
    return charge;
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
    const charge = await tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: item.id, departmentId: item.departmentId, orderId: input.orderId, description: item.name,
        quantity: 1, unitPricePaise: assertPaise(item.pricePaise), totalPaise: item.pricePaise, createdById: input.createdById,
      },
      select: { id: true, description: true, totalPaise: true, departmentId: true, status: true },
    });
    await syncVisitInvoice(tx, input.visitId);
    return charge;
  },

  /** The catalogue item that bills a medicine (MEDICINE category, pharmacy department, selling price). Created or repriced here. */
  async upsertMedicineItem(input: { code: string; name: string; departmentId: string; pricePaise: number }, tx: Prisma.TransactionClient = prisma) {
    assertPaise(input.pricePaise);
    const code = `MED-ITEM-${input.code}`;
    const data = { name: input.name, category: 'MEDICINE' as const, departmentId: input.departmentId, pricePaise: input.pricePaise, isActive: true };
    return tx.serviceCatalogue.upsert({ where: { code }, update: data, create: { code, ...data, taxPercent: MEDICINE_TAX_PERCENT }, select: { id: true, departmentId: true } });
  },

  /** Charge for one dispensation, at the selling price on the day it was dispensed. */
  async addDispensationCharge(
    input: { visitId: string; dispensationId: string; catalogueItemId: string; departmentId: string; description: string; quantity: number; unitPricePaise: number; createdById: string },
    tx: Prisma.TransactionClient,
  ) {
    assertPaise(input.unitPricePaise);
    const charge = await tx.charge.create({
      data: {
        visitId: input.visitId, catalogueItemId: input.catalogueItemId, departmentId: input.departmentId, dispensationId: input.dispensationId,
        description: input.description, quantity: input.quantity, unitPricePaise: input.unitPricePaise, totalPaise: input.unitPricePaise * input.quantity, createdById: input.createdById,
      },
      select: { id: true, totalPaise: true },
    });
    await syncVisitInvoice(tx, input.visitId);
    return charge;
  },

  /** Charges on a visit (consultation screen summary). */
  chargesForVisit(visitId: string) {
    return prisma.charge.findMany({
      where: { visitId, status: { not: 'VOID' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, description: true, totalPaise: true, status: true, createdAt: true, department: { select: { name: true } } },
    });
  },

  /** Emits after another module's transaction committed a charge (counter screens refresh). */
  notifyCharged(patientId?: string) {
    changed('charge', patientId);
  },

  /* ================= Online prepayment of the consultation (called by the payments module) ================= */

  /** The catalogue item a doctor's consultation is billed with (own item, else the department's), or null. */
  async consultationItemFor(doctor: { staffCode: string; departmentCode: string | null }) {
    const codes = [doctorConsultationCode(doctor.staffCode), ...(doctor.departmentCode ? [departmentConsultationCode(doctor.departmentCode)] : [])];
    const items = await prisma.serviceCatalogue.findMany({ where: { code: { in: codes }, isActive: true }, select: { id: true, code: true, name: true, pricePaise: true, taxPercent: true, departmentId: true } });
    const item = items.find((i) => i.code === codes[0]) ?? items.find((i) => i.code === codes[1]);
    return item ? { ...item, amountPaise: item.pricePaise + lineTaxPaise(item.pricePaise, item.taxPercent) } : null;
  },

  /**
   * Records a gateway-confirmed prepayment, in the booking transaction: the consultation charge (on the appointment —
   * the visit does not exist yet), its own invoice, the ONLINE payment and its allocation. At check-in the invoice
   * becomes the visit's bill, so tests and medicines are added to it and the consultation is never charged twice.
   * Idempotent through the payment's idempotency key.
   */
  async recordOnlinePrepayment(
    input: {
      appointmentId: string; patientId: string; catalogueItemId: string; description: string; amountPaise: number;
      method: PaymentMethod; provider: string | null; last4: string | null; reference: string; idempotencyKey: string; actorUserId: string;
    },
    tx: Prisma.TransactionClient,
  ) {
    assertPaise(input.amountPaise);
    const prior = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, receiptNumber: true, allocations: { select: { invoiceId: true } } } });
    if (prior) return { paymentId: prior.id, receiptNumber: prior.receiptNumber, invoiceId: prior.allocations[0]?.invoiceId ?? null };
    const item = await tx.serviceCatalogue.findUniqueOrThrow({ where: { id: input.catalogueItemId }, select: { id: true, departmentId: true, taxPercent: true } });
    // The amount paid includes any tax on the item; split it back into price + tax so the line adds up exactly.
    const netPaise = Math.round((input.amountPaise * 100) / (100 + item.taxPercent));
    const charge = await tx.charge.create({
      data: {
        appointmentId: input.appointmentId, catalogueItemId: item.id, departmentId: item.departmentId, description: input.description,
        quantity: 1, unitPricePaise: netPaise, totalPaise: netPaise, status: 'INVOICED',
      },
      select: { id: true },
    });
    const invoice = await tx.invoice.create({
      data: { invoiceNumber: await nextNumber('INV', tx), appointmentId: input.appointmentId, patientId: input.patientId, status: 'ISSUED', issuedAt: new Date() },
      select: { id: true, invoiceNumber: true },
    });
    await tx.invoiceLine.create({
      data: {
        invoiceId: invoice.id, chargeId: charge.id, departmentId: item.departmentId, description: input.description, quantity: 1,
        unitPricePaise: netPaise, totalPaise: netPaise, taxPercent: item.taxPercent, taxPaise: input.amountPaise - netPaise,
      },
    });
    const payment = await tx.payment.create({
      data: {
        receiptNumber: await nextNumber('RCPT', tx), patientId: input.patientId, method: input.method, channel: 'ONLINE', status: 'CONFIRMED',
        amountPaise: input.amountPaise, reference: input.reference, provider: input.provider, last4: input.last4, idempotencyKey: input.idempotencyKey,
        allocations: { create: [{ invoiceId: invoice.id, amountPaise: input.amountPaise }] },
      },
      select: { id: true, receiptNumber: true },
    });
    await recomputeInvoice(tx, invoice.id);
    const totals = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { totalPaise: true } });
    await tx.invoice.update({ where: { id: invoice.id }, data: { paidPaise: input.amountPaise, status: invoiceStatusFor(totals.totalPaise, input.amountPaise) } });
    await auditService.record({
      actorId: input.actorUserId, action: AuditAction.PAYMENT_RECORDED, entity: 'payments', entityId: payment.id, patientId: input.patientId,
      metadata: { receiptNumber: payment.receiptNumber, channel: 'ONLINE', method: input.method, provider: input.provider, amountPaise: input.amountPaise, invoices: [invoice.invoiceNumber] },
    }, tx);
    return { paymentId: payment.id, receiptNumber: payment.receiptNumber, invoiceId: invoice.id };
  },

  /** Check-in: the prepaid consultation and its invoice now belong to the visit (one bill per visit). */
  async attachPrepaidToVisit(appointmentId: string, visitId: string, tx: Prisma.TransactionClient) {
    const inv = await tx.invoice.findUnique({ where: { appointmentId }, select: { id: true, visitId: true } });
    if (!inv || inv.visitId === visitId) return;
    await lockVisitInvoice(tx, visitId);
    if (await tx.invoice.findUnique({ where: { visitId }, select: { id: true } })) return; // the visit already has a bill (cannot happen at check-in)
    await tx.invoice.update({ where: { id: inv.id }, data: { visitId } });
    await tx.charge.updateMany({ where: { appointmentId, visitId: null }, data: { visitId } });
  },

  /** Reschedule: the prepayment follows the booking to its new appointment. */
  async movePrepaid(fromAppointmentId: string, toAppointmentId: string, tx: Prisma.TransactionClient) {
    await tx.invoice.updateMany({ where: { appointmentId: fromAppointmentId }, data: { appointmentId: toAppointmentId } });
    await tx.charge.updateMany({ where: { appointmentId: fromAppointmentId }, data: { appointmentId: toAppointmentId } });
  },

  /** The online payment that can still be refunded for a booking (cancelled prepaid appointment), or null. */
  async prepaidRefundable(appointmentId: string) {
    const inv = await prisma.invoice.findUnique({
      where: { appointmentId },
      select: {
        id: true,
        allocations: { where: { payment: { channel: 'ONLINE', status: 'CONFIRMED' } }, select: { amountPaise: true, payment: { select: { id: true, method: true, reference: true } } } },
        refunds: { where: { status: { in: ['REQUESTED', ...MONEY_BACK] } }, select: { amountPaise: true } },
      },
    });
    const alloc = inv?.allocations[0];
    if (!inv || !alloc) return null;
    const amountPaise = alloc.amountPaise - sum(inv.refunds, (r) => r.amountPaise);
    return amountPaise > 0 ? { invoiceId: inv.id, paymentId: alloc.payment.id, method: alloc.payment.method, providerPaymentId: alloc.payment.reference, amountPaise } : null;
  },

  /**
   * Records the refund of a cancelled prepaid booking. `gatewayRefundId` set → the gateway already refunded it: status
   * REFUNDED, the charge and invoice are voided (the consultation will not happen). Null → the gateway refund failed:
   * a REQUESTED refund lands in the accounts queue to be paid out by hand.
   */
  async recordOnlineRefund(input: { appointmentId: string; gatewayRefundId: string | null; reason: string; actorUserId: string; ip?: string | null }) {
    const refundable = await this.prepaidRefundable(input.appointmentId);
    if (!refundable) return null;
    const id = await prisma.$transaction(async (tx) => {
      await lockInvoices(tx, [refundable.invoiceId]);
      const done = input.gatewayRefundId !== null;
      const r = await tx.refund.create({
        data: {
          paymentId: refundable.paymentId, invoiceId: refundable.invoiceId, amountPaise: refundable.amountPaise, method: refundable.method, reason: input.reason,
          status: done ? 'REFUNDED' : 'REQUESTED', processedAt: done ? new Date() : null, decisionNote: done ? `Gateway refund ${input.gatewayRefundId}` : 'Gateway refund failed — pay out manually',
        },
        select: { id: true, payment: { select: { patientId: true, receiptNumber: true } } },
      });
      if (done) {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: refundable.invoiceId }, select: { totalPaise: true, paidPaise: true } });
        await tx.charge.updateMany({ where: { appointmentId: input.appointmentId, status: { not: 'VOID' } }, data: { status: 'VOID' } });
        await tx.invoice.update({ where: { id: refundable.invoiceId }, data: { paidPaise: inv.paidPaise - refundable.amountPaise, status: 'VOID' } });
      }
      await auditService.record({
        actorId: input.actorUserId, action: done ? AuditAction.REFUND_PROCESSED : AuditAction.REFUND_REQUESTED, entity: 'refunds', entityId: r.id,
        patientId: r.payment.patientId, reason: input.reason, ip: input.ip ?? null,
        metadata: { receiptNumber: r.payment.receiptNumber, amountPaise: refundable.amountPaise, channel: 'ONLINE', gatewayRefundId: input.gatewayRefundId },
      }, tx);
      return r.id;
    });
    changed('refund');
    return (await this.refunds({ ids: [id] }))[0]!;
  },

  /** Prepaid state per appointment id (appointments without an online payment are absent: pay at hospital). */
  async prepaidStatus(appointmentIds: string[]) {
    const out = new Map<string, PrepaidState>();
    if (!appointmentIds.length) return out;
    const rows = await prisma.invoice.findMany({
      where: { appointmentId: { in: [...new Set(appointmentIds)] } },
      select: {
        appointmentId: true,
        allocations: { where: { payment: { channel: 'ONLINE', status: 'CONFIRMED' } }, select: { id: true } },
        refunds: { where: { status: 'REFUNDED' }, select: { id: true } },
      },
    });
    for (const r of rows) {
      if (!r.appointmentId || !r.allocations.length) continue;
      out.set(r.appointmentId, r.refunds.length ? 'REFUNDED' : 'PAID_ONLINE');
    }
    return out;
  },

  /* ================= Invoices ================= */

  /** One invoice with its lines (each tagged with its department), payments and refunds. */
  async invoice(id: string) {
    await syncPendingCharges((await prisma.invoice.findUnique({ where: { id }, select: { visitId: true } }).then((i) => (i?.visitId ? [i.visitId] : []))));
    const row = await prisma.invoice.findUnique({
      where: { id },
      select: {
        ...invoiceSelect,
        lines: { orderBy: { id: 'asc' }, select: { id: true, description: true, quantity: true, unitPricePaise: true, discountPaise: true, totalPaise: true, taxPercent: true, taxPaise: true, department: { select: { code: true, name: true } }, charge: { select: { createdAt: true, appointmentId: true } } } },
        refunds: { orderBy: { createdAt: 'asc' }, select: { id: true, amountPaise: true, status: true, reason: true, createdAt: true } },
      },
    });
    if (!row) throw AppError.notFound('Invoice not found');
    const payments = await prisma.paymentAllocation.findMany({
      where: { invoiceId: id }, orderBy: { createdAt: 'asc' },
      select: { amountPaise: true, payment: { select: { id: true, receiptNumber: true, method: true, channel: true, receivedAt: true } } },
    });
    const [base] = await presentInvoices([row]);
    return {
      ...base!,
      lines: row.lines.map((l) => ({
        id: l.id, description: l.description, department: l.department, quantity: l.quantity, unitPricePaise: l.unitPricePaise, discountPaise: l.discountPaise, totalPaise: l.totalPaise, taxPercent: l.taxPercent, taxPaise: l.taxPaise, chargedAt: l.charge?.createdAt ?? null,
        /** Consultation prepaid online at booking: the counter shows it as "Paid online" and collects only the rest. */
        paidOnline: !!l.charge?.appointmentId && base!.paidOnlinePaise > 0,
      })),
      payments: payments.map((a) => ({ paymentId: a.payment.id, receiptNumber: a.payment.receiptNumber, method: a.payment.method, channel: a.payment.channel, receivedAt: a.payment.receivedAt, amountPaise: a.amountPaise })),
      refunds: row.refunds,
    };
  },
  async invoicePatientId(id: string) {
    const i = await prisma.invoice.findUnique({ where: { id }, select: { patientId: true } });
    if (!i) throw AppError.notFound('Invoice not found');
    return i.patientId;
  },

  /** A patient's bills (newest first) and their recent receipts — the billing counter's patient view. */
  async patientAccount(patientId: string) {
    const patient = await patientsService.getSummary(patientId);
    const visits = await visitsService.listForPatient(patientId);
    await syncPendingCharges(visits.map((v) => v.id));
    const [invoices, payments] = await Promise.all([
      prisma.invoice.findMany({ where: { patientId, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' }, select: invoiceSelect }),
      prisma.payment.findMany({ where: { patientId }, orderBy: { receivedAt: 'desc' }, take: 20, select: paymentSelect }),
    ]);
    const shown = await presentInvoices(invoices);
    return {
      patient,
      invoices: shown,
      payments: await presentPayments(payments),
      outstandingPaise: sum(shown, (i) => i.balancePaise),
    };
  },

  /** Billing counter home: today's takings, unpaid bills across the hospital, latest receipts, refunds waiting. */
  async counter(dateKey = localDateKey()) {
    await syncPendingCharges();
    const { start, end } = localDayRange(dateKey);
    const [totals, unpaid, receipts, pendingRefunds, reconciliation] = await Promise.all([
      dayTotals(dateKey),
      prisma.invoice.findMany({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, orderBy: { createdAt: 'desc' }, take: 100, select: invoiceSelect }),
      prisma.payment.findMany({ where: { receivedAt: { gte: start, lt: end } }, orderBy: { receivedAt: 'desc' }, take: 8, select: paymentSelect }),
      prisma.refund.count({ where: { status: 'REQUESTED' } }),
      prisma.cashReconciliation.findUnique({ where: { businessDate: dateKey }, select: { id: true, differencePaise: true } }),
    ]);
    const unpaidShown = await presentInvoices(unpaid);
    return {
      date: dateKey,
      stats: {
        collectedTodayPaise: sum(totals.methods, (m) => m.receivedPaise),
        receiptsToday: totals.paymentCount,
        unpaidInvoices: unpaidShown.length,
        outstandingPaise: sum(unpaidShown, (i) => i.balancePaise),
        pendingRefunds,
      },
      methods: totals.methods,
      unpaid: unpaidShown,
      receipts: await presentPayments(receipts),
      reconciled: reconciliation,
    };
  },

  /** Patients matching a search, with what each one owes. */
  async searchPatients(q: string) {
    const patients = await patientsService.search(q, 10);
    if (!patients.length) return [];
    const owed = await prisma.invoice.groupBy({ by: ['patientId'], where: { patientId: { in: patients.map((p) => p.id) }, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, _sum: { totalPaise: true, paidPaise: true }, _count: true });
    const by = new Map(owed.map((o) => [o.patientId, { unpaid: o._count, outstandingPaise: (o._sum.totalPaise ?? 0) - (o._sum.paidPaise ?? 0) }]));
    return patients.map((p) => ({ id: p.id, name: p.name, mrn: p.mrn, phone: p.phone, unpaidInvoices: by.get(p.id)?.unpaid ?? 0, outstandingPaise: by.get(p.id)?.outstandingPaise ?? 0 }));
  },

  /* ================= Payments ================= */

  /**
   * Records a counter payment (CASH / UPI / CARD) and allocates it across one or more of the patient's invoices.
   * Idempotent: the same idempotency key always returns the first payment and never records a second one —
   * whether the retry arrives after the first commit or races it (the unique index decides).
   */
  async collectPayment(
    actor: Actor,
    input: { patientId: string; method: PaymentMethod; reference?: string | null; idempotencyKey: string; allocations: { invoiceId: string; amountPaise: number }[] },
  ): Promise<{ payment: Receipt; replayed: boolean }> {
    const staff = await staffOf(actor);
    const ids = input.allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw AppError.badRequest('Each invoice can appear only once in a payment');
    for (const a of input.allocations) if (!Number.isInteger(a.amountPaise) || a.amountPaise <= 0) throw AppError.badRequest('Each amount must be a positive whole number of paise');
    const amountPaise = sum(input.allocations, (a) => a.amountPaise);

    const replay = async (paymentId: string) => {
      const [p] = await presentPayments([await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: paymentSelect })]);
      const same =
        p!.patient?.id === input.patientId && p!.method === input.method && p!.amountPaise === amountPaise &&
        p!.allocations.length === input.allocations.length &&
        input.allocations.every((a) => p!.allocations.some((x) => x.invoiceId === a.invoiceId && x.amountPaise === a.amountPaise));
      if (!same) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment key was already used for a different payment. Start a new payment.');
      return { payment: p!, replayed: true };
    };

    const prior = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
    if (prior) return replay(prior.id);

    let result: { id: string; replayed: boolean };
    try {
      result = await prisma.$transaction(async (tx) => {
        await lockInvoices(tx, ids);
        // A concurrent duplicate that committed while we waited for the locks.
        const again = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
        if (again) return { id: again.id, replayed: true };

        const invoices = await tx.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, invoiceNumber: true, patientId: true, status: true, totalPaise: true, paidPaise: true } });
        for (const a of input.allocations) {
          const inv = invoices.find((i) => i.id === a.invoiceId);
          if (!inv || inv.patientId !== input.patientId) throw AppError.notFound('One of the invoices does not belong to this patient');
          if (inv.status === 'VOID' || inv.status === 'DRAFT') throw new AppError(409, 'INVOICE_NOT_PAYABLE', `${inv.invoiceNumber} cannot take payments`);
          const balance = inv.totalPaise - inv.paidPaise;
          if (balance <= 0) throw new AppError(409, 'INVOICE_ALREADY_PAID', `${inv.invoiceNumber} is already paid`);
          if (a.amountPaise > balance) throw new AppError(409, 'OVERPAYMENT', `${inv.invoiceNumber} has only ${balance} paise left to pay`);
        }
        const payment = await tx.payment.create({
          data: {
            receiptNumber: await nextNumber('RCPT', tx), patientId: input.patientId, method: input.method, status: 'CONFIRMED', amountPaise,
            reference: input.reference?.trim() || null, idempotencyKey: input.idempotencyKey, receivedById: staff.id,
            allocations: { create: input.allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise })) },
          },
          select: { id: true, receiptNumber: true },
        });
        for (const a of input.allocations) {
          const inv = invoices.find((i) => i.id === a.invoiceId)!;
          const paid = inv.paidPaise + a.amountPaise;
          await tx.invoice.update({ where: { id: inv.id }, data: { paidPaise: paid, status: invoiceStatusFor(inv.totalPaise, paid) } });
        }
        await auditService.record({
          actorId: actor.session.userId, action: AuditAction.PAYMENT_RECORDED, entity: 'payments', entityId: payment.id, patientId: input.patientId, ip: actor.ip ?? null,
          metadata: { receiptNumber: payment.receiptNumber, method: input.method, amountPaise, invoices: invoices.map((i) => i.invoiceNumber) },
        }, tx);
        return { id: payment.id, replayed: false };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
        if (winner) return replay(winner.id);
      }
      throw err;
    }
    if (result.replayed) return replay(result.id);
    changed('payment', input.patientId);
    return { payment: (await this.receipt(result.id)), replayed: false };
  },

  async receipt(paymentId: string) {
    const row = await prisma.payment.findUnique({ where: { id: paymentId }, select: paymentSelect });
    if (!row) throw AppError.notFound('Receipt not found');
    return (await presentPayments([row]))[0]!;
  },

  /* ================= Refunds: requested at the counter, approved only by accounts ================= */

  async requestRefund(actor: Actor, input: { paymentId: string; invoiceId: string; amountPaise: number; reason: string }) {
    const staff = await staffOf(actor);
    assertPaise(input.amountPaise);
    const refund = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
      const p = await tx.payment.findUnique({
        where: { id: input.paymentId },
        select: { id: true, receiptNumber: true, patientId: true, method: true, status: true, allocations: { select: { invoiceId: true, amountPaise: true } }, refunds: { where: { status: { in: ['REQUESTED', ...MONEY_BACK] } }, select: { invoiceId: true, amountPaise: true } } },
      });
      if (!p) throw AppError.notFound('Receipt not found');
      if (p.status !== 'CONFIRMED') throw new AppError(409, 'PAYMENT_NOT_CONFIRMED', 'Only confirmed payments can be refunded');
      const alloc = p.allocations.find((a) => a.invoiceId === input.invoiceId);
      if (!alloc) throw AppError.badRequest('That invoice was not paid with this receipt');
      const available = alloc.amountPaise - sum(p.refunds.filter((r) => r.invoiceId === input.invoiceId), (r) => r.amountPaise);
      if (input.amountPaise > available) throw new AppError(409, 'REFUND_TOO_LARGE', available > 0 ? `At most ${available} paise can still be refunded on this invoice` : 'This payment has already been refunded in full');
      const r = await tx.refund.create({
        data: { paymentId: p.id, invoiceId: input.invoiceId, amountPaise: input.amountPaise, method: p.method, reason: input.reason.trim(), requestedById: staff.id, status: 'REQUESTED' },
        select: { id: true },
      });
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.REFUND_REQUESTED, entity: 'refunds', entityId: r.id, patientId: p.patientId, reason: input.reason.trim(), ip: actor.ip ?? null, metadata: { receiptNumber: p.receiptNumber, amountPaise: input.amountPaise } }, tx);
      return r;
    });
    changed('refund');
    return (await this.refunds({ ids: [refund.id] }))[0]!;
  },

  /** ACCOUNTS approves (money goes back by the original method; the invoice balance reopens) or rejects, with a note. */
  async decideRefund(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', note: string | null) {
    const staff = await staffOf(actor);
    await prisma.$transaction(async (tx) => {
      const r = await tx.refund.findUnique({ where: { id }, select: { id: true, status: true, amountPaise: true, invoiceId: true, reason: true, payment: { select: { patientId: true, receiptNumber: true } } } });
      if (!r) throw AppError.notFound('Refund not found');
      if (r.invoiceId) await lockInvoices(tx, [r.invoiceId]);
      const done = await tx.refund.updateMany({ where: { id, status: 'REQUESTED' }, data: { status: decision, approvedById: staff.id, decisionNote: note?.trim() || null, processedAt: new Date() } });
      if (!done.count) throw new AppError(409, 'REFUND_ALREADY_DECIDED', 'This refund has already been decided');
      if (decision === 'APPROVED' && r.invoiceId) {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, select: { totalPaise: true, paidPaise: true } });
        const paid = inv.paidPaise - r.amountPaise;
        await tx.invoice.update({ where: { id: r.invoiceId }, data: { paidPaise: paid, status: invoiceStatusFor(inv.totalPaise, paid) } });
      }
      await auditService.record({
        actorId: actor.session.userId, action: decision === 'APPROVED' ? AuditAction.REFUND_APPROVED : AuditAction.REFUND_REJECTED, entity: 'refunds', entityId: id,
        patientId: r.payment.patientId, reason: note?.trim() || r.reason, ip: actor.ip ?? null, metadata: { receiptNumber: r.payment.receiptNumber, amountPaise: r.amountPaise },
      }, tx);
    });
    changed('refund');
    return (await this.refunds({ ids: [id] }))[0]!;
  },

  async refunds(q: { ids?: string[]; status?: RefundStatus; from?: Date; to?: Date; patientId?: string; take?: number }) {
    const rows = await prisma.refund.findMany({
      where: {
        id: q.ids ? { in: q.ids } : undefined,
        status: q.status,
        createdAt: q.from && q.to ? { gte: q.from, lt: q.to } : undefined,
        payment: q.patientId ? { patientId: q.patientId } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: q.take ?? 200,
      select: refundSelect,
    });
    return presentRefunds(rows);
  },

  /* ================= End-of-day cash reconciliation ================= */

  async reconciliation(dateKey: string) {
    const [totals, saved, recent] = await Promise.all([
      dayTotals(dateKey),
      prisma.cashReconciliation.findUnique({ where: { businessDate: dateKey }, select: reconciliationSelect }),
      prisma.cashReconciliation.findMany({ orderBy: { businessDate: 'desc' }, take: 7, select: reconciliationSelect }),
    ]);
    return { date: dateKey, ...totals, reconciliation: saved, recent };
  },

  /** Closes the day: freezes expected totals, records counted cash and the difference. Once per day. */
  async closeDay(actor: Actor, input: { date: string; countedCashPaise: number; note?: string | null }) {
    const staff = await staffOf(actor);
    assertPaise(input.countedCashPaise);
    if (input.date > localDateKey()) throw AppError.badRequest('You cannot close a day that has not started');
    const totals = await dayTotals(input.date);
    const expected = (m: PaymentMethod) => totals.methods.find((x) => x.method === m)!.expectedPaise;
    const differencePaise = input.countedCashPaise - expected('CASH');
    const note = input.note?.trim() || null;
    if (differencePaise !== 0 && !note) throw AppError.badRequest('Explain the difference between counted and expected cash');
    try {
      const saved = await prisma.$transaction(async (tx) => {
        const row = await tx.cashReconciliation.create({
          data: {
            businessDate: input.date, expectedCashPaise: expected('CASH'), expectedUpiPaise: expected('UPI'), expectedCardPaise: expected('CARD'),
            countedCashPaise: input.countedCashPaise, differencePaise, paymentCount: totals.paymentCount, note, closedById: staff.id,
          },
          select: reconciliationSelect,
        });
        await auditService.record({ actorId: actor.session.userId, action: AuditAction.CASH_RECONCILED, entity: 'cash_reconciliations', entityId: row.id, reason: note, ip: actor.ip ?? null, metadata: { date: input.date, expectedCashPaise: expected('CASH'), countedCashPaise: input.countedCashPaise, differencePaise } }, tx);
        return row;
      });
      changed('reconciliation');
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'ALREADY_RECONCILED', `${input.date} has already been reconciled`);
      throw err;
    }
  },

  /* ================= Patient portal (own + family bills) ================= */

  async forPatients(patientIds: string[]) {
    const visits = (await Promise.all(patientIds.map((id) => visitsService.listForPatient(id)))).flat();
    await syncPendingCharges(visits.map((v) => v.id));
    const [invoices, payments] = await Promise.all([
      prisma.invoice.findMany({ where: { patientId: { in: patientIds }, status: { not: 'VOID' } }, orderBy: { createdAt: 'desc' }, select: invoiceSelect }),
      prisma.payment.findMany({ where: { patientId: { in: patientIds } }, orderBy: { receivedAt: 'desc' }, select: paymentSelect }),
    ]);
    return { invoices: await presentInvoices(invoices), payments: await presentPayments(payments) };
  },
  async paymentPatientId(id: string) {
    const p = await prisma.payment.findUnique({ where: { id }, select: { patientId: true } });
    if (!p) throw AppError.notFound('Receipt not found');
    return p.patientId;
  },

  /* ================= Reports (read by the accounts module) ================= */

  /** Billed revenue (net of discounts, before tax) per department, from charges raised in [start, end). */
  async revenueByDepartment(start: Date, end: Date) {
    const rows = await prisma.charge.groupBy({ by: ['departmentId'], where: { createdAt: { gte: start, lt: end }, status: { not: 'VOID' } }, _sum: { totalPaise: true }, _count: true });
    const depts = await staffService.departmentsByIds(rows.map((r) => r.departmentId));
    return rows
      .map((r) => ({ departmentId: r.departmentId, code: depts.get(r.departmentId)?.code ?? '?', name: depts.get(r.departmentId)?.name ?? 'Unknown', kind: depts.get(r.departmentId)?.kind ?? null, revenuePaise: r._sum.totalPaise ?? 0, charges: r._count }))
      .sort((a, b) => b.revenuePaise - a.revenuePaise);
  },

  /** Per local day: billed (charges) and collected (payments − approved refunds). */
  async dailyRevenue(start: Date, end: Date) {
    const [billed, received, refunded] = await Promise.all([
      prisma.$queryRaw<{ day: string; paise: bigint }[]>`SELECT ${DAY_SQL(Prisma.sql`created_at`)} AS day, SUM(total_paise)::bigint AS paise FROM charges WHERE created_at >= ${start} AND created_at < ${end} AND status <> 'VOID' GROUP BY 1`,
      prisma.$queryRaw<{ day: string; paise: bigint }[]>`SELECT ${DAY_SQL(Prisma.sql`received_at`)} AS day, SUM(amount_paise)::bigint AS paise FROM payments WHERE received_at >= ${start} AND received_at < ${end} AND status = 'CONFIRMED' GROUP BY 1`,
      prisma.$queryRaw<{ day: string; paise: bigint }[]>`SELECT ${DAY_SQL(Prisma.sql`processed_at`)} AS day, SUM(amount_paise)::bigint AS paise FROM refunds WHERE processed_at >= ${start} AND processed_at < ${end} AND status IN ('APPROVED', 'REFUNDED') GROUP BY 1`,
    ]);
    const map = (rows: { day: string; paise: bigint }[]) => new Map(rows.map((r) => [r.day, Number(r.paise)]));
    return { billed: map(billed), received: map(received), refunded: map(refunded) };
  },

  /** Collections by method and by channel (counter vs online), tax billed and refunds in [start, end). */
  async collections(start: Date, end: Date) {
    const [byMethod, byChannel, refunds, tax] = await Promise.all([
      prisma.payment.groupBy({ by: ['method'], where: { status: 'CONFIRMED', receivedAt: { gte: start, lt: end } }, _sum: { amountPaise: true }, _count: true }),
      prisma.payment.groupBy({ by: ['channel'], where: { status: 'CONFIRMED', receivedAt: { gte: start, lt: end } }, _sum: { amountPaise: true }, _count: true }),
      prisma.refund.groupBy({ by: ['status'], where: { createdAt: { gte: start, lt: end } }, _sum: { amountPaise: true }, _count: true }),
      prisma.invoiceLine.aggregate({ where: { charge: { createdAt: { gte: start, lt: end }, status: { not: 'VOID' } } }, _sum: { taxPaise: true } }),
    ]);
    const methodsSeen = [...PAYMENT_METHODS, ...byMethod.map((r) => r.method).filter((m) => !(PAYMENT_METHODS as readonly PaymentMethod[]).includes(m))];
    return {
      methods: methodsSeen.map((m) => ({ method: m, amountPaise: byMethod.find((r) => r.method === m)?._sum.amountPaise ?? 0, count: byMethod.find((r) => r.method === m)?._count ?? 0 })),
      channels: (['COUNTER', 'ONLINE'] as const).map((c) => ({ channel: c, amountPaise: byChannel.find((r) => r.channel === c)?._sum.amountPaise ?? 0, count: byChannel.find((r) => r.channel === c)?._count ?? 0 })),
      refunds: Object.fromEntries(refunds.map((r) => [r.status, { amountPaise: r._sum.amountPaise ?? 0, count: r._count }])) as Partial<Record<RefundStatus, { amountPaise: number; count: number }>>,
      taxBilledPaise: tax._sum.taxPaise ?? 0,
    };
  },

  /** Counter payments in [start, end), newest first — no line items, so nothing clinical. */
  async transactions(start: Date, end: Date, take = 1000) {
    const rows = await prisma.payment.findMany({ where: { receivedAt: { gte: start, lt: end } }, orderBy: { receivedAt: 'desc' }, take, select: paymentSelect });
    return (await presentPayments(rows)).map((p) => ({
      id: p.id, receiptNumber: p.receiptNumber, receivedAt: p.receivedAt, method: p.method, channel: p.channel, provider: p.provider, status: p.status, amountPaise: p.amountPaise, reference: p.reference,
      refundedPaise: p.refundedPaise, patient: p.patient, receivedBy: p.receivedBy?.name ?? null, invoices: p.allocations.map((a) => a.invoiceNumber),
    }));
  },
};
