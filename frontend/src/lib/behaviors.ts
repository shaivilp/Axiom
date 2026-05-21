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

/**
 * Normalize a BehaviorConfig for persistence. The chat-ping textarea keeps its
 * lines raw while editing (so a trailing space mid-type isn't stripped on every
 * keystroke); cleaning is deferred to save time here: trim each line, drop
 * blanks, and fall back to the default if nothing's left (the backend requires
 * at least one message). Blank login-command rows are dropped too.
 */
export function cleanBehaviorConfig(b: BehaviorConfig): BehaviorConfig {
  const messages = b.chatPing.messages.map((m) => m.trim()).filter(Boolean);
  return {
    ...b,
    chatPing: {
      ...b.chatPing,
      messages: messages.length > 0 ? messages : defaultBehaviorConfig.chatPing.messages,
    },
    loginCommands: b.loginCommands.filter((c) => c.command.trim() !== ''),
  };
}
