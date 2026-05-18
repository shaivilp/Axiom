import { EventEmitter } from 'node:events';
import { createBot, type Bot } from 'mineflayer';
import { logger as rootLogger, type Logger } from '../logger.js';
import { ChatPingBehavior } from './behaviors/chat-ping.js';
import { LoginCommandsRunner } from './behaviors/login-commands.js';
import { parseBehaviorConfig, type BehaviorConfig, type TemplateContext } from './behaviors/schema.js';
import { WiggleBehavior } from './behaviors/wiggle.js';
import {
  computeBackoff,
  defaultReconnectPolicy,
  hasExceededRetries,
  type ReconnectPolicy,
} from './reconnect.js';
import { getProfilesFolder, syncDiskCacheToDb } from './auth.js';
import type {
  BotLifecycleEvent,
  BotState,
  ChatEvent,
} from './events.js';

export interface BotInstanceOptions {
  id: string;
  ordinal: number;
  label: string;
  username: string;
  authType: 'offline' | 'microsoft';
  serverHost: string;
  serverPort: number;
  version: string;
  behaviors: unknown; // raw JSON, parsed here
  reconnectPolicy?: ReconnectPolicy;
}

export interface BotInstanceEvents {
  state: (state: BotState, prevState: BotState) => void;
  chat: (event: ChatEvent) => void;
  lifecycle: (event: BotLifecycleEvent) => void;
  fatal: (reason: string) => void;
}

export declare interface BotInstance {
  on<E extends keyof BotInstanceEvents>(event: E, listener: BotInstanceEvents[E]): this;
  emit<E extends keyof BotInstanceEvents>(event: E, ...args: Parameters<BotInstanceEvents[E]>): boolean;
}

/**
 * Owns a single mineflayer.Bot, its reconnect timer, and its anti-AFK
 * behaviors. The AccountManager keeps one of these per added account.
 *
 * Lifecycle:
 *   idle → connecting → (authenticating if MS) → connected
 *     ↓ on disconnect
 *   disconnected → reconnecting → connecting → ...
 *     ↓ on stop() OR retry exhaustion
 *   idle (stop) | failed (exhaustion)
 *
 * One BotInstance crashing must not affect another — every callback into
 * mineflayer is wrapped in try/catch, and a `fatal` event is the only way
 * the manager learns of unrecoverable problems.
 */
export class BotInstance extends EventEmitter {
  readonly id: string;
  private opts: BotInstanceOptions;
  private behaviorConfig: BehaviorConfig;
  private log: Logger;

  private bot: Bot | null = null;
  private state: BotState = 'idle';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;
  private connectStartTime: Date | null = null;
  private stopRequested = false;

  // Behavior instances. Recreated on every (re)connect so timers cleanly
  // tie to a single bot session.
  private wiggle: WiggleBehavior | null = null;
  private chatPing: ChatPingBehavior | null = null;
  private loginCommands: LoginCommandsRunner | null = null;

  constructor(opts: BotInstanceOptions) {
    super();
    this.id = opts.id;
    this.opts = opts;
    this.behaviorConfig = parseBehaviorConfig(opts.behaviors);
    this.log = rootLogger.child({ accountId: opts.id, ordinal: opts.ordinal, label: opts.label });
  }

