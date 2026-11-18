import { api } from './api';

/** Billing / accounts API types and calls (server: /api/billing, /api/accounts). Money is integer paise. */

/** CASH / UPI / CARD at the counter; UPI / CARD / NETBANKING / WALLET online (prepaid bookings). */
export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET';
export const METHOD_LABELS: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', NETBANKING: 'Net banking', WALLET: 'Wallet' };
export type PaymentChannel = 'COUNTER' | 'ONLINE';
export const CHANNEL_LABELS: Record<PaymentChannel, string> = { COUNTER: 'At the counter', ONLINE: 'Online (prepaid bookings)' };

export interface PatientRef { id: string; name: string; mrn: string }
export interface VisitHeader { id: string; visitNumber: string; type: string; startedAt: string; department: string; doctor: string }

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  visitId: string | null;
  /** Prepaid online booking: the bill was created at booking and joins the visit at check-in. */
  appointmentId: string | null;
  patientId: string;
  status: string;
  issuedAt: string | null;
  createdAt: string;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  /** Paid in advance online (the consultation of a prepaid booking). */
  paidOnlinePaise: number;
  visit: VisitHeader | null;
  patient: PatientRef | null;
}

export interface InvoiceLine {
  id: string;
  description: string;
  department: { code: string; name: string };
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  totalPaise: number;
  taxPercent: number;
  taxPaise: number;
  /** The prepaid consultation: shown as "Paid online", never collected again. */
  paidOnline: boolean;
}

export interface InvoiceDetail extends InvoiceSummary {
  lines: InvoiceLine[];
  payments: { paymentId: string; receiptNumber: string; method: PaymentMethod; channel: PaymentChannel; receivedAt: string; amountPaise: number }[];
  refunds: { id: string; amountPaise: number; status: string; reason: string; createdAt: string }[];
}

export interface Receipt {
  id: string;
  receiptNumber: string;
  method: PaymentMethod;
  channel: PaymentChannel;
  provider: string | null;
  last4: string | null;
  status: string;
  amountPaise: number;
  reference: string | null;
  receivedAt: string;
  receivedBy: { name: string; staffCode: string } | null;
  patient: PatientRef | null;
  allocations: { invoiceId: string; invoiceNumber: string; amountPaise: number; invoiceTotalPaise: number; invoiceBalancePaise: number; invoiceStatus: string; visit: VisitHeader | null }[];
  refunds: { id: string; invoiceId: string | null; amountPaise: number; status: string; reason: string; createdAt: string }[];
  refundedPaise: number;
}

export interface Refund {
  id: string;
  paymentId: string;
  invoiceId: string | null;
  amountPaise: number;
  method: PaymentMethod;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REFUNDED';
  decisionNote: string | null;
  createdAt: string;
  processedAt: string | null;
  receiptNumber: string;
  invoiceNumber: string | null;
  patient: PatientRef | null;
  requestedBy: string | null;
  decidedBy: string | null;
}

export interface MethodTotals { method: PaymentMethod; receivedPaise: number; refundedPaise: number; expectedPaise: number }

export interface Counter {
  date: string;
  stats: { collectedTodayPaise: number; receiptsToday: number; unpaidInvoices: number; outstandingPaise: number; pendingRefunds: number };
  methods: MethodTotals[];
  unpaid: InvoiceSummary[];
  receipts: Receipt[];
  reconciled: { id: string; differencePaise: number } | null;
}

export interface PatientAccount {
  patient: PatientRef & { phone: string | null; email: string | null; dateOfBirth: string | null; gender: string };
  invoices: InvoiceSummary[];
  payments: Receipt[];
  outstandingPaise: number;
}

export interface Reconciliation {
  id: string;
  businessDate: string;
  expectedCashPaise: number;
  expectedUpiPaise: number;
  expectedCardPaise: number;
  countedCashPaise: number;
  differencePaise: number;
  paymentCount: number;
  note: string | null;
  createdAt: string;
  closedBy: { fullName: string; staffCode: string };
}

export interface DayClose {
  date: string;
  methods: MethodTotals[];
  paymentCount: number;
  refundCount: number;
  reconciliation: Reconciliation | null;
  recent: Reconciliation[];
}

