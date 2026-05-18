import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { accountManager } from '../minecraft/account-manager.js';
import {
  clearFlowState,
  getFlowState,
  startDeviceCodeFlow,
} from '../minecraft/auth.js';
import { prisma } from '../db/client.js';
import { AppError, ErrorCodes } from '../types.js';

const router = Router();

const idParamSchema = z.object({ id: z.string().uuid() });

// POST /accounts/:id/auth/start — kick off device code flow.
// Returns { userCode, verificationUri, expiresAt } once Microsoft surfaces them.
router.post('/:id/auth/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const row = await prisma.account.findUnique({ where: { id } });
    if (!row) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    if (row.authType !== 'microsoft') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'Device code auth only applies to microsoft accounts',
        400,
      );
    }
    const code = await startDeviceCodeFlow(id, row.username);
    res.json({ flow: code });
  } catch (err) {
    next(err);
  }
});

// GET /accounts/:id/auth/status — poll for completion
router.get('/:id/auth/status', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const state = getFlowState(id);
    if (!state) {
      res.json({ status: 'idle' });
      return;
    }
    res.json({
      status: state.status,
      userCode: state.userCode ?? null,
      verificationUri: state.verificationUri ?? null,
      expiresAt: state.expiresAt ?? null,
      errorMessage: state.errorMessage ?? null,
      msUsername: state.msUsername ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/auth/complete — finalize: starts the bot now that
// tokens are cached. Caller is expected to poll status until success first.
router.post('/:id/auth/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const state = getFlowState(id);
    if (!state || state.status !== 'success') {
      throw new AppError(
        ErrorCodes.AUTH_PENDING,
        'Device code flow has not completed successfully yet',
        409,
      );
    }
    // If the MS profile name differs from the placeholder we stored, update it.
    if (state.msUsername) {
      await prisma.account.update({
        where: { id },
        data: { username: state.msUsername },
      });
    }
    clearFlowState(id);
    // markAccountRunning sets desiredState='running' AND starts the bot.
    // For MS accounts this is what flips them off the "stopped until
    // device-code complete" hold set at creation time.
    const summary = await accountManager.markAccountRunning(id);
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

export { router as authFlowRouter };
