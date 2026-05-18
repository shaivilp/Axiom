import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AppError, ErrorCodes } from '../types.js';

const expectedToken = Buffer.from(config.DASHBOARD_TOKEN, 'utf8');

function tokensMatch(provided: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf8');
  if (providedBuf.length !== expectedToken.length) {
    // Still do a constant-time compare against a same-length buffer to avoid
    // leaking length info via timing. Result is guaranteed to be false.
    const filler = Buffer.alloc(expectedToken.length);
    timingSafeEqual(filler, expectedToken);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedToken);
}

export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

export function bearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    logger.warn({ ip: req.ip, path: req.path }, 'auth: missing bearer token');
    next(new AppError(ErrorCodes.MISSING_TOKEN, 'Missing Authorization bearer token', 401));
    return;
  }
  if (!tokensMatch(token)) {
    logger.warn({ ip: req.ip, path: req.path }, 'auth: invalid bearer token');
    next(new AppError(ErrorCodes.INVALID_TOKEN, 'Invalid bearer token', 401));
    return;
  }
  next();
}

/**
 * Constant-time check used by WebSocket upgrade handlers (which read the
 * token from a query string instead of a header).
 */
export function verifyToken(provided: string | undefined | null): boolean {
  if (!provided) return false;
  return tokensMatch(provided);
}
