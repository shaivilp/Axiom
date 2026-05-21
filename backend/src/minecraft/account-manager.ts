import { EventEmitter } from 'node:events';
import type { Account } from '@prisma/client';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';
import { AppError, ErrorCodes } from '../types.js';
import { deleteAuthCache, hasPersistedTokens } from './auth.js';
import { BotInstance, type BotMetadata } from './bot-instance.js';
import type { BehaviorConfig } from './behaviors/schema.js';
import type { AccountSummary, BotLifecycleEvent, ChatEvent } from './events.js';

/**
 * Central registry of all running bots. Single source of truth for "which
 * accounts exist" and "what is each one doing right now."
 *
 * Emits events that the WebSocket layer subscribes to:
 *   - 'account-changed'  fired on any state/error/uptime change worth showing
 *   - 'account-removed'  fired when an account is deleted
 *   - 'chat'             per-account chat line
 *   - 'lifecycle'        per-account spawn/kick/error event
 */
export interface AccountManagerEvents {
  'account-changed': (summary: AccountSummary) => void;
  'account-removed': (accountId: string) => void;
  chat: (accountId: string, chat: ChatEvent) => void;
  lifecycle: (accountId: string, event: BotLifecycleEvent) => void;
}

export declare interface AccountManager {
  on<E extends keyof AccountManagerEvents>(event: E, listener: AccountManagerEvents[E]): this;
  emit<E extends keyof AccountManagerEvents>(
    event: E,
    ...args: Parameters<AccountManagerEvents[E]>
  ): boolean;
}

function rowToMeta(row: Account): BotMetadata {
  return {
    id: row.id,
    ordinal: row.ordinal,
    label: row.label,
    username: row.username,
    authType: row.authType,
    serverHost: row.serverHost,
    serverPort: row.serverPort,
    version: row.version,
    autoConnect: row.autoConnect,
    desiredState: row.desiredState,
  };
}

