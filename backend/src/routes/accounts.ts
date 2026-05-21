import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { accountManager } from '../minecraft/account-manager.js';
import { behaviorConfigSchema } from '../minecraft/behaviors/schema.js';
import { AppError, ErrorCodes } from '../types.js';

const router = Router();

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * Single middleware that validates :id and stashes it on the request.
 * Avoids repeating `idParamSchema.parse(req.params)` in every handler.
 * The augmentation of `Request` itself lives in src/express.d.ts.
 */
function withAccountId(req: Request, _res: Response, next: NextFunction): void {
  try {
    const { id } = idParamSchema.parse(req.params);
    req.accountId = id;
    next();
  } catch (err) {
    next(err);
  }
}

const createSchema = z.object({
  label: z.string().min(1).max(64),
  username: z.string().min(1).max(64),
  authType: z.enum(['offline', 'microsoft']),
  serverHost: z.string().min(1).max(253),
  serverPort: z.number().int().min(1).max(65535).default(25565),
  version: z.string().min(1).max(16).default('1.8.9'),
  autoConnect: z.boolean().default(true),
  behaviors: behaviorConfigSchema.optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  serverHost: z.string().min(1).max(253).optional(),
  serverPort: z.number().int().min(1).max(65535).optional(),
  version: z.string().min(1).max(16).optional(),
  autoConnect: z.boolean().optional(),
  behaviors: behaviorConfigSchema.optional(),
});

const chatSchema = z.object({
  // Length-bounded; sanitized (CR/LF stripped) inside the handler.
  message: z.string().min(1).max(256),
});

// GET /accounts — list all
router.get('/', (_req: Request, res: Response) => {
  res.json({ accounts: accountManager.listSummaries() });
});

// POST /accounts — create
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);
    const created = await accountManager.createAccount({
      label: body.label,
      username: body.username,
      authType: body.authType,
      serverHost: body.serverHost,
      serverPort: body.serverPort,
      version: body.version,
      autoConnect: body.autoConnect,
      behaviors: body.behaviors ?? {},
    });
    res.status(201).json({ account: created });
  } catch (err) {
    next(err);
  }
});

// GET /accounts/:id — summary + full behavior config (for the detail view,
// so the behaviors form can be seeded with the account's actual saved values
// rather than defaults).
router.get('/:id', withAccountId, (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = accountManager.getSummary(req.accountId!);
    if (!summary) {
      throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    }
    const behaviors = accountManager.getBehaviors(req.accountId!);
    res.json({ account: summary, behaviors });
  } catch (err) {
    next(err);
  }
});

// PATCH /accounts/:id
router.patch('/:id', withAccountId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const patch = updateSchema.parse(req.body);
    const updated = await accountManager.updateAccount(req.accountId!, patch);
    res.json({ account: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /accounts/:id
router.delete('/:id', withAccountId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await accountManager.deleteAccount(req.accountId!);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/start
router.post('/:id/start', withAccountId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await accountManager.startAccount(req.accountId!);
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/stop
router.post('/:id/stop', withAccountId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await accountManager.stopAccount(req.accountId!);
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/chat
router.post('/:id/chat', withAccountId, (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message } = chatSchema.parse(req.body);
    // Strip CR/LF so the dashboard chat call cannot stack commands.
    const cleaned = message.replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Empty message after sanitization', 400);
    }
    accountManager.sendChat(req.accountId!, cleaned);
    res.status(202).json({ sent: true });
  } catch (err) {
    next(err);
  }
});

export { router as accountsRouter };