export interface AccountsDashboard {
  range: { from: string; to: string; days: number };
  totals: { billedPaise: number; taxBilledPaise: number; receivedPaise: number; refundedPaise: number; netCollectedPaise: number; transactions: number };
  revenueByDepartment: { departmentId: string; code: string; name: string; kind: string | null; revenuePaise: number; charges: number; sharePercent: number }[];
  trend: { date: string; billedPaise: number; collectedPaise: number }[];
  methods: { method: PaymentMethod; amountPaise: number; count: number }[];
  channels: { channel: PaymentChannel; amountPaise: number; count: number }[];
  pharmacy: { salesPaise: number; costPaise: number; marginPaise: number; marginPercent: number; items: { medicineId: string; name: string; quantity: number; salesPaise: number; marginPaise: number }[] };
  visits: { appointments: number; walkIns: number; total: number; byDepartment: { departmentId: string; name: string; code: string; visits: number }[] };
  patients: { seen: number; new: number };
  transactions: { id: string; receiptNumber: string; receivedAt: string; method: PaymentMethod; channel: PaymentChannel; provider: string | null; status: string; amountPaise: number; reference: string | null; refundedPaise: number; patient: PatientRef | null; receivedBy: string | null; invoices: string[] }[];
  refunds: { requested: { amountPaise: number; count: number }; approved: { amountPaise: number; count: number }; rejected: { amountPaise: number; count: number }; refunded: { amountPaise: number; count: number }; list: Refund[] };
}

/** A fresh key per payment attempt; a retry of the same attempt reuses it, so the server never records it twice. */
export const newIdempotencyKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

/** Opens a PDF from the API in a new tab (the browser's viewer prints or saves it). */
export const openPdf = (url: string) => window.open(url, '_blank', 'noopener');

export const billingApi = {
  counter: () => api<Counter>('/api/billing/counter'),
  searchPatients: (q: string) => api<{ patients: (PatientRef & { phone: string | null; unpaidInvoices: number; outstandingPaise: number })[] }>(`/api/billing/patients?q=${encodeURIComponent(q)}`).then((r) => r.patients),
  patient: (id: string) => api<PatientAccount>(`/api/billing/patients/${id}`),
  invoice: (id: string) => api<{ invoice: InvoiceDetail }>(`/api/billing/invoices/${id}`).then((r) => r.invoice),
  pay: (body: { patientId: string; method: PaymentMethod; reference?: string | null; idempotencyKey: string; allocations: { invoiceId: string; amountPaise: number }[] }) =>
    api<{ payment: Receipt; replayed: boolean }>('/api/billing/payments', { json: body }),
  requestRefund: (body: { paymentId: string; invoiceId: string; amountPaise: number; reason: string }) => api<{ refund: Refund }>('/api/billing/refunds', { json: body }).then((r) => r.refund),
  refunds: (status?: string) => api<{ refunds: Refund[] }>(`/api/billing/refunds${status ? `?status=${status}` : ''}`).then((r) => r.refunds),
  decideRefund: (id: string, decision: 'approve' | 'reject', note: string | null) => api<{ refund: Refund }>(`/api/billing/refunds/${id}/${decision}`, { json: { note } }).then((r) => r.refund),
  dayClose: (date?: string) => api<DayClose>(`/api/billing/reconciliation${date ? `?date=${date}` : ''}`),
  closeDay: (body: { date: string; countedCashPaise: number; note?: string | null }) => api<{ reconciliation: Reconciliation }>('/api/billing/reconciliation', { json: body }).then((r) => r.reconciliation),
  mine: () => api<{ invoices: InvoiceSummary[]; payments: Receipt[] }>('/api/billing/me'),
  accounts: (from: string, to: string) => api<AccountsDashboard>(`/api/accounts/dashboard?from=${from}&to=${to}`),
};

/** "1,234.50" typed at the counter → 123450 paise; null when it is not a valid amount. */
export function rupeesInputToPaise(s: string): number | null {
  const t = s.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
export const paiseToInput = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));