export class AccountManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private started = false;

  /**
   * Hydrate from the DB on boot. Each account with `desiredState=running`
   * AND `autoConnect=true` is started immediately, in parallel. Microsoft
   * accounts without a persisted token row are deliberately NOT started —
   * starting one would infinite-loop on a stale device-code prompt.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const rows = await prisma.account.findMany({ orderBy: { ordinal: 'asc' } });
    logger.info({ count: rows.length }, 'account-manager: hydrating from db');

    for (const row of rows) {
      this.spawnBot(row);
      if (row.desiredState !== 'running' || !row.autoConnect) continue;

      if (row.authType === 'microsoft') {
        const hasTokens = await hasPersistedTokens(row.id).catch(() => false);
        if (!hasTokens) {
          logger.warn(
            { accountId: row.id },
            'hydrate: MS account has no persisted tokens — skipping auto-start (user must complete device-code auth)',
          );
          continue;
        }
      }

      this.bots.get(row.id)?.start();
    }
  }

  /**
   * Stop every bot cleanly. Used by the SIGTERM handler so the server
   * doesn't leave open MC sockets dangling.
   */
  async stop(): Promise<void> {
    const stops = Array.from(this.bots.values()).map((b) => b.stop().catch(() => undefined));
    await Promise.all(stops);
    this.bots.clear();
  }

  listSummaries(): AccountSummary[] {
    return Array.from(this.bots.values())
      .map((b) => this.summarize(b))
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  getSummary(id: string): AccountSummary | null {
    const bot = this.bots.get(id);
    return bot ? this.summarize(bot) : null;
  }

  /** The full parsed behavior config for an account (for the detail view). */
  getBehaviors(id: string): BehaviorConfig | null {
    const bot = this.bots.get(id);
    return bot ? bot.getBehaviors() : null;
  }

  private summarize(bot: BotInstance): AccountSummary {
    const meta = bot.getMeta();
    return {
      id: meta.id,
      ordinal: meta.ordinal,
      label: meta.label,
      username: meta.username,
      authType: meta.authType,
      serverHost: meta.serverHost,
      serverPort: meta.serverPort,
      version: meta.version,
      autoConnect: meta.autoConnect,
      desiredState: meta.desiredState,
      state: bot.getState(),
      lastError: bot.getLastError(),
      lastConnectedAt: bot.getLastConnectedAt()?.toISOString() ?? null,
      reconnectAttempt: bot.getReconnectAttempt(),
      uptimeMs: bot.getUptimeMs(),
    };
  }

  private spawnBot(row: Account): BotInstance {
    const bot = new BotInstance({
      meta: rowToMeta(row),
      behaviors: row.behaviors,
    });

    bot.on('state', () => {
      const summary = this.summarize(bot);
      this.persistState(row.id, summary.state, bot.getLastError(), bot.getLastConnectedAt())
        .catch((err) => logger.warn({ err, accountId: row.id }, 'persist state failed'));
      this.emit('account-changed', summary);
    });
    bot.on('chat', (chat) => this.emit('chat', row.id, chat));
    bot.on('lifecycle', (ev) => this.emit('lifecycle', row.id, ev));
    bot.on('fatal', (reason) => {
      logger.error({ accountId: row.id, reason }, 'bot fatal — manager will not auto-restart');
    });

    this.bots.set(row.id, bot);
    return bot;
  }

  private async persistState(
    accountId: string,
    state: AccountSummary['state'],
    lastError: string | null,
    lastConnectedAt: Date | null,
  ): Promise<void> {
    await prisma.account.update({
      where: { id: accountId },
      data: {
        lastState: state,
        lastError,
        ...(lastConnectedAt ? { lastConnectedAt } : {}),
      },
    });
  }

  // ---- CRUD ----

  async createAccount(input: {
    label: string;
    username: string;
    authType: 'offline' | 'microsoft';
    serverHost: string;
    serverPort: number;
    version: string;
    autoConnect: boolean;
    behaviors: unknown;
  }): Promise<AccountSummary> {
    // MS accounts cannot run until device-code auth completes. Persisting
    // `desiredState='running'` would, on the next process restart, try to
    // start a tokenless bot and infinite-loop on auth-needed. Force-stopped
    // until /auth/complete flips it.
    const initialDesired: 'running' | 'stopped' =
      input.authType === 'microsoft'
        ? 'stopped'
        : input.autoConnect
          ? 'running'
          : 'stopped';

    const row = await prisma.account.create({
      data: {
        label: input.label,
        username: input.username,
        authType: input.authType,
        serverHost: input.serverHost,
        serverPort: input.serverPort,
        version: input.version,
        autoConnect: input.autoConnect,
        behaviors: input.behaviors as never,
        desiredState: initialDesired,
      },
    });
    const bot = this.spawnBot(row);
    if (input.authType === 'offline' && input.autoConnect) {
      bot.start();
    }
    const summary = this.summarize(bot);
    this.emit('account-changed', summary);
    return summary;
  }

  async updateAccount(
    id: string,
    patch: Partial<{
      label: string;
      serverHost: string;
      serverPort: number;
      version: string;
      autoConnect: boolean;
      behaviors: unknown;
    }>,
  ): Promise<AccountSummary> {
    const row = await prisma.account.update({
      where: { id },
      data: {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.serverHost !== undefined ? { serverHost: patch.serverHost } : {}),
        ...(patch.serverPort !== undefined ? { serverPort: patch.serverPort } : {}),
        ...(patch.version !== undefined ? { version: patch.version } : {}),
        ...(patch.autoConnect !== undefined ? { autoConnect: patch.autoConnect } : {}),
        ...(patch.behaviors !== undefined ? { behaviors: patch.behaviors as never } : {}),
      },
    });
    const bot = this.bots.get(id);
    if (!bot) {
      throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found in manager', 404);
    }
    bot.updateMeta(rowToMeta(row));
    if (patch.behaviors !== undefined) {
      bot.updateBehaviors(row.behaviors);
    }
    const summary = this.summarize(bot);
    this.emit('account-changed', summary);
    return summary;
  }

  async startAccount(id: string): Promise<AccountSummary> {
    const bot = this.bots.get(id);
    if (!bot) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    const row = await prisma.account.update({
      where: { id },
      data: { desiredState: 'running' },
    });
    bot.updateMeta(rowToMeta(row));
    bot.start();
    return this.summarize(bot);
  }

  async stopAccount(id: string): Promise<AccountSummary> {
    const bot = this.bots.get(id);
    if (!bot) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    const row = await prisma.account.update({
      where: { id },
      data: { desiredState: 'stopped' },
    });
    bot.updateMeta(rowToMeta(row));
    await bot.stop();
    return this.summarize(bot);
  }

  /**
   * Stop the bot, then transactionally delete tokens + the account row.
   * Disk cache is wiped last, after the DB is consistent. Any cleanup
   * failure is logged at error level (no silent .catch swallowing).
   */
  async deleteAccount(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (bot) {
      await bot.stop().catch((err) => {
        logger.warn({ err, id }, 'delete-account: stop threw, continuing');
      });
    }
    this.bots.delete(id);

    try {
      await prisma.$transaction([
        prisma.accountToken.deleteMany({ where: { accountId: id } }),
        prisma.account.delete({ where: { id } }),
      ]);
    } catch (err) {
      logger.error({ err, id }, 'delete-account: db transaction failed');
      throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Failed to delete account', 500);
    }

    try {
      await deleteAuthCache(id);
    } catch (err) {
      // Disk cleanup failing after a successful DB delete leaves orphaned
      // ciphertext on disk. Surface, don't swallow.
      logger.error({ err, id }, 'delete-account: disk cache cleanup failed (orphaned files)');
    }

    this.emit('account-removed', id);
  }

  /**
   * Mark an MS account as user-controlled (desiredState='running') after
   * device-code auth completes. Called by /auth/complete.
   */
  async markAccountRunning(id: string): Promise<AccountSummary> {
    const bot = this.bots.get(id);
    if (!bot) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    const row = await prisma.account.update({
      where: { id },
      data: { desiredState: 'running' },
    });
    bot.updateMeta(rowToMeta(row));
    bot.start();
    return this.summarize(bot);
  }

  sendChat(id: string, text: string): void {
    const bot = this.bots.get(id);
    if (!bot) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    if (bot.getState() !== 'connected') {
      throw new AppError(ErrorCodes.ACCOUNT_BUSY, 'Bot is not connected', 409);
    }
    bot.sendChat(text);
  }
}

export const accountManager = new AccountManager();
