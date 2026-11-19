import { notificationsService } from '../modules/notifications/notifications.service.js';
import { ordersService } from '../modules/orders/orders.service.js';
import { schedulingService } from '../modules/scheduling/scheduling.service.js';

/**
 * Background worker: jobs that run on a clock, outside web requests (see docs/mvp-structure.md).
 * Every tick (once a minute):
 *   1. appointment reminders — BOOKED appointments starting within the hour (scheduling module)
 *   2. referral reminders   — referrals still not booked 48 hours on (orders module)
 *   3. outbox               — sends the emails those jobs queued (notifications module)
 * Each job claims its rows in the database, so a restarted worker or a second worker never sends twice.
 * `clock` is injectable so tests can run the worker on a fake clock.
 */
export interface WorkerOptions {
  clock?: () => Date;
  intervalMs?: number;
}

export interface TickResult {
  at: Date;
  appointmentReminders: number;
  referralReminders: number;
  emailsDelivered: number;
}

export function createWorker({ clock = () => new Date(), intervalMs = 60_000 }: WorkerOptions = {}) {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<TickResult | null> | null = null;

  async function runTick(): Promise<TickResult> {
    const at = clock();
    const result: TickResult = { at, appointmentReminders: 0, referralReminders: 0, emailsDelivered: 0 };
    // One job failing (e.g. a DB hiccup) must not stop the others; each logs and the next tick retries.
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`[worker] ${name} failed:`, err instanceof Error ? err.message : err);
      }
    };
    await step('appointment reminders', async () => void (result.appointmentReminders = (await schedulingService.sendDueReminders(at)).queued));
    await step('referral reminders', async () => void (result.referralReminders = (await ordersService.sendReferralReminders(at)).queued));
    await step('outbox', async () => void (result.emailsDelivered = await notificationsService.deliverOutbox(at)));
    return result;
  }

  const api = {
    /** Runs every job once. A tick still running (slow mail server) is not overlapped: the call returns null. */
    async tick(): Promise<TickResult | null> {
      if (running) return null;
      running = runTick().finally(() => (running = null));
      return running;
    },
    start() {
      if (timer) return;
      const loop = async () => {
        const r = await api.tick();
        if (r && (r.appointmentReminders || r.referralReminders || r.emailsDelivered)) {
          console.log(`[worker] ${r.at.toISOString()} reminders: ${r.appointmentReminders} appointment, ${r.referralReminders} referral; emails delivered: ${r.emailsDelivered}`);
        }
      };
      void loop();
      timer = setInterval(() => void loop(), intervalMs);
    },
    /** Stops the clock and waits for a tick in progress to finish. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
  return api;
}