  getState(): BotState {
    return this.state;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastConnectedAt(): Date | null {
    return this.lastConnectedAt;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  getUptimeMs(): number {
    if (this.state !== 'connected' || !this.connectStartTime) return 0;
    return Date.now() - this.connectStartTime.getTime();
  }

  /**
   * Apply a new behavior config without dropping the current connection.
   * Existing timers are torn down and recreated for the new config.
   */
  updateBehaviors(rawBehaviors: unknown): void {
    this.behaviorConfig = parseBehaviorConfig(rawBehaviors);
    if (this.state === 'connected' && this.bot) {
      this.teardownBehaviors();
      this.startBehaviors(this.bot);
    }
  }

  /**
   * Push a chat line (or slash command) via this account. Throws if the
   * bot isn't currently connected — callers should pre-check state.
   */
  sendChat(text: string): void {
    if (this.state !== 'connected' || !this.bot) {
      throw new Error('Bot is not connected');
    }
    this.bot.chat(text);
  }

  /** Start (or resume) the connect → reconnect loop. */
  start(): void {
    this.stopRequested = false;
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'authenticating') {
      return;
    }
    this.reconnectAttempt = 0;
    this.connect();
  }

  /**
   * Stop the bot and suppress all further reconnect attempts. Safe to call
   * repeatedly. Resolves once the underlying socket is closed.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownBehaviors();
    if (this.bot) {
      try {
        this.bot.quit('dashboard stop');
      } catch (err) {
        this.log.debug({ err }, 'bot.quit threw, ignoring');
      }
      this.bot = null;
    }
    this.setState('idle');
  }

  private connect(): void {
    if (this.stopRequested) return;
    this.lastError = null;

    const useMs = this.opts.authType === 'microsoft';
    this.setState(useMs ? 'authenticating' : 'connecting');

    void this.doConnect().catch((err) => {
      this.handleFatalConnectError(err);
    });
  }

  private async doConnect(): Promise<void> {
    let profilesFolder: string | undefined;
    if (this.opts.authType === 'microsoft') {
      profilesFolder = await getProfilesFolder(this.opts.id);
    }

    this.setState('connecting');

    // createBot is synchronous; failures show up as 'error' / 'end' events.
    const bot = createBot({
      username: this.opts.username,
      host: this.opts.serverHost,
      port: this.opts.serverPort,
      version: this.opts.version,
      auth: this.opts.authType === 'microsoft' ? 'microsoft' : 'offline',
      ...(profilesFolder ? { profilesFolder } : {}),
      // Silence mineflayer's own console logging; everything routes through Pino.
      hideErrors: true,
      checkTimeoutInterval: 30_000,
      // Mineflayer's onMsaCode kicks in only if no cached token exists; the
      // user is supposed to complete device auth before connecting. If we
      // hit this path, the cache is stale — surface it as a lifecycle event.
      onMsaCode: (data) => {
        this.emitLifecycle('auth-needed', `Device code needed: ${data.user_code}`);
        this.log.warn({ data }, 'bot: msa code requested mid-connect (cache stale?)');
      },
    });

    this.bot = bot;
    this.wireBotEvents(bot);
  }

  private wireBotEvents(bot: Bot): void {
    bot.once('login', () => {
      this.emitLifecycle('login');
      this.log.info('bot: logged in');
    });

    bot.once('spawn', () => {
      this.lastConnectedAt = new Date();
      this.connectStartTime = new Date();
      this.reconnectAttempt = 0;
      this.setState('connected');
      this.emitLifecycle('spawn');
      this.log.info('bot: spawned');
      this.startBehaviors(bot);

      // After a successful MS connect, the on-disk cache may have been
      // refreshed by prismarine-auth — sync it back to the DB. Best-effort,
      // never blocks the bot.
      if (this.opts.authType === 'microsoft') {
        void syncDiskCacheToDb(this.opts.id).catch((err) => {
          this.log.warn({ err }, 'ms-auth: post-spawn db sync failed');
        });
      }
    });

    bot.on('chat', (sender: string, text: string) => {
      this.emit('chat', {
        kind: sender === bot.username ? 'self' : 'chat',
        text,
        sender,
        timestamp: new Date().toISOString(),
      });
    });

    bot.on('whisper', (sender: string, text: string) => {
      this.emit('chat', {
        kind: 'whisper',
        text,
        sender,
        timestamp: new Date().toISOString(),
      });
    });

    bot.on('message', (jsonMsg) => {
      // Mineflayer emits 'chat' and 'whisper' separately. 'message' is the
      // raw firehose — we only forward server/system lines that weren't
      // already covered above. The simplest filter: anything without a
      // sender component, treat as system.
      try {
        const text = jsonMsg.toString();
        // Best-effort dedupe — skip messages that *look* like chat lines.
        if (/^<.+?> /.test(text)) return;
        this.emit('chat', {
          kind: 'system',
          text,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    });

    bot.on('kicked', (reason: string) => {
      this.lastError = `Kicked: ${reason}`;
      this.emitLifecycle('kicked', reason);
      this.log.warn({ reason }, 'bot: kicked');
    });

    bot.on('error', (err: Error) => {
      this.lastError = err.message;
      this.emitLifecycle('error', err.message);
      this.log.warn({ err }, 'bot: error');
    });

    bot.on('end', (reason?: string) => {
      this.emitLifecycle('end', reason ?? '');
      this.log.info({ reason }, 'bot: end');
      this.teardownBehaviors();
      this.bot = null;
      this.setState('disconnected');
      this.scheduleReconnect();
    });
  }

  private handleFatalConnectError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = message;
    this.emitLifecycle('error', message);
    this.log.error({ err }, 'bot: connect failed');
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) {
      this.setState('idle');
      return;
    }
    this.reconnectAttempt += 1;

    if (hasExceededRetries(this.reconnectAttempt)) {
      this.setState('failed');
      this.emit('fatal', `Exceeded max reconnect attempts (${this.reconnectAttempt})`);
      this.log.error(
        { attempts: this.reconnectAttempt },
        'bot: giving up — exceeded max reconnect attempts',
      );
      return;
    }

    const delay = computeBackoff(this.reconnectAttempt, defaultReconnectPolicy);
    this.setState('reconnecting');
    this.log.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'bot: scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startBehaviors(bot: Bot): void {
    const ctx: TemplateContext = {
      ordinal: this.opts.ordinal,
      username: this.opts.username,
      label: this.opts.label,
    };

    this.loginCommands = new LoginCommandsRunner(
      bot,
      this.behaviorConfig.loginCommands,
      ctx,
      this.log,
    );
    this.loginCommands.run();

    this.wiggle = new WiggleBehavior(bot, this.behaviorConfig.wiggle, this.log);
    this.wiggle.start();

    this.chatPing = new ChatPingBehavior(bot, this.behaviorConfig.chatPing, ctx, this.log);
    this.chatPing.start();
  }

  private teardownBehaviors(): void {
    this.loginCommands?.cancel();
    this.wiggle?.stop();
    this.chatPing?.stop();
    this.loginCommands = null;
    this.wiggle = null;
    this.chatPing = null;
  }

  private setState(next: BotState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    if (next !== 'connected') {
      this.connectStartTime = null;
    }
    this.emit('state', next, prev);
  }

  private emitLifecycle(kind: BotLifecycleEvent['kind'], details?: string): void {
    this.emit('lifecycle', {
      kind,
      details,
      timestamp: new Date().toISOString(),
    });
  }
}
