import { createServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config, isProd } from './config.js';
import { logger } from './logger.js';
import { bearerAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import {
  apiLimiter,
  authLimiter,
  globalAuthLimiter,
  healthLimiter,
} from './middleware/rate-limit.js';
import { closeDb, prisma } from './db/client.js';
import { accountManager } from './minecraft/account-manager.js';
import { accountsRouter } from './routes/accounts.js';
import { authFlowRouter } from './routes/auth-flow.js';
import { authSessionRouter } from './routes/auth-session.js';
import { settingsRouter } from './routes/settings.js';
import { attachWebSocket } from './routes/ws.js';

const app = express();

app.disable('x-powered-by');
// Default to 'loopback' (per config.ts). With nginx on the same docker host
// the real client IP is the localhost peer, so loopback is correct. Operators
// can override TRUST_PROXY via env if they front this with a non-loopback
// reverse proxy.
app.set('trust proxy', config.TRUST_PROXY);

app.use(helmet());
app.use(
  cors({
    origin: config.ALLOWED_ORIGIN,
    // credentials: true is required for the SPA to send the session cookie
    // cross-origin during local dev (Vite at :5173 → backend at :3000).
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);
app.use(cookieParser());
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
        // Strip query string defensively — even though no production path
        // puts tokens in URLs anymore, an old client could.
        const url = typeof req.url === 'string' ? req.url.split('?')[0] : req.url;
        return { method: req.method, url, remoteAddress: req.remoteAddress };
      },
    },
  }),
);

/**
 * Public: liveness probe. Rate-limited so it can't be used to drive DB load.
 */
app.get('/healthz', healthLimiter, async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    logger.error({ err }, 'healthz: db check failed');
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

/**
 * /auth/login and /auth/logout — public (login is the auth gate itself).
 * Aggressively rate-limited per-IP plus a global cap.
 */
const authPublic = express.Router();
authPublic.use(globalAuthLimiter);
authPublic.use(authLimiter);
authPublic.use(authSessionRouter);
app.use('/api/v1/auth', authPublic);

/**
 * All other /api/v1/* routes require auth.
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

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown: received signal');
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
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Production policy: crash fast on unhandled failure so the container
// manager (docker / k8s) restarts us into a clean state. Continuing in a
// half-broken state hides bugs.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
  if (isProd) void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');
  if (isProd) void shutdown('uncaughtException', 1);
});
