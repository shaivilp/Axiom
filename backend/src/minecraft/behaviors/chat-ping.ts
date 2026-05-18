import type { Bot } from 'mineflayer';
import type { Logger } from '../../logger.js';
import { renderTemplate, type ChatPingConfig, type TemplateContext } from './schema.js';

/**
 * Sends a chat message on a FIXED interval (user spec). Rotates through the
 * configured `messages[]` so the bot doesn't say the exact same line every
 * tick. Each message is run through the {{ordinal}}/{{username}}/{{label}}
 * template substitution.
 *
 * If the bot is mid-disconnect when the timer fires, the chat call is
 * swallowed — the next reconnect will create a fresh ChatPingBehavior.
 */
export class ChatPingBehavior {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private cursor = 0;

  constructor(
    private readonly bot: Bot,
    private readonly config: ChatPingConfig,
    private readonly ctx: TemplateContext,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled) return;
    if (this.config.messages.length === 0) return;
    // Fixed interval, no jitter — user explicitly asked for fixed cadence.
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
    const template = this.config.messages[this.cursor % this.config.messages.length] ?? '';
    this.cursor = (this.cursor + 1) % this.config.messages.length;
    const rendered = renderTemplate(template, this.ctx);
    try {
      this.bot.chat(rendered);
      this.log.debug({ rendered }, 'chat-ping: sent');
    } catch (err) {
      this.log.debug({ err, rendered }, 'chat-ping: send failed (likely disconnecting)');
    }
  }
}
