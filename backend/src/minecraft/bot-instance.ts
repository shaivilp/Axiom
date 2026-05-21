import { EventEmitter } from 'node:events';
import { createBot, type Bot } from 'mineflayer';
import { logger as rootLogger, type Logger } from '../logger.js';
import { ChatPingBehavior } from './behaviors/chat-ping.js';
import { IntervalCommandBehavior } from './behaviors/interval-command.js';
import { LoginCommandsRunner } from './behaviors/login-commands.js';
import {
  parseBehaviorConfig,
  parseIntervalCommandConfig,
  type BehaviorConfig,
  type IntervalCommandConfig,
  type TemplateContext,
} from './behaviors/schema.js';
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

/**
 * The subset of an Account row a BotInstance needs to operate. Owned by
 * the BotInstance (not stashed via a hidden field on a foreign type) and
 * refreshed via `updateMeta()` whenever the AccountManager persists state.
 */
export interface BotMetadata {
  id: string;
  ordinal: number;
  label: string;
  username: string;
  authType: 'offline' | 'microsoft';
  serverHost: string;
  serverPort: number;
  version: string;
  autoConnect: boolean;
  desiredState: 'running' | 'stopped';
}

export interface BotInstanceOptions {
  meta: BotMetadata;
  behaviors: unknown; // raw JSON, parsed here
  // Global interval-command config (raw JSON from the Settings table). Shared
  // by every bot; parsed here. Optional — defaults to disabled.
  intervalCommand?: unknown;
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
  private meta: BotMetadata;
  private behaviorConfig: BehaviorConfig;
  private intervalCommandConfig: IntervalCommandConfig;
  private log: Logger;
  private policy: ReconnectPolicy;

  private bot: Bot | null = null;
  private state: BotState = 'idle';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  // Transient errors that don't kill the session — we keep the latest so it
  // can be surfaced for diagnosis, but we only mark `lastError` (visible in
  // the UI) when the session actually ends.
  private latestTransientError: string | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;
  private connectStartTime: Date | null = null;
  private stopRequested = false;

  // Behavior instances. Recreated on every (re)connect so timers cleanly
  // tie to a single bot session.
  private wiggle: WiggleBehavior | null = null;
  private chatPing: ChatPingBehavior | null = null;
  private loginCommands: LoginCommandsRunner | null = null;
  private intervalCommand: IntervalCommandBehavior | null = null;

  constructor(opts: BotInstanceOptions) {
    super();
    this.meta = opts.meta;
    this.behaviorConfig = parseBehaviorConfig(opts.behaviors);
    this.intervalCommandConfig = parseIntervalCommandConfig(opts.intervalCommand);
    this.policy = opts.reconnectPolicy ?? defaultReconnectPolicy;
    this.log = rootLogger.child({
      accountId: this.meta.id,
      ordinal: this.meta.ordinal,
      label: this.meta.label,
    });
  }

  get id(): string {
    return this.meta.id;
  }

  getMeta(): Readonly<BotMetadata> {
    return this.meta;
  }

