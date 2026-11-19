import { describeMailTransport } from '../lib/mailer.js';
import { prisma } from '../lib/prisma.js';
import { createWorker } from './worker.js';

/** Entry point of the separate worker process: `npm run worker` (or `npm run dev:worker`). */
const worker = createWorker();
console.log('MediBook HMS worker started (appointment reminders, referral reminders, email outbox; every minute)');
console.log(describeMailTransport());
worker.start();

async function shutdown(signal: string) {
  console.log(`${signal} received, worker finishing the current tick…`);
  await worker.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
