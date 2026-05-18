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
      httpOnly: true,
      // The frontend is served behind nginx; in production the user is
      // expected to put an HTTPS terminator in front. We only mark `secure`
      // in production builds to keep localhost dev (plain HTTP) working.
      secure: config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout — clears the session cookie. No auth required; clearing
 * an already-invalid cookie is a no-op.
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.status(204).end();
});

export { router as authSessionRouter };
