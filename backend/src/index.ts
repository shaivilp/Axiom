import { createServer } from 'node:http';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { bearerAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter, authLimiter } from './middleware/rate-limit.js';
import { closeDb, prisma } from './db/client.js';
import { accountManager } from './minecraft/account-manager.js';
import { accountsRouter } from './routes/accounts.js';
import { authFlowRouter } from './routes/auth-flow.js';
import { settingsRouter } from './routes/settings.js';
import { attachWebSocket } from './routes/ws.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // we expect nginx in front

app.use(helmet());
app.use(
  cors({
    origin: config.ALLOWED_ORIGIN,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);
app.use(express.json({ limit: '64kb' }));
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req(req) {
        return { method: req.method, url: req.url, remoteAddress: req.remoteAddress };
      },
    },
  }),
);

/**
 * Public: liveness probe. No auth, no rate limit — Docker healthcheck uses this.
 */
app.get('/healthz', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    logger.error({ err }, 'healthz: db check failed');
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

/**
 * All /api/* routes go through general rate-limiting first, then the bearer
 * token check. authLimiter is applied to endpoints that may fail auth so
 * brute-force is bounded.
 */
const api = express.Router();
api.use(apiLimiter);
api.use(authLimiter);
api.use(bearerAuth);

api.get('/ping', (_req: Request, res: Response) => {
  res.json({ pong: true, version: '0.1.0' });
});

api.get('/whoami', (req: Request, res: Response) => {
  res.json({
    authenticated: true,
    serverTime: new Date().toISOString(),
    clientIp: req.ip,
  });
});

api.use('/accounts', accountsRouter);
api.use('/accounts', authFlowRouter); // /accounts/:id/auth/*
api.use('/settings', settingsRouter);

app.use('/api/v1', api);

app.use(notFoundHandler);
app.use(errorHandler);

const server = createServer(app);
attachWebSocket(server);

async function bootstrap(): Promise<void> {
  // Bring the prisma client online before we start hydrating accounts.
  await prisma.$connect().catch((err: unknown) => {
    logger.error({ err }, 'prisma: connect failed — continuing, requests will fail until db is up');
  });
  await accountManager.start().catch((err: unknown) => {
    logger.error({ err }, 'account-manager: failed to hydrate from db');
  });

  server.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        nodeEnv: config.NODE_ENV,
        allowedOrigin: config.ALLOWED_ORIGIN,
      },
      'afkbot backend listening',
    );
  });
}

void bootstrap();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutdown: received signal');
  // Stop all bots first so MC sockets are torn down cleanly.
  await accountManager.stop().catch((err) => {
    logger.error({ err }, 'shutdown: account manager stop threw');
  });
  server.close((err) => {
    if (err) logger.error({ err }, 'shutdown: error closing http server');
  });
  try {
    await closeDb();
    logger.info('shutdown: prisma disconnected');
  } catch (err) {
    logger.error({ err }, 'shutdown: error disconnecting prisma');
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');
});
