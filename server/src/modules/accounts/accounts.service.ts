import { AppError } from '../../lib/errors.js';
import { addDays, localDateKey, localMidnight } from '../../lib/time.js';
import { billingService } from '../billing/billing.service.js';
import { patientsService } from '../patients/patients.service.js';
import { pharmacyService } from '../pharmacy/pharmacy.service.js';
import { staffService } from '../staff/staff.service.js';
import { visitsService } from '../visits/visits.service.js';

/**
 * Accounts service — Read-only reports: revenue by department, pharmacy margin, counts, transactions by date. Reads through other modules' services.
 * Owns: (no tables; read-only aggregation)
 * Other modules must call this service, never these tables directly.
 *
 * No clinical data leaves this module: departments, counts, amounts, receipt numbers and patient name/MRN only —
 * never diagnoses, notes, results or the line items of a bill.
 */

export const MAX_RANGE_DAYS = 366;

/** Inclusive local dates [from, to] → UTC instants [start, end). */
export function rangeOf(from: string, to: string) {
  if (from > to) throw AppError.badRequest('The start date must be on or before the end date');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) throw AppError.badRequest('Choose a range of at most one year');
  return { from, to, days, start: localMidnight(from), end: localMidnight(addDays(to, 1)) };
}

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote everything; neutralise spreadsheet formulas (=, +, -, @) in text cells.
  // Plain numbers such as a refund's "-100.00" stay numeric so spreadsheets can sum them.
  const isNumber = /^-?\d+(\.\d+)?$/.test(s);
  const safe = typeof v === 'string' && !isNumber && /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
const rupees = (paise: number) => (paise / 100).toFixed(2);
const istStamp = (d: Date) => {
  const local = new Date(d.getTime() + 330 * 60_000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
};

export const accountsService = {
  async dashboard(fromKey: string, toKey: string) {
    const r = rangeOf(fromKey, toKey);
    const [revenue, daily, collections, pharmacy, visits, newPatients, transactions, refunds] = await Promise.all([
      billingService.revenueByDepartment(r.start, r.end),
      billingService.dailyRevenue(r.start, r.end),
      billingService.collections(r.start, r.end),
      pharmacyService.margin(r.start, r.end),
      visitsService.statsBetween(r.start, r.end),
      patientsService.countRegisteredBetween(r.start, r.end),
      billingService.transactions(r.start, r.end, 200),
      billingService.refunds({ from: r.start, to: r.end }),
    ]);
    const depts = await staffService.departmentsByIds(visits.byDepartment.map((d) => d.departmentId));

    const trend: { date: string; billedPaise: number; collectedPaise: number }[] = [];
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
      trend.push({ date: d, billedPaise: daily.billed.get(d) ?? 0, collectedPaise: (daily.received.get(d) ?? 0) - (daily.refunded.get(d) ?? 0) });
    }

    const billedPaise = revenue.reduce((n, d) => n + d.revenuePaise, 0);
    const receivedPaise = collections.methods.reduce((n, m) => n + m.amountPaise, 0);
    const refundedPaise = collections.refunds.APPROVED?.amountPaise ?? 0;
    const appointments = visits.byType.OPD ?? 0;
    const walkIns = visits.byType.WALK_IN ?? 0;

    return {
      range: { from: r.from, to: r.to, days: r.days },
      totals: {
        billedPaise,
        taxBilledPaise: collections.taxBilledPaise,
        receivedPaise,
        refundedPaise,
        netCollectedPaise: receivedPaise - refundedPaise,
        transactions: collections.methods.reduce((n, m) => n + m.count, 0),
      },
      revenueByDepartment: revenue.map((d) => ({ ...d, sharePercent: billedPaise ? Math.round((d.revenuePaise / billedPaise) * 1000) / 10 : 0 })),
      trend,
      methods: collections.methods,
      pharmacy: { salesPaise: pharmacy.salesPaise, costPaise: pharmacy.costPaise, marginPaise: pharmacy.marginPaise, marginPercent: pharmacy.salesPaise ? Math.round((pharmacy.marginPaise / pharmacy.salesPaise) * 1000) / 10 : 0, items: pharmacy.items.slice(0, 8) },
      visits: {
        appointments,
        walkIns,
        total: appointments + walkIns + (visits.byType.IPD ?? 0) + (visits.byType.EMERGENCY ?? 0),
        byDepartment: visits.byDepartment
          .map((d) => ({ departmentId: d.departmentId, name: depts.get(d.departmentId)?.name ?? 'Unknown', code: depts.get(d.departmentId)?.code ?? '?', visits: d.visits }))
          .sort((a, b) => b.visits - a.visits),
      },
      patients: { seen: visits.patientsSeen, new: newPatients },
      transactions,
      refunds: {
        requested: collections.refunds.REQUESTED ?? { amountPaise: 0, count: 0 },
        approved: collections.refunds.APPROVED ?? { amountPaise: 0, count: 0 },
        rejected: collections.refunds.REJECTED ?? { amountPaise: 0, count: 0 },
        list: refunds,
      },
    };
  },

  /** Transactions (payments and approved refunds) in the range as CSV, amounts in rupees. */
  async transactionsCsv(fromKey: string, toKey: string) {
    const r = rangeOf(fromKey, toKey);
    const [payments, refunds] = await Promise.all([
      billingService.transactions(r.start, r.end, 50_000),
      billingService.refunds({ from: r.start, to: r.end, take: 50_000 }),
    ]);
    const rows: (string | number | null)[][] = [
      ['Date (IST)', 'Type', 'Receipt', 'Patient', 'Patient ID', 'Method', 'Reference', 'Invoices', 'Amount (INR)', 'Status', 'Recorded by'],
      ...payments.map((p) => [istStamp(p.receivedAt), 'Payment', p.receiptNumber, p.patient?.name ?? '', p.patient?.mrn ?? '', p.method, p.reference, p.invoices.join(' '), rupees(p.amountPaise), p.status, p.receivedBy]),
      ...refunds.map((x) => [istStamp(x.processedAt ?? x.createdAt), 'Refund', x.receiptNumber, x.patient?.name ?? '', x.patient?.mrn ?? '', x.method, x.reason, x.invoiceNumber ?? '', rupees(-x.amountPaise), x.status, x.decidedBy ?? x.requestedBy]),
    ];
    return { filename: `medibook-transactions-${r.from}-to-${r.to}.csv`, csv: `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`, count: rows.length - 1 };
  },

  today: () => localDateKey(),
};
