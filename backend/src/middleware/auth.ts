import { timingSafeEqual, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AppError, ErrorCodes } from '../types.js';

/**
 * Authentication: single shared dashboard token, accepted from either an
 * HttpOnly cookie (`afkbot_session`) or an `Authorization: Bearer …` header.
 *
 * Cookies are the primary path for the browser SPA — HttpOnly defeats XSS
 * exfiltration. The bearer fallback is preserved so curl / scripts can
 * still hit the API without a login dance.
 *
 * Token comparison: SHA-256 both sides first so the timing-safe compare
 * runs on fixed-length 32-byte digests (hides token length entirely) and
 * is unaffected by encoding differences.
 */
const SESSION_COOKIE = 'afkbot_session';

const expectedDigest = createHash('sha256').update(config.DASHBOARD_TOKEN, 'utf8').digest();

function tokensMatch(provided: string): boolean {
  if (!provided) return false;
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  // Both buffers are exactly 32 bytes (sha256 digest), so timingSafeEqual is safe.
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

export function extractSessionCookie(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string | undefined> }).cookies;
  const v = cookies?.[SESSION_COOKIE];
  return v ?? null;
}

/**
 * Express middleware: cookie OR bearer must validate.
 */
export function bearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const provided = extractSessionCookie(req) ?? extractBearerToken(req);
  if (!provided) {
    logger.warn({ ip: req.ip, path: req.path }, 'auth: missing credentials');
    next(new AppError(ErrorCodes.MISSING_TOKEN, 'Authentication required', 401));
    return;
  }
  if (!tokensMatch(provided)) {
    logger.warn({ ip: req.ip, path: req.path }, 'auth: invalid credentials');
    next(new AppError(ErrorCodes.INVALID_TOKEN, 'Invalid credentials', 401));
    return;
  }
  next();
}

/**
 * WebSocket upgrade auth: cookie first (browsers send it on `Sec-WebSocket-…`
 * upgrades automatically), bearer header second. The legacy `?token=` query
 * parameter is intentionally NOT supported — it leaks the token into nginx
 * access logs on every reconnect.
 */
export function verifyUpgradeAuth(headers: Record<string, string | string[] | undefined>): boolean {
  // Parse cookie header (we don't have access to cookie-parser here)
  const cookieHeader = headers.cookie;
  if (typeof cookieHeader === 'string') {
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
    if (match?.[1] && tokensMatch(decodeURIComponent(match[1]))) return true;
  }
  // Bearer fallback for non-browser clients.
  const authHeader = headers.authorization;
  if (typeof authHeader === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (m?.[1] && tokensMatch(m[1].trim())) return true;
  }
  return false;
}

/**
 * Helpers used by the /auth/login + /auth/logout routes.
 */
export const sessionCookieName = SESSION_COOKIE;
export function validateCredential(token: string): boolean {
  return tokensMatch(token);
}
