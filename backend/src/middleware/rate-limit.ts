import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// Default IP-based key. We rely on express's `trust proxy` config (set in
// index.ts) to make `req.ip` the real client IP behind nginx.
const ipKey = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';
import { logger } from '../logger.js';
import { ErrorCodes } from '../types.js';

/**
 * Per-IP limiter for endpoints that perform auth checks. Brute-forcing the
 * shared dashboard token has to be impractical even on a fast LAN.
 */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Use the library's IP keyGenerator which respects `trust proxy` and
  // normalizes IPv6/IPv4-mapped addresses correctly.
  keyGenerator: ipKey,
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many auth attempts' } },
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'rate-limit: auth attempts exceeded');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Process-global limiter on auth endpoints — bounds brute force even when
 * an attacker rotates source IPs. Set to 200/min, well above any legitimate
 * single-user dashboard pattern (UI hits these endpoints ~once per page load).
 */
export const globalAuthLimiter = rateLimit({
  windowMs: 60_000,
  limit: 200,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => 'global',
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Service is busy' } },
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'rate-limit: global auth threshold tripped');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Lighter limiter for general API calls so a runaway frontend can't DoS
 * the backend. Generous because the dashboard is single-user.
 */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests' } },
});

/**
 * Healthcheck limiter — keeps an attacker on the docker network from
 * driving DB load via the unauthenticated /healthz endpoint.
 */
export const healthLimiter = rateLimit({
  windowMs: 10_000,
  limit: 30,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many healthchecks' } },
});
