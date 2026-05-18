import type { Bot } from 'mineflayer';
import type { Logger } from '../../logger.js';
import type { WiggleConfig } from './schema.js';

/**
 * Small randomized look/move actions. Variation comes from:
 *   1. jitter on the interval itself (±jitterPct)
 *   2. randomized action choice each tick (look or sneak-tap)
 *   3. randomized yaw/pitch for look actions
 *
 * Why: a perfectly periodic timer with identical actions is the *easiest*
 * thing for an anti-cheat / AFK plugin to fingerprint.
 */
export class WiggleBehavior {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly bot: Bot,
    private readonly config: WiggleConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled) return;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const { intervalMs, jitterPct } = this.config;
    const jitter = intervalMs * jitterPct * (Math.random() * 2 - 1);
    const delay = Math.max(500, Math.round(intervalMs + jitter));
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      const action = Math.random();
      if (action < 0.5) {
        // Random small look turn — keep deltas modest so the bot doesn't spin.
        const yaw = (Math.random() - 0.5) * Math.PI; // ±90°
        const pitch = (Math.random() - 0.5) * (Math.PI / 4); // ±22.5°
        void this.bot.look(yaw, pitch, false);
      } else {
        // Tap sneak — server sees a position-update with no movement, which
        // is a strong "player is here" signal on most AFK detectors.
        this.bot.setControlState('sneak', true);
        setTimeout(() => {
          if (!this.stopped) this.bot.setControlState('sneak', false);
        }, 150);
      }
    } catch (err) {
      // Bot may have disconnected between scheduling and firing — that's
      // fine, the manager will tear us down. Log at debug to avoid noise.
      this.log.debug({ err }, 'wiggle: tick threw, will retry on next interval');
    }
    this.scheduleNext();
  }
}
