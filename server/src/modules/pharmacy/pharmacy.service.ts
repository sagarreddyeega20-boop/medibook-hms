import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import { assertPaise } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { nextSequence } from '../../lib/sequence.js';
import { emitTo, Rooms } from '../../lib/socket.js';
import { localDateKey, localDayRange } from '../../lib/time.js';
import { AuditAction, auditService } from '../audit/audit.service.js';
import type { SessionData } from '../auth/session.service.js';
import { billingService } from '../billing/billing.service.js';
import { ordersService, type PrescriptionView } from '../orders/orders.service.js';
import { patientsService } from '../patients/patients.service.js';
import { staffService } from '../staff/staff.service.js';

/**
 * Pharmacy service — Medicines, stock movements, dispensing, low-stock alerts.
 * Owns: medicines, stock_movements, dispensations
 * Other modules must call this service, never these tables directly.
 *
 * Stock rules:
 *   - medicines.stock_quantity changes only together with a stock_movements row (PURCHASE +, DISPENSE −).
 *   - Every movement stores the unit purchase cost, and every dispensation stores selling price AND purchase cost,
 *     so pharmacy margin per dispensed item (selling − purchase) is exact even after prices change.
 *   - Low stock = stock below the reorder level.
 */

export interface Actor {
  session: SessionData;
  ip?: string | null;
}

const medicineSelect = { id: true, code: true, name: true, genericName: true, form: true, strength: true, unit: true, sellingPricePaise: true, stockQuantity: true } as const;

const stockSelect = {
  id: true, code: true, name: true, genericName: true, form: true, strength: true, unit: true,
  sellingPricePaise: true, purchasePricePaise: true, stockQuantity: true, reorderLevel: true, isActive: true, updatedAt: true,
} satisfies Prisma.MedicineSelect;
type StockRow = Prisma.MedicineGetPayload<{ select: typeof stockSelect }>;

export type StockLevel = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'IN_STOCK';
export const stockLevel = (m: { stockQuantity: number; reorderLevel: number }): StockLevel =>
  m.stockQuantity <= 0 ? 'OUT_OF_STOCK' : m.stockQuantity < m.reorderLevel ? 'LOW_STOCK' : 'IN_STOCK';

const presentStock = (m: StockRow) => ({ ...m, level: stockLevel(m), marginPaise: m.sellingPricePaise - m.purchasePricePaise });

async function pharmacistOf(actor: Actor) {
  const me = await staffService.profileByUserId(actor.session.userId);
  if (!me || !me.isActive) throw AppError.forbidden('Only active pharmacy staff can do this');
  return me;
}

/** The pharmacy department (charges for medicines are booked here). */
async function pharmacyDepartment(actor?: Actor) {
  if (actor) {
    const mine = await staffService.departmentOfUser(actor.session.userId);
    if (mine?.department?.kind === 'PHARMACY') return mine.department;
  }
  return staffService.departmentByCode('PHARM');
}

/** Formulary lookup for prescription items: the linked medicine, else an exact (case-insensitive) name match. */
async function resolveMedicines(items: PrescriptionView['items']) {
  const ids = items.map((i) => i.medicineId).filter((x): x is string => !!x);
  const names = items.filter((i) => !i.medicineId).map((i) => i.medicineName.trim());
  const rows = await prisma.medicine.findMany({
    where: { isActive: true, OR: [{ id: { in: ids } }, ...names.map((n) => ({ name: { equals: n, mode: 'insensitive' as const } }))] },
    select: stockSelect,
  });
  return new Map(
    items.map((i) => [i.id, rows.find((m) => (i.medicineId ? m.id === i.medicineId : m.name.toLowerCase() === i.medicineName.trim().toLowerCase())) ?? null]),
  );
}

async function emitPharmacy() {
  for (const d of await staffService.departmentsOfKind('PHARMACY')) emitTo(Rooms.department(d.id), 'orders:changed', { type: 'MEDICATION' });
}

