import { pino } from 'pino';
import { config, isDev } from './config.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
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
