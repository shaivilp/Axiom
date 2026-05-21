import type { Bot } from 'mineflayer';
import type { Logger } from '../../logger.js';
import { renderTemplate, type IntervalCommandConfig, type TemplateContext } from './schema.js';

/**
 * Sends a command (or rotating list of commands) on a FIXED interval. This is
 * the runtime half of the GLOBAL interval-command feature: one config in the
 * Settings table drives an instance of this on every bot. Mechanically it is
 * the chat-ping's twin (`bot.chat` sends both prose and slash commands), but
 * kept separate so the two can be enabled/tuned independently and so the UI
 * can present "run a command every N minutes" as its own concept.
 *
 * Each command is run through {{ordinal}}/{{username}}/{{label}} substitution,
 * so `/f warp cac{{ordinal}}` resolves per-bot. If the bot is mid-disconnect
 * when the timer fires, the call is swallowed — the next reconnect builds a
 * fresh behavior from the current config.
 */
export class IntervalCommandBehavior {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private cursor = 0;

  constructor(
    private readonly bot: Bot,
    private readonly config: IntervalCommandConfig,
    private readonly ctx: TemplateContext,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled) return;
    if (this.config.commands.length === 0) return;
    // Fixed interval, no jitter — a scheduled command should fire on cadence.
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const template = this.config.commands[this.cursor % this.config.commands.length] ?? '';
    this.cursor = (this.cursor + 1) % this.config.commands.length;
    const rendered = renderTemplate(template, this.ctx);
    try {
      this.bot.chat(rendered);
      this.log.debug({ rendered }, 'interval-command: sent');
    } catch (err) {
      this.log.debug({ err, rendered }, 'interval-command: send failed (likely disconnecting)');
    }
  }
}