  /**
   * Refresh the cached account metadata after a DB update. Keeps
   * AccountManager.summarize() honest under sustained state changes
   * without re-reading the DB on every event.
   */
  updateMeta(meta: BotMetadata): void {
    this.meta = meta;
    this.log = rootLogger.child({
      accountId: meta.id,
      ordinal: meta.ordinal,
      label: meta.label,
    });
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

  /** The current parsed behavior config (wiggle, chat-ping, login commands). */
  getBehaviors(): BehaviorConfig {
    return this.behaviorConfig;
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
   * Apply a new GLOBAL interval-command config without dropping the
   * connection. Pushed by the AccountManager when the Settings row changes,
   * so a single edit retunes every running bot live.
   */
  updateIntervalCommand(rawIntervalCommand: unknown): void {
    this.intervalCommandConfig = parseIntervalCommandConfig(rawIntervalCommand);
    if (this.state === 'connected' && this.bot) {
      this.intervalCommand?.stop();
      this.intervalCommand = new IntervalCommandBehavior(
        this.bot,
        this.intervalCommandConfig,
        this.templateContext(),
        this.log,
      );
      this.intervalCommand.start();
    }
  }

  /**
   * Push a chat line (or slash command) via this account. Throws if the
   * bot isn't currently connected — callers should pre-check state.
   * Strips CR/LF so a single dashboard chat call can't stack commands.
   */
  sendChat(text: string): void {
    if (this.state !== 'connected' || !this.bot) {
      throw new Error('Bot is not connected');
    }
    const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) return;
    this.bot.chat(cleaned);
  }

  /** Start (or resume) the connect → reconnect loop. */
  start(): void {
    // Always clear the stop flag first — even if we're early-returning we
    // want a Stop→Start race during teardown to leave us in the running
    // path, not the suppressed one.
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
    this.latestTransientError = null;

    const useMs = this.meta.authType === 'microsoft';
    this.setState(useMs ? 'authenticating' : 'connecting');

    void this.doConnect().catch((err) => {
      this.handleFatalConnectError(err);
    });
  }

  private async doConnect(): Promise<void> {
    let profilesFolder: string | undefined;
    if (this.meta.authType === 'microsoft') {
      profilesFolder = await getProfilesFolder(this.meta.id);
    }

    // Hardening: a stop() that arrived while we were awaiting must short-circuit
    // before we allocate a mineflayer socket. Without this, the inflight
    // doConnect could create a phantom Bot the caller has no reference to.
    if (this.stopRequested) {
      this.setState('idle');
      return;
    }

    this.setState('connecting');

    // For Microsoft auth, the `username` passed to mineflayer is only used as
    // the prismarine-auth cache key (the real profile name comes from the
    // token). It MUST match the identifier our device-code flow cached under,
    // so we use the stable account UUID on both sides — the display username
    // (meta.username) can change to the MS profile name without breaking the
    // cache lookup. For offline auth, username is the literal player name.
    const authUsername =
      this.meta.authType === 'microsoft' ? this.meta.id : this.meta.username;

    // createBot is synchronous; failures show up as 'error' / 'end' events.
    const bot = createBot({
      username: authUsername,
      host: this.meta.serverHost,
      port: this.meta.serverPort,
      version: this.meta.version,
      auth: this.meta.authType === 'microsoft' ? 'microsoft' : 'offline',
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

    // Belt-and-suspenders: stop arrived between the await above and now.
    if (this.stopRequested) {
      try {
        bot.quit('stop arrived during connect');
      } catch {
        /* ignore */
      }
      this.setState('idle');
      return;
    }

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
      this.lastError = null;
      this.setState('connected');
      this.emitLifecycle('spawn');
      this.log.info('bot: spawned');
      this.startBehaviors(bot);

      // After a successful MS connect, the on-disk cache may have been
      // refreshed by prismarine-auth — sync it back to the DB. The auth
      // module serializes per-accountId, so a concurrent device-code
      // finalize cannot clobber a newer token.
      if (this.meta.authType === 'microsoft') {
        void syncDiskCacheToDb(this.meta.id).catch((err) => {
          this.log.warn({ err }, 'ms-auth: post-spawn db sync failed');
        });
      }
    });

    // Mineflayer's `chat` event covers the standard "<player> message" form.
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

    // System / server messages. We only forward what mineflayer classifies
    // as 'system' here; player chat is delivered via 'chat'/'whisper' above
    // and would otherwise double-fire on modded/Bukkit prefix formats.
    bot.on('messagestr', (text: string, type: string) => {
      if (type === 'system' || type === 'announcement') {
        this.emit('chat', {
          kind: 'system',
          text,
          timestamp: new Date().toISOString(),
        });
      }
    });

    bot.on('kicked', (reason: string) => {
      this.latestTransientError = `Kicked: ${reason}`;
      this.emitLifecycle('kicked', reason);
      this.log.warn({ reason }, 'bot: kicked');
    });

    // Non-fatal protocol errors fire here. Don't pin them to `lastError`
    // (which the UI uses for the persistent red banner) — `end` is the
    // signal that a session actually died.
    bot.on('error', (err: Error) => {
      this.latestTransientError = err.message;
      this.emitLifecycle('error', err.message);
      this.log.warn({ err }, 'bot: error');
    });

    bot.on('end', (reason?: string) => {
      this.lastError = this.latestTransientError ?? (reason ? `Ended: ${reason}` : null);
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

    if (hasExceededRetries(this.reconnectAttempt, this.policy)) {
      this.setState('failed');
      this.emit('fatal', `Exceeded max reconnect attempts (${this.reconnectAttempt})`);
      this.log.error(
        { attempts: this.reconnectAttempt },
        'bot: giving up — exceeded max reconnect attempts',
      );
      return;
    }

    const delay = computeBackoff(this.reconnectAttempt, this.policy);
    this.setState('reconnecting');
    this.log.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'bot: scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private templateContext(): TemplateContext {
    return {
      ordinal: this.meta.ordinal,
      username: this.meta.username,
      label: this.meta.label,
    };
  }

  private startBehaviors(bot: Bot): void {
    const ctx = this.templateContext();

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

    // Global interval-command — shared config, per-bot template context.
    this.intervalCommand = new IntervalCommandBehavior(
      bot,
      this.intervalCommandConfig,
      ctx,
      this.log,
    );
    this.intervalCommand.start();
  }

  private teardownBehaviors(): void {
    this.loginCommands?.cancel();
    this.wiggle?.stop();
    this.chatPing?.stop();
    this.intervalCommand?.stop();
    this.loginCommands = null;
    this.wiggle = null;
    this.chatPing = null;
    this.intervalCommand = null;
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
