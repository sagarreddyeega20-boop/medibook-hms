/**
 * Online prepayment of the consultation (payment page, chatbot "Pay now").
 * The server decides the outcome through its gateway's webhook; this page only polls the order.
 * Card numbers stay in the browser: the server receives the brand and the last 4 digits only.
 */
import { api } from './api';
import type { Appointment } from './booking';

export type OrderStatus = 'CREATED' | 'PROCESSING' | 'FAILED' | 'PAID' | 'EXPIRED';

export interface Checkout {
  holdId: string;
  slotStart: string;
  slotEnd: string;
  holdExpiresAt: string;
  doctor: { id: string; name: string; specialty: string | null; department: string | null };
  patient: { id: string; name: string; mrn: string };
  fee: { label: string; amountPaise: number } | null;
}

export interface Order {
  id: string;
  status: OrderStatus;
  amountPaise: number;
  attempts: number;
  method: string | null;
  instrument: string | null;
  last4: string | null;
  failureReason: string | null;
  slotStart: string;
  holdExpiresAt: string | null;
  doctor: Checkout['doctor'];
  patient: Checkout['patient'];
  appointment: Appointment | null;
  receipt: { paymentId: string; receiptNumber: string; transactionId: string | null; paidAt: string; method: string; provider: string | null; last4: string | null } | null;
}

export type Instrument =
  | { method: 'UPI'; provider: string; upiId?: string }
  | { method: 'CARD'; provider: CardBrand; last4: string }
  | { method: 'NETBANKING'; provider: string }
  | { method: 'WALLET'; provider: string };

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const paymentsApi = {
  checkout: (holdId: string, patientId: string) =>
    api<{ checkout: Checkout }>(`/api/payments/checkout?${new URLSearchParams({ holdId, patientId })}`).then((r) => r.checkout),
  createOrder: (input: { holdId: string; patientId: string; reason?: string; idempotencyKey: string }) =>
    api<{ order: Order }>('/api/payments/orders', { json: { ...input, reason: input.reason || undefined } }).then((r) => r.order),
  order: (id: string) => api<{ order: Order }>(`/api/payments/orders/${id}`).then((r) => r.order),
  pay: (id: string, instrument: Instrument, idempotencyKey: string) =>
    api<{ order: Order }>(`/api/payments/orders/${id}/pay`, { json: { idempotencyKey, instrument } }).then((r) => r.order),
};

/* ---------- Card checks (as in v1: brand detection + Luhn) ---------- */

export type CardBrand = 'Visa' | 'Mastercard' | 'RuPay';
export const digits = (v: string) => v.replace(/\D/g, '');

export function cardBrand(num: string): CardBrand | null {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(num)) return 'Mastercard';
  if (/^(60|65|81|82|508|353|356)/.test(num)) return 'RuPay';
  return null;
}

/** Luhn checksum — catches most typos in card numbers. */
export function luhn(num: string) {
  let sum = 0;
  let double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return num.length > 0 && sum % 10 === 0;
}

/** 4111111111111111 → "4111 1111 1111 1111" */
export const spaceCard = (v: string) => digits(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');

export function cardErrors(card: { number: string; expiry: string; cvv: string; name: string }, now = new Date()) {
  const num = digits(card.number);
  const errors: Partial<Record<'number' | 'expiry' | 'cvv' | 'name', string>> = {};
  const brand = cardBrand(num);
  if (num.length < 13) errors.number = 'Enter the full card number.';
  else if (!brand) errors.number = 'We accept Visa, Mastercard and RuPay cards.';
  else if (!luhn(num)) errors.number = 'This card number doesn’t look right. Please check it.';
  const m = card.expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m) errors.expiry = 'Enter expiry as MM/YY.';
  else {
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) errors.expiry = 'Month must be 01–12.';
    else if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) errors.expiry = 'This card has expired.';
  }
  if (!/^\d{3}$/.test(card.cvv)) errors.cvv = 'Enter the 3-digit CVV.';
  if (card.name.trim().length < 2) errors.name = 'Enter the name on the card.';
  return { errors, num, brand };
}

export const UPI_ID = /^[\w.-]{2,64}@[a-zA-Z]{2,32}$/;

/* ---------- Add to calendar (.ics) ---------- */

export function downloadIcs(a: { ref: string; slotStart: string; slotEnd: string; doctor: string; department?: string | null; mrn?: string }) {
  const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MediBook//Appointments//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${a.ref}@medibook.local`,
    `DTSTAMP:${utc(new Date().toISOString())}`,
    `DTSTART:${utc(a.slotStart)}`,
    `DTEND:${utc(a.slotEnd)}`,
    `SUMMARY:${esc(`Appointment with ${a.doctor}`)}`,
    `LOCATION:${esc('MediBook Hospital')}`,
    `DESCRIPTION:${esc(`Booking ${a.ref}${a.mrn ? ` · Patient ID ${a.mrn}` : ''}${a.department ? ` · ${a.department}` : ''}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:MediBook appointment in 1 hour', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `medibook-${a.ref}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
