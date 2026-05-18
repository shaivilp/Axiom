import { EventEmitter } from 'node:events';
import type { Account } from '@prisma/client';
import { prisma } from '../db/client.js';
import { logger } from '../logger.js';
import { AppError, ErrorCodes } from '../types.js';
import { deleteAuthCache } from './auth.js';
import { BotInstance } from './bot-instance.js';
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

export class AccountManager extends EventEmitter {
  private bots = new Map<string, BotInstance>();
  private started = false;

  /**
   * Hydrate from the DB on boot. Each account with `desiredState=running`
   * AND `autoConnect=true` is started immediately, in parallel.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const rows = await prisma.account.findMany({ orderBy: { ordinal: 'asc' } });
    logger.info({ count: rows.length }, 'account-manager: hydrating from db');

    for (const row of rows) {
      this.spawnBot(row);
      if (row.desiredState === 'running' && row.autoConnect) {
        this.bots.get(row.id)?.start();
      }
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

  private summarize(bot: BotInstance, row?: Account): AccountSummary {
    const cached = (bot as unknown as { __row?: Account }).__row;
    const accountRow = row ?? cached;
    if (!accountRow) {
      // Should never happen — every bot is created from a row and the row
      // is cached on the BotInstance via `attachRow`.
      throw new Error(`Missing account row for bot ${bot.id}`);
    }
    return {
      id: accountRow.id,
      ordinal: accountRow.ordinal,
      label: accountRow.label,
      username: accountRow.username,
      authType: accountRow.authType,
      serverHost: accountRow.serverHost,
      serverPort: accountRow.serverPort,
      version: accountRow.version,
      autoConnect: accountRow.autoConnect,
      desiredState: accountRow.desiredState,
      state: bot.getState(),
      lastError: bot.getLastError(),
      lastConnectedAt: bot.getLastConnectedAt()?.toISOString() ?? null,
      reconnectAttempt: bot.getReconnectAttempt(),
      uptimeMs: bot.getUptimeMs(),
    };
  }

  private attachRow(bot: BotInstance, row: Account): void {
    // Stash the row on the bot so summarize() can find it without an extra
    // DB call on every state change. Refreshed on any DB mutation.
    (bot as unknown as { __row: Account }).__row = row;
  }

  private spawnBot(row: Account): BotInstance {
    const bot = new BotInstance({
      id: row.id,
      ordinal: row.ordinal,
      label: row.label,
      username: row.username,
      authType: row.authType,
      serverHost: row.serverHost,
      serverPort: row.serverPort,
      version: row.version,
      behaviors: row.behaviors,
    });
    this.attachRow(bot, row);

    bot.on('state', () => {
      const summary = this.getSummary(row.id);
      if (summary) {
        this.persistState(row.id, summary.state, bot.getLastError(), bot.getLastConnectedAt())
          .catch((err) => logger.warn({ err, accountId: row.id }, 'persist state failed'));
        this.emit('account-changed', summary);
      }
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
        desiredState: input.autoConnect ? 'running' : 'stopped',
      },
    });
    const bot = this.spawnBot(row);
    if (input.authType === 'offline' && input.autoConnect) {
      bot.start();
    }
    // For MS, the user must complete device-code auth before start() works.
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
    this.attachRow(bot, row);
    if (patch.behaviors !== undefined) {
      bot.updateBehaviors(row.behaviors);
    }
    const summary = this.summarize(bot, row);
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
    this.attachRow(bot, row);
    bot.start();
    return this.summarize(bot, row);
  }

  async stopAccount(id: string): Promise<AccountSummary> {
    const bot = this.bots.get(id);
    if (!bot) throw new AppError(ErrorCodes.ACCOUNT_NOT_FOUND, 'Account not found', 404);
    const row = await prisma.account.update({
      where: { id },
      data: { desiredState: 'stopped' },
    });
    this.attachRow(bot, row);
    await bot.stop();
    return this.summarize(bot, row);
  }

  async deleteAccount(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (bot) await bot.stop();
    this.bots.delete(id);
    await prisma.account.delete({ where: { id } }).catch((err) => {
      logger.warn({ err, id }, 'delete-account: db delete failed (may already be gone)');
    });
    // Drop any cached MS tokens / disk cache so the auth slate is clean.
    await deleteAuthCache(id).catch(() => undefined);
    this.emit('account-removed', id);
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

// Silence the "MaxListenersExceededWarning" — one listener per connected
// WS client on a busy multi-account dashboard is normal.
accountManager.setMaxListeners(0);
