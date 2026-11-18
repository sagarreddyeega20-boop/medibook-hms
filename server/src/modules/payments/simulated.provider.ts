import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { signWebhook, webhookSignatureOk, type PaymentProvider, type WebhookEvent } from './provider.js';

/**
 * Simulated gateway, as in MediBook v1: no money moves.
 * UPI ID fail@upi or a card ending 0002 is declined; anything else is captured after PAYMENT_SIM_DELAY_MS.
 * Like a real gateway it answers through a signed webhook, delivered in-process to the same handler that serves
 * POST /api/payments/webhook/simulated.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'SIMULATED';

  constructor(private readonly deliver: (body: WebhookEvent, signature: string) => Promise<void>) {}

  async createOrder() {
    return { providerOrderId: `sim_order_${randomBytes(8).toString('hex')}` };
  }

  async confirm(input: Parameters<PaymentProvider['confirm']>[0]) {
    const { instrument } = input;
    const declined =
      instrument.method === 'UPI' && instrument.upiId?.trim().toLowerCase() === 'fail@upi'
        ? 'The UPI payment was declined by your bank (test ID fail@upi).'
        : instrument.method === 'CARD' && instrument.last4 === '0002'
          ? 'Your card was declined by the issuing bank (test card ending 0002).'
          : null;
    const event: WebhookEvent = {
      type: declined ? 'payment.failed' : 'payment.captured',
      providerOrderId: input.providerOrderId,
      providerPaymentId: `sim_pay_${randomBytes(8).toString('hex')}`,
      amountPaise: input.amountPaise,
      ...(declined ? { error: declined } : {}),
    };
    const t = setTimeout(() => {
      this.deliver(event, signWebhook(event)).catch((err) => console.error('[payments] simulated webhook failed:', err instanceof Error ? err.message : err));
    }, env.PAYMENT_SIM_DELAY_MS);
    t.unref();
  }

  async refund() {
    return { providerRefundId: `sim_rfnd_${randomBytes(8).toString('hex')}` };
  }

  verifyWebhook(body: unknown, signature: string | undefined): WebhookEvent {
    if (!webhookSignatureOk(body, signature)) throw new AppError(401, 'BAD_SIGNATURE', 'Webhook signature does not match');
    return body as WebhookEvent;
  }
}
