import type { BehaviorConfig, IntervalCommandConfig } from './types';

/**
 * Single source of truth for the default BehaviorConfig used by every form
 * on the frontend. Matches what backend Zod produces from `parse({})`.
 */
export const defaultBehaviorConfig: BehaviorConfig = {
  wiggle: { enabled: true, intervalMs: 30_000, jitterPct: 0.2 },
  chatPing: { enabled: false, intervalMs: 60_000, messages: ['Still here.'] },
  loginCommands: [],
};

/**
 * Default global interval-command. Matches backend
 * `intervalCommandConfigSchema.parse({})` — disabled, every 5 minutes.
 */
export const defaultIntervalCommandConfig: IntervalCommandConfig = {
  enabled: false,
  intervalMs: 300_000,
  commands: ['/help'],
};
