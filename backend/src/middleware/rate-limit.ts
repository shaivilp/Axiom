import rateLimit from 'express-rate-limit';
import { logger } from '../logger.js';
import { ErrorCodes } from '../types.js';

/**
 * Aggressive limiter for endpoints that perform auth checks. Brute-forcing the
 * single shared dashboard token has to be impractical even on a fast LAN.
 */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many auth attempts' } },
  handler: (req, res, _next, options) => {
    logger.warn({ ip: req.ip, path: req.path }, 'rate-limit: auth attempts exceeded');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Lighter limiter for general API calls so a runaway frontend can't DoS the
 * backend. The dashboard is single-user, so this is generous.
 */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests' } },
});
