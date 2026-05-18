import type { Bot } from 'mineflayer';
import type { Logger } from '../../logger.js';
import { renderTemplate, type LoginCommand, type TemplateContext } from './schema.js';

/**
 * Sequentially fires a list of commands after the bot spawns, with explicit
 * `delayMs` between each one. Used for `/login <pw>` → `/warp afk` style
 * sequences and per-account custom warps like `/f warp cac{{ordinal}}`.
 *
 * The delay BEFORE each command is measured from the previous command's
 * dispatch (or from `run()` for the first one). This lets the user say
 * "wait 2s after /login finishes before /warp" without composing absolute
 * timestamps.
 *
 * Cancellable: if the bot disconnects mid-sequence, calling `cancel()`
 * stops further commands from firing.
 */
export class LoginCommandsRunner {
  private cancelled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly commands: LoginCommand[],
    private readonly ctx: TemplateContext,
    private readonly log: Logger,
  ) {}

  run(): void {
    if (this.commands.length === 0) return;
    this.runIndex(0);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private runIndex(i: number): void {
    if (this.cancelled || i >= this.commands.length) return;
    const cmd = this.commands[i]!;
    this.timer = setTimeout(() => {
      if (this.cancelled) return;
      const rendered = renderTemplate(cmd.command, this.ctx);
      try {
        this.bot.chat(rendered);
        this.log.info({ command: rendered, index: i }, 'login-commands: sent');
      } catch (err) {
        this.log.warn({ err, command: rendered, index: i }, 'login-commands: send failed');
      }
      this.runIndex(i + 1);
    }, cmd.delayMs);
  }
}
