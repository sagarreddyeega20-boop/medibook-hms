import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { corsOrigins } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { moduleRouters } from './modules/index.js';

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'down';
  }
}

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    const [db, cache] = await Promise.all([
      check(() => prisma.$queryRaw`SELECT 1`),
      check(() => redis.ping()),
    ]);
    const ok = db === 'ok' && cache === 'ok';
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      services: { database: db, redis: cache },
      time: new Date().toISOString(),
    });
  });

  for (const [name, router] of Object.entries(moduleRouters)) {
    app.use(`/api/${name}`, router);
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
