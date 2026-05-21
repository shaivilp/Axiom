import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sessionCookieName, validateCredential } from '../middleware/auth.js';
import { AppError, ErrorCodes } from '../types.js';

const router = Router();

const loginSchema = z.object({
  token: z.string().min(1).max(512),
});

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The session cookie is marked `Secure` only when the dashboard is actually
 * served over HTTPS. We key off the scheme of ALLOWED_ORIGIN (the operator's
 * declared dashboard URL) rather than NODE_ENV:
 *
 *   - http://...  (LAN / no TLS terminator)  → Secure=false, cookie works
 *   - https://... (TLS terminator in front)  → Secure=true, hardened
 *
 * A `Secure` cookie is silently dropped by browsers over plain HTTP, which
 * would break login on a typical self-hosted LAN deployment. This ties the
 * flag to reality with a single source of truth.
 */
const cookieSecure = config.ALLOWED_ORIGIN.startsWith('https://');

const baseCookieOptions = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'strict' as const,
  path: '/',
};

/**
 * POST /auth/login — body { token } — validates the dashboard token and
 * sets the HttpOnly session cookie. Replaces the prior localStorage flow.
 */
router.post('/login', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = loginSchema.parse(req.body);
    if (!validateCredential(token)) {
      logger.warn({ ip: req.ip }, 'auth/login: invalid token');
      throw new AppError(ErrorCodes.INVALID_TOKEN, 'Invalid token', 401);
    }
    res.cookie(sessionCookieName, token, {
      ...baseCookieOptions,
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout — clears the session cookie. No auth required; clearing
 * an already-invalid cookie is a no-op. Cookie attributes must match the
 * ones used at set time for the clear to take effect.
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(sessionCookieName, baseCookieOptions);
  res.status(204).end();
});

export { router as authSessionRouter };
