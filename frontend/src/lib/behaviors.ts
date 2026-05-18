import type { BehaviorConfig } from './types';

/**
 * Single source of truth for the default BehaviorConfig used by every form
 * on the frontend. Matches what backend Zod produces from `parse({})`.
 */
export const defaultBehaviorConfig: BehaviorConfig = {
  wiggle: { enabled: true, intervalMs: 30_000, jitterPct: 0.2 },
  chatPing: { enabled: false, intervalMs: 60_000, messages: ['Still here.'] },
  loginCommands: [],
};