export const pharmacyService = {
  /* ---------------- Doctor's prescription form ---------------- */

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

  /* ---------------- Pharmacist home: prescriptions to dispense ---------------- */

  async dashboard() {
    const { start } = localDayRange(localDateKey());
    const [rxs, dispensedToday, meds, todays] = await Promise.all([
      ordersService.prescriptionsToDispense(),
      ordersService.dispensedSince(start),
      prisma.medicine.findMany({ where: { isActive: true }, select: stockSelect, orderBy: { name: 'asc' } }),
      prisma.dispensation.findMany({ where: { dispensedAt: { gte: start } }, select: { quantity: true, unitPricePaise: true, unitCostPaise: true } }),
    ]);
    const [patients, doctors] = await Promise.all([
      patientsService.headers(rxs.map((r) => r.patientId)),
      staffService.doctorsByIds([...new Set(rxs.map((r) => r.doctorId))]),
    ]);
    const stock = meds.map(presentStock);
    return {
      stats: {
        toDispense: rxs.length,
        dispensedToday,
        lowStock: stock.filter((m) => m.level === 'LOW_STOCK').length,
        outOfStock: stock.filter((m) => m.level === 'OUT_OF_STOCK').length,
        salesTodayPaise: todays.reduce((n, d) => n + d.quantity * d.unitPricePaise, 0),
        marginTodayPaise: todays.reduce((n, d) => n + d.quantity * (d.unitPricePaise - d.unitCostPaise), 0),
      },
      queue: rxs.map((r) => {
        const p = patients.get(r.patientId);
        const d = doctors.get(r.doctorId);
        return {
          id: r.id, orderNumber: r.orderNumber, status: r.status, createdAt: r.createdAt,
          patient: p ? { id: p.id, name: p.name, mrn: p.mrn, gender: p.gender, age: p.age } : null,
          doctor: { name: d?.fullName ?? 'Doctor', department: d?.department?.name ?? null },
          items: r.items.length,
          remaining: r.items.reduce((n, i) => n + Math.max(0, i.quantity - i.dispensedQuantity), 0),
          medicines: r.items.map((i) => i.medicineName),
        };
      }),
      lowStock: stock.filter((m) => m.level !== 'IN_STOCK'),
    };
  },

  /** Dispense screen: each item with what is left to give and the stock available. Read-only view of the prescription. */
  async dispenseView(prescriptionId: string) {
    const rx = await ordersService.prescription(prescriptionId);
    const [patient, doctors, meds] = await Promise.all([
      patientsService.headers([rx.patientId]).then((m) => m.get(rx.patientId)),
      staffService.doctorsByIds([rx.doctorId]),
      resolveMedicines(rx.items),
    ]);
    const d = doctors.get(rx.doctorId);
    return {
      prescription: { id: rx.id, orderNumber: rx.orderNumber, status: rx.status, createdAt: rx.createdAt },
      patient: patient ? { id: patient.id, name: patient.name, mrn: patient.mrn, gender: patient.gender, age: patient.age } : null,
      doctor: { name: d?.fullName ?? 'Doctor', department: d?.department?.name ?? null },
      items: rx.items.map((i) => {
        const m = meds.get(i.id);
        return {
          id: i.id, medicineName: i.medicineName, dose: i.dose, frequency: i.frequency, durationDays: i.durationDays, route: i.route, instructions: i.instructions,
          quantity: i.quantity, dispensedQuantity: i.dispensedQuantity, remaining: Math.max(0, i.quantity - i.dispensedQuantity),
          medicine: m ? { id: m.id, code: m.code, name: m.name, strength: m.strength, form: m.form, stockQuantity: m.stockQuantity, sellingPricePaise: m.sellingPricePaise, level: stockLevel(m) } : null,
        };
      }),
    };
  },

  /**
   * Dispense some or all of a prescription. One transaction per request; for every line:
   *   stock − q (refused if not enough) → prescription item + q (refused past the prescribed quantity)
   *   → dispensation (selling price + purchase cost) → DISPENSE stock movement (−q, unit cost) → charge at selling price.
   */
  async dispense(actor: Actor, prescriptionId: string, lines: { itemId: string; quantity: number }[]) {
    const me = await pharmacistOf(actor);
    const view = await this.dispenseView(prescriptionId);
    if (!['ACTIVE', 'PARTIALLY_DISPENSED'].includes(view.prescription.status)) throw new AppError(409, 'NOTHING_TO_DISPENSE', 'This prescription is already fully dispensed or cancelled.');
    const wanted = lines.filter((l) => l.quantity > 0);
    if (!wanted.length) throw AppError.badRequest('Enter a quantity for at least one medicine');
    if (new Set(wanted.map((l) => l.itemId)).size !== wanted.length) throw AppError.badRequest('Each medicine can appear once');
    const dept = await pharmacyDepartment(actor);
    const rxVisit = (await ordersService.prescription(prescriptionId)).visitId;

    const result = await prisma.$transaction(async (tx) => {
      const out: { item: string; medicine: string; quantity: number; totalPaise: number }[] = [];
      for (const line of wanted) {
        const item = view.items.find((i) => i.id === line.itemId);
        if (!item) throw AppError.badRequest('That medicine is not on this prescription');
        if (!item.medicine) throw new AppError(409, 'NOT_IN_FORMULARY', `${item.medicineName} is not in the pharmacy formulary, so it cannot be dispensed here.`);

        const dec = await tx.medicine.updateMany({ where: { id: item.medicine.id, isActive: true, stockQuantity: { gte: line.quantity } }, data: { stockQuantity: { decrement: line.quantity } } });
        if (!dec.count) throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${(await tx.medicine.findUnique({ where: { id: item.medicine.id }, select: { stockQuantity: true } }))?.stockQuantity ?? 0} of ${item.medicine.name} in stock.`);
        // Prices as of now (row is locked by the update above).
        const med = await tx.medicine.findUniqueOrThrow({ where: { id: item.medicine.id }, select: { code: true, name: true, sellingPricePaise: true, purchasePricePaise: true, catalogueItemId: true } });

        await ordersService.recordDispensed(prescriptionId, item.id, line.quantity, tx);

        const dispensation = await tx.dispensation.create({
          data: { prescriptionItemId: item.id, medicineId: item.medicine.id, quantity: line.quantity, unitPricePaise: med.sellingPricePaise, unitCostPaise: med.purchasePricePaise, dispensedById: me.id },
          select: { id: true },
        });
        await tx.stockMovement.create({
          data: { medicineId: item.medicine.id, type: 'DISPENSE', quantity: -line.quantity, unitCostPaise: med.purchasePricePaise, dispensationId: dispensation.id, reference: view.prescription.orderNumber ?? `Rx ${prescriptionId}`, performedById: me.id },
        });
        const catalogue = await billingService.upsertMedicineItem({ code: med.code, name: med.name, departmentId: dept.id, pricePaise: med.sellingPricePaise }, tx);
        if (med.catalogueItemId !== catalogue.id) await tx.medicine.update({ where: { id: item.medicine.id }, data: { catalogueItemId: catalogue.id } });
        const charge = await billingService.addDispensationCharge(
          { visitId: rxVisit, dispensationId: dispensation.id, catalogueItemId: catalogue.id, departmentId: catalogue.departmentId, description: `${med.name} × ${line.quantity}`, quantity: line.quantity, unitPricePaise: med.sellingPricePaise, createdById: me.id },
          tx,
        );
        out.push({ item: item.id, medicine: med.name, quantity: line.quantity, totalPaise: charge.totalPaise });
      }
      const status = await ordersService.settlePrescription(prescriptionId, tx);
      await auditService.record(
        {
          actorId: actor.session.userId, action: AuditAction.MEDICINE_DISPENSED, entity: 'dispensations', entityId: prescriptionId, patientId: view.patient?.id ?? null, ip: actor.ip ?? null,
          metadata: { orderNumber: view.prescription.orderNumber, status, lines: out.map((o) => ({ medicine: o.medicine, quantity: o.quantity })), totalPaise: out.reduce((n, o) => n + o.totalPaise, 0) },
        },
        tx,
      );
      return { status, lines: out };
    });
    await emitPharmacy();
    return { ...result, view: await this.dispenseView(prescriptionId) };
  },

  /* ---------------- Stock ---------------- */

  async medicines(q = '') {
    const term = q.trim();
    const rows = await prisma.medicine.findMany({
      where: term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { genericName: { contains: term, mode: 'insensitive' } }, { code: { contains: term, mode: 'insensitive' } }] } : {},
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: stockSelect,
    });
    const list = rows.map(presentStock);
    return {
      medicines: list,
      stats: {
        total: list.filter((m) => m.isActive).length,
        lowStock: list.filter((m) => m.isActive && m.level === 'LOW_STOCK').length,
        outOfStock: list.filter((m) => m.isActive && m.level === 'OUT_OF_STOCK').length,
        stockValuePaise: list.filter((m) => m.isActive).reduce((n, m) => n + m.stockQuantity * m.purchasePricePaise, 0),
      },
    };
  },

  async medicine(id: string) {
    const m = await prisma.medicine.findUnique({ where: { id }, select: stockSelect });
    if (!m) throw AppError.notFound('Medicine not found');
    const movements = await prisma.stockMovement.findMany({
      where: { medicineId: id },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, type: true, quantity: true, unitCostPaise: true, reference: true, createdAt: true, performedBy: { select: { fullName: true } } },
    });
    return { medicine: presentStock(m), movements: movements.map(({ performedBy, ...x }) => ({ ...x, performedBy: performedBy.fullName })) };
  },

  /** New formulary item (no stock yet — stock arrives through Stock in). */
  async createMedicine(
    actor: Actor,
    input: { name: string; genericName?: string | null; strength?: string | null; form?: string | null; sellingPricePaise: number; purchasePricePaise: number; reorderLevel: number },
  ) {
    await pharmacistOf(actor);
    assertPaise(input.sellingPricePaise);
    assertPaise(input.purchasePricePaise);
    const name = input.name.trim();
    if (await prisma.medicine.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) throw new AppError(409, 'DUPLICATE_MEDICINE', `${name} is already in the formulary.`);
    const dept = await pharmacyDepartment(actor);
    const created = await prisma.$transaction(async (tx) => {
      const code = `MED-${String(await nextSequence('medicine', tx)).padStart(4, '0')}`;
      const item = await billingService.upsertMedicineItem({ code, name, departmentId: dept.id, pricePaise: input.sellingPricePaise }, tx);
      const m = await tx.medicine.create({
        data: {
          code, name, genericName: input.genericName?.trim() || null, strength: input.strength?.trim() || null, form: input.form?.trim() || null,
          sellingPricePaise: input.sellingPricePaise, purchasePricePaise: input.purchasePricePaise, reorderLevel: input.reorderLevel, stockQuantity: 0, catalogueItemId: item.id,
        },
        select: stockSelect,
      });
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.MEDICINE_CREATED, entity: 'medicines', entityId: m.id, ip: actor.ip ?? null, metadata: { code, name } }, tx);
      return m;
    });
    return presentStock(created);
  },

  /** Selling price / reorder level / labels. Purchase price changes only with a stock-in (it is a fact about a delivery). */
  async updateMedicine(actor: Actor, id: string, input: { name?: string; genericName?: string | null; strength?: string | null; form?: string | null; sellingPricePaise?: number; reorderLevel?: number; isActive?: boolean }) {
    await pharmacistOf(actor);
    if (input.sellingPricePaise !== undefined) assertPaise(input.sellingPricePaise);
    const before = await prisma.medicine.findUnique({ where: { id }, select: stockSelect });
    if (!before) throw AppError.notFound('Medicine not found');
    const dept = await pharmacyDepartment(actor);
    const updated = await prisma.$transaction(async (tx) => {
      const m = await tx.medicine.update({
        where: { id },
        data: {
          name: input.name?.trim(), genericName: input.genericName === undefined ? undefined : input.genericName?.trim() || null,
          strength: input.strength === undefined ? undefined : input.strength?.trim() || null, form: input.form === undefined ? undefined : input.form?.trim() || null,
          sellingPricePaise: input.sellingPricePaise, reorderLevel: input.reorderLevel, isActive: input.isActive,
        },
        select: { ...stockSelect, catalogueItemId: true },
      });
      const item = await billingService.upsertMedicineItem({ code: m.code, name: m.name, departmentId: dept.id, pricePaise: m.sellingPricePaise }, tx);
      if (m.catalogueItemId !== item.id) await tx.medicine.update({ where: { id }, data: { catalogueItemId: item.id } });
      const changed = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && (before as Record<string, unknown>)[k] !== v));
      await auditService.record({ actorId: actor.session.userId, action: AuditAction.MEDICINE_UPDATED, entity: 'medicines', entityId: id, ip: actor.ip ?? null, metadata: { code: m.code, changed } as Prisma.InputJsonValue }, tx);
      const { catalogueItemId: _c, ...rest } = m;
      return rest;
    });
    await emitPharmacy();
    return presentStock(updated);
  },

  /** Stock in: +quantity at this delivery's purchase price (stored on the movement; becomes the current purchase price). */
  async stockIn(actor: Actor, id: string, input: { quantity: number; unitCostPaise: number; reference?: string | null }) {
    const me = await pharmacistOf(actor);
    assertPaise(input.unitCostPaise);
    const m = await prisma.$transaction(async (tx) => {
      const r = await tx.medicine.updateMany({ where: { id, isActive: true }, data: { stockQuantity: { increment: input.quantity }, purchasePricePaise: input.unitCostPaise } });
      if (!r.count) throw AppError.notFound('Medicine not found or inactive');
      const mv = await tx.stockMovement.create({
        data: { medicineId: id, type: 'PURCHASE', quantity: input.quantity, unitCostPaise: input.unitCostPaise, reference: input.reference?.trim() || null, performedById: me.id },
        select: { id: true },
      });
      const after = await tx.medicine.findUniqueOrThrow({ where: { id }, select: stockSelect });
      await auditService.record(
        { actorId: actor.session.userId, action: AuditAction.STOCK_IN, entity: 'stock_movements', entityId: mv.id, ip: actor.ip ?? null, metadata: { code: after.code, quantity: input.quantity, unitCostPaise: input.unitCostPaise, stockAfter: after.stockQuantity } },
        tx,
      );
      return after;
    });
    await emitPharmacy();
    return presentStock(m);
  },

  /* ---------------- Margin (for accounts) ---------------- */

  /** Pharmacy sales, cost and margin per medicine between two instants, from the prices stored on each dispensation. */
  async margin(from: Date, to: Date) {
    const rows = await prisma.dispensation.findMany({
      where: { dispensedAt: { gte: from, lt: to } },
      select: { medicineId: true, quantity: true, unitPricePaise: true, unitCostPaise: true, medicine: { select: { name: true } } },
    });
    const by = new Map<string, { medicineId: string; name: string; quantity: number; salesPaise: number; costPaise: number; marginPaise: number }>();
    for (const r of rows) {
      const m = by.get(r.medicineId) ?? { medicineId: r.medicineId, name: r.medicine.name, quantity: 0, salesPaise: 0, costPaise: 0, marginPaise: 0 };
      m.quantity += r.quantity;
      m.salesPaise += r.quantity * r.unitPricePaise;
      m.costPaise += r.quantity * r.unitCostPaise;
      m.marginPaise = m.salesPaise - m.costPaise;
      by.set(r.medicineId, m);
    }
    const items = [...by.values()].sort((a, b) => b.marginPaise - a.marginPaise);
    const sum = (k: 'salesPaise' | 'costPaise' | 'marginPaise') => items.reduce((n, i) => n + i[k], 0);
    return { items, salesPaise: sum('salesPaise'), costPaise: sum('costPaise'), marginPaise: sum('marginPaise') };
  },
};
