import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { connectRedis, redis } from './lib/redis.js';
import { initSocket } from './lib/socket.js';
import { socketRooms } from './modules/auth/socket.js';

const app = createApp();
const server = createServer(app);
initSocket(server, socketRooms);

connectRedis().catch((err) => console.error('[redis] initial connect failed:', err.message));

server.listen(env.PORT, () => {
  console.log(`MediBook HMS API listening on http://localhost:${env.PORT} (health: /api/health)`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down…`);
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
