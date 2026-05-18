import { pino } from 'pino';
import { config, isDev } from './config.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Strip URL query strings entirely — they may contain leaked tokens
  // from older clients or other paths the request serializer touches.
  'req.url',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.encryptionKey',
  'DASHBOARD_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'POSTGRES_PASSWORD',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
