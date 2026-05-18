import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { behaviorConfigSchema } from '../minecraft/behaviors/schema.js';

const router = Router();

// Single-row settings table — pinned ID makes upserts trivial.
const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

const updateSchema = z.object({
  defaultServerHost: z.string().min(1).max(253).optional().nullable(),
  defaultServerPort: z.number().int().min(1).max(65535).optional().nullable(),
  defaultVersion: z.string().min(1).max(16).optional().nullable(),
  defaultBehaviors: behaviorConfigSchema.optional(),
});

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.settings.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID },
    });
    res.json({ settings: row });
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const patch = updateSchema.parse(req.body);
    const row = await prisma.settings.upsert({
      where: { id: SETTINGS_ID },
      update: {
        ...(patch.defaultServerHost !== undefined ? { defaultServerHost: patch.defaultServerHost } : {}),
        ...(patch.defaultServerPort !== undefined ? { defaultServerPort: patch.defaultServerPort } : {}),
        ...(patch.defaultVersion !== undefined ? { defaultVersion: patch.defaultVersion } : {}),
        ...(patch.defaultBehaviors !== undefined ? { defaultBehaviors: patch.defaultBehaviors as never } : {}),
      },
      create: {
        id: SETTINGS_ID,
        ...(patch.defaultServerHost !== undefined ? { defaultServerHost: patch.defaultServerHost } : {}),
        ...(patch.defaultServerPort !== undefined ? { defaultServerPort: patch.defaultServerPort } : {}),
        ...(patch.defaultVersion !== undefined ? { defaultVersion: patch.defaultVersion } : {}),
        ...(patch.defaultBehaviors !== undefined ? { defaultBehaviors: patch.defaultBehaviors as never } : {}),
      },
    });
    res.json({ settings: row });
  } catch (err) {
    next(err);
  }
});

export { router as settingsRouter };
