import { PdfDoc } from '../../lib/pdf.js';
import type { billingService, Receipt } from './billing.service.js';

/**
 * Printable invoice and receipt PDFs (counter "Print receipt" and the patient portal download).
 * Colours mirror web/src/theme/tokens.css (--primary, --text, --muted, --border, --table-head).
 */
const C = { primary: '#0F766E', text: '#1E293B', muted: '#64748B', border: '#E2E8F0', head: '#F8FAFC', soft: '#E6F7F3' };
const HOSPITAL = 'MediBook Hospital';
const M = 48; // page margin
type Invoice = Awaited<ReturnType<typeof billingService.invoice>>;

const rupees = (paise: number) =>
  `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100)}`;
const when = (d: Date | string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
const title = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function header(doc: PdfDoc, kind: string, number: string) {
  doc.rect(M, M, 30, 30, C.primary).text(M + 15, M + 6, '+', { size: 18, bold: true, color: '#FFFFFF', align: 'center' });
  doc.text(M + 40, M + 2, HOSPITAL, { size: 16, bold: true });
  doc.text(M + 40, M + 21, 'Outpatient billing', { size: 9, color: C.muted });
  doc.text(doc.width - M, M + 2, kind, { size: 14, bold: true, color: C.primary, align: 'right' });
  doc.text(doc.width - M, M + 21, number, { size: 10, align: 'right' });
  doc.line(M, M + 44, doc.width - M, M + 44, C.border, 1);
  return M + 60;
}

function keyValues(doc: PdfDoc, y: number, cols: [string, string][][]) {
  const colW = (doc.width - 2 * M) / cols.length;
  let maxY = y;
  cols.forEach((rows, i) => {
    let yy = y;
    for (const [k, v] of rows) {
      doc.text(M + i * colW, yy, k, { size: 8, color: C.muted });
      doc.text(M + i * colW, yy + 10, doc.fit(v, colW - 12, 10, true), { size: 10, bold: true });
      yy += 28;
    }
    maxY = Math.max(maxY, yy);
  });
  return maxY + 4;
}

interface Col { label: string; x: number; align?: 'left' | 'right'; width?: number }

function table(doc: PdfDoc, y: number, cols: Col[], rows: string[][]) {
  doc.rect(M, y, doc.width - 2 * M, 22, C.head);
  for (const c of cols) doc.text(c.x, y + 7, c.label, { size: 8, bold: true, color: C.muted, align: c.align });
  y += 22;
  for (const r of rows) {
    if (y > doc.height - 120) {
      doc.addPage();
      y = M;
    }
    cols.forEach((c, i) => doc.text(c.x, y + 8, c.width ? doc.fit(r[i] ?? '', c.width) : r[i] ?? '', { size: 9.5, align: c.align }));
    y += 26;
    doc.line(M, y, doc.width - M, y, C.border);
  }
  return y + 12;
}

function totals(doc: PdfDoc, y: number, rows: { label: string; value: string; strong?: boolean }[]) {
  const right = doc.width - M;
  for (const r of rows) {
    if (r.strong) doc.line(right - 220, y - 4, right, y - 4, C.border, 1, true);
    doc.text(right - 220, y, r.label, { size: r.strong ? 11 : 9.5, bold: r.strong, color: r.strong ? C.text : C.muted });
    doc.text(right, y, r.value, { size: r.strong ? 11 : 9.5, bold: r.strong, align: 'right' });
    y += r.strong ? 22 : 17;
  }
  return y + 8;
}

function footer(doc: PdfDoc, note: string) {
  doc.line(M, doc.height - 64, doc.width - M, doc.height - 64, C.border);
  doc.text(M, doc.height - 56, note, { size: 8, color: C.muted });
  doc.text(M, doc.height - 44, `Generated ${when(new Date())} IST. Computer-generated document; no signature required.`, { size: 8, color: C.muted });
}

export function invoicePdf(inv: Invoice): Buffer {
  const doc = new PdfDoc();
  let y = header(doc, 'TAX INVOICE', inv.invoiceNumber);
  y = keyValues(doc, y, [
    [['Patient', inv.patient?.name ?? '-'], ['Patient ID (MRN)', inv.patient?.mrn ?? '-']],
    [['Visit', inv.visit ? `${inv.visit.visitNumber} · ${inv.visit.type === 'WALK_IN' ? 'Walk-in' : 'Appointment'}` : '-'], ['Doctor', inv.visit ? `${inv.visit.doctor} (${inv.visit.department})` : '-']],
    [['Invoice date', when(inv.issuedAt ?? inv.createdAt)], ['Status', title(inv.status)]],
  ]);
  const right = doc.width - M;
  y = table(
    doc,
    y,
    [
      { label: 'DESCRIPTION', x: M + 8, width: 210 },
      { label: 'DEPARTMENT', x: M + 228, width: 100 },
      { label: 'QTY', x: right - 205, align: 'right' },
      { label: 'RATE', x: right - 145, align: 'right' },
      { label: 'TAX', x: right - 82, align: 'right' },
      { label: 'AMOUNT', x: right - 8, align: 'right' },
    ],
    inv.lines.map((l) => [
      l.description,
      l.department.name,
      String(l.quantity),
      rupees(l.unitPricePaise),
      l.taxPercent ? `${l.taxPercent}%` : '-',
      rupees(l.totalPaise + l.taxPaise),
    ]),
  );
  y = totals(doc, y, [
    { label: 'Subtotal', value: rupees(inv.subtotalPaise) },
    ...(inv.discountPaise ? [{ label: 'Discount', value: `- ${rupees(inv.discountPaise)}` }] : []),
    { label: 'Tax (GST)', value: rupees(inv.taxPaise) },
    { label: 'Total', value: rupees(inv.totalPaise), strong: true },
    { label: 'Paid', value: rupees(inv.paidPaise) },
    { label: 'Balance due', value: rupees(inv.balancePaise), strong: true },
  ]);
  if (inv.payments.length) {
    doc.text(M, y, 'Payments', { size: 11, bold: true });
    y = table(
      doc,
      y + 18,
      [
        { label: 'RECEIPT', x: M + 8 },
        { label: 'DATE', x: M + 160 },
        { label: 'METHOD', x: M + 330 },
        { label: 'AMOUNT', x: right - 8, align: 'right' },
      ],
      inv.payments.map((p) => [p.receiptNumber, when(p.receivedAt), p.method, rupees(p.amountPaise)]),
    );
  }
  footer(doc, 'Consultations, tests and scans are exempt from GST; medicines are taxed at the rate shown per line.');
  return doc.toBuffer();
}

export function receiptPdf(r: Receipt): Buffer {
  const doc = new PdfDoc();
  let y = header(doc, 'PAYMENT RECEIPT', r.receiptNumber);
  doc.rect(M, y, doc.width - 2 * M, 58, C.soft);
  doc.text(M + 16, y + 12, 'Amount received', { size: 9, color: C.muted });
  doc.text(M + 16, y + 26, rupees(r.amountPaise), { size: 20, bold: true, color: C.primary });
  doc.text(doc.width - M - 16, y + 12, 'Paid by', { size: 9, color: C.muted, align: 'right' });
  doc.text(doc.width - M - 16, y + 28, `${title(r.method)}${r.reference ? ` · ${r.reference}` : ''}`, { size: 12, bold: true, align: 'right' });
  y += 74;
  y = keyValues(doc, y, [
    [['Received from', r.patient?.name ?? '-'], ['Patient ID (MRN)', r.patient?.mrn ?? '-']],
    [['Date', when(r.receivedAt)], ['Received by', r.receivedBy ? `${r.receivedBy.name} (${r.receivedBy.staffCode})` : r.channel === 'ONLINE' ? `Paid online${r.provider ? ` · ${r.provider}` : ''}${r.last4 ? ` ···· ${r.last4}` : ''}` : '-']],
  ]);
  const right = doc.width - M;
  doc.text(M, y, 'Applied to', { size: 11, bold: true });
  y = table(
    doc,
    y + 18,
    [
      { label: 'INVOICE', x: M + 8 },
      { label: 'VISIT', x: M + 150, width: 170 },
      { label: 'APPLIED', x: right - 110, align: 'right' },
      { label: 'BALANCE NOW', x: right - 8, align: 'right' },
    ],
    r.allocations.map((a) => [a.invoiceNumber, a.visit ? `${a.visit.visitNumber} · ${a.visit.department}` : '-', rupees(a.amountPaise), rupees(a.invoiceBalancePaise)]),
  );
  if (r.refunds.length) {
    doc.text(M, y, 'Refunds', { size: 11, bold: true });
    y = table(
      doc,
      y + 18,
      [
        { label: 'REQUESTED', x: M + 8 },
        { label: 'REASON', x: M + 150, width: 200 },
        { label: 'STATUS', x: M + 370 },
        { label: 'AMOUNT', x: right - 8, align: 'right' },
      ],
      r.refunds.map((x) => [when(x.createdAt), x.reason, title(x.status), rupees(x.amountPaise)]),
    );
  }
  footer(doc, 'Keep this receipt for your records. Refunds are returned by the original payment method once approved.');
  return doc.toBuffer();
}
