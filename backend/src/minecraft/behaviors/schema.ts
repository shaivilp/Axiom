import { z } from 'zod';

/**
 * Anti-AFK behaviors, one set per account. Persisted in the `behaviors` JSONB
 * column on the Account row. Defaults baked in so a brand-new account boots
 * with sane settings.
 *
 * Two flavors of timer:
 *   - wiggle  — jittered movement to avoid AFK detection (±jitterPct around
 *               the base interval). Cheap and low-signal.
 *   - chatPing — *fixed* interval chat messages. Some servers expect a chat
 *               heartbeat (and the user explicitly asked for fixed cadence).
 *
 * Login commands run once after spawn with explicit per-command delays so
 * `/login <pw>` can finish before `/f warp cac1` fires.
 *
 * All command and chat strings support template substitution:
 *   {{ordinal}}   — the account's stable numeric ID (1, 2, 3, ...)
 *   {{username}}  — the MC username configured on the account
 *   {{label}}     — the user-facing label shown in the dashboard
 *
 * Example: a global default of `/f warp cac{{ordinal}}` renders to `/f warp
 * cac1` for the first account, `/f warp cac2` for the second, etc.
 */
export const wiggleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(2_000).max(10 * 60_000).default(30_000),
  jitterPct: z.number().min(0).max(1).default(0.2),
});

export const chatPingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Fixed interval — *no* jitter. Server expects regular heartbeats.
  intervalMs: z.number().int().min(5_000).max(60 * 60_000).default(60_000),
  // Messages rotate in order so the bot doesn't spam the exact same line.
  messages: z.array(z.string().min(1).max(256)).min(1).default(['Still here.']),
});

export const loginCommandSchema = z.object({
  // Literal command string or one with {{ordinal}}/{{username}}/{{label}}.
  // Include the leading slash for slash commands; the bot does not add one.
  command: z.string().min(1).max(256),
  // Delay BEFORE this command is sent, measured from the previous command's
  // dispatch (or from spawn for the first command). 0 = fire immediately.
  delayMs: z.number().int().nonnegative().max(60_000).default(1_000),
});

export const behaviorConfigSchema = z
  .object({
    wiggle: wiggleConfigSchema.default({}),
    chatPing: chatPingConfigSchema.default({}),
    loginCommands: z.array(loginCommandSchema).default([]),
  })
  .default({});

export type WiggleConfig = z.infer<typeof wiggleConfigSchema>;
export type ChatPingConfig = z.infer<typeof chatPingConfigSchema>;
export type LoginCommand = z.infer<typeof loginCommandSchema>;
export type BehaviorConfig = z.infer<typeof behaviorConfigSchema>;

export interface TemplateContext {
  ordinal: number;
  username: string;
  label: string;
}

// Matches {{name}} with optional inner whitespace; ignores unknown keys
// (renders them through unchanged) so users see exactly what they typed if
// they make a typo, rather than a silent empty string.
const TEMPLATE_RE = /\{\{\s*(ordinal|username|label)\s*\}\}/g;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(TEMPLATE_RE, (_match, key: string) => {
    switch (key) {
      case 'ordinal':
        return String(ctx.ordinal);
      case 'username':
        return ctx.username;
      case 'label':
        return ctx.label;
      default:
        return _match;
    }
  });
}

/**
 * Parse the JSON blob from the `Account.behaviors` column. Always returns a
 * fully-defaulted config — partial blobs are filled in, malformed blobs
 * throw (caller surfaces a VALIDATION_ERROR).
 */
export function parseBehaviorConfig(raw: unknown): BehaviorConfig {
  // `null` and `undefined` are valid — they mean "use defaults".
  if (raw == null) return behaviorConfigSchema.parse({});
  return behaviorConfigSchema.parse(raw);
}
