import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { env } from '../../config/env.js';

/**
 * Payment gateway abstraction. Booking and billing never talk to a gateway directly: the payments service calls a
 * PaymentProvider, and the gateway's answer arrives as a signed webhook event. Adding Razorpay (test mode) later means
 * writing a RazorpayProvider with these four methods and selecting it with PAYMENT_PROVIDER — nothing else changes.
 */

/** What the patient chose. Card numbers never reach the server: only the brand and the last 4 digits. */
export interface Instrument {
  method: Extract<PaymentMethod, 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET'>;
  /** UPI app, card brand, bank or wallet name, e.g. "Google Pay", "Visa", "HDFC Bank", "Paytm". */
  provider: string;
  /** UPI only, used by the gateway and never stored. */
  upiId?: string;
  /** Card only. */
  last4?: string;
}

export interface WebhookEvent {
  type: 'payment.captured' | 'payment.failed';
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: number;
  error?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Registers the amount with the gateway before the patient pays. */
  createOrder(input: { orderId: string; amountPaise: number }): Promise<{ providerOrderId: string }>;
  /** Starts the payment. The outcome arrives later through the webhook, never in this response. */
  confirm(input: { providerOrderId: string; amountPaise: number; instrument: Instrument }): Promise<void>;
  /** Refunds a captured payment in full. */
  refund(input: { providerPaymentId: string; amountPaise: number; reason: string }): Promise<{ providerRefundId: string }>;
  /** Checks the webhook signature and returns the event; throws if it is not genuine. */
  verifyWebhook(body: unknown, signature: string | undefined): WebhookEvent;
}

/* ---------------- Webhook signing (HMAC-SHA256 over the JSON body) ---------------- */

const secret = () => env.PAYMENT_WEBHOOK_SECRET || createHmac('sha256', env.JWT_SECRET).update('payment-webhook').digest('hex');

export const signWebhook = (body: unknown) => createHmac('sha256', secret()).update(JSON.stringify(body)).digest('hex');

export function webhookSignatureOk(body: unknown, signature: string | undefined) {
  if (!signature) return false;
  const want = Buffer.from(signWebhook(body), 'hex');
  const got = Buffer.from(signature, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
