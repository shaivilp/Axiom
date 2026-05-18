import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { accountManager } from '../minecraft/account-manager.js';
import { behaviorConfigSchema } from '../minecraft/behaviors/schema.js';
import { AppError, ErrorCodes } from '../types.js';

const router = Router();

const idParamSchema = z.object({ id: z.string().uuid() });

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

// GET /accounts/:id
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const summary = accountManager.getSummary(id);
    if (!summary) {
      throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    }
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

// PATCH /accounts/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const patch = updateSchema.parse(req.body);
    const updated = await accountManager.updateAccount(id, patch);
    res.json({ account: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /accounts/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    await accountManager.deleteAccount(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/start
router.post('/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const summary = await accountManager.startAccount(id);
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/stop
router.post('/:id/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const summary = await accountManager.stopAccount(id);
    res.json({ account: summary });
  } catch (err) {
    next(err);
  }
});

// POST /accounts/:id/chat — send a chat line / slash command via this account
router.post('/:id/chat', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = idParamSchema.parse(req.params);
    const { message } = chatSchema.parse(req.body);
    accountManager.sendChat(id, message);
    res.status(202).json({ sent: true });
  } catch (err) {
    next(err);
  }
});

export { router as accountsRouter };
