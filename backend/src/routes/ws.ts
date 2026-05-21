import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { logger } from '../logger.js';
import { verifyUpgradeAuth } from '../middleware/auth.js';
import { accountManager } from '../minecraft/account-manager.js';
import type {
  AccountSummary,
  BotLifecycleEvent,
  ChatEvent,
  WsInbound,
  WsOutbound,
} from '../minecraft/events.js';

/**
 * WebSocket layer. Single endpoint `/ws` with topic-based pub/sub:
 *
 *   subscribe topic "accounts"        — receive AccountSummary on every change
 *   subscribe topic "account:<uuid>"  — receive chat + lifecycle for that bot
 *
 * Auth is checked on the HTTP upgrade via the same cookie used for REST
 * (or `Authorization: Bearer` for non-browser clients) so unauthenticated
 * sockets never reach `connection`. The legacy `?token=` query parameter
 * is intentionally rejected — it leaks the token into proxy access logs.
 *
 * Failed upgrades are rate-limited per-IP to bound brute force of the
 * dashboard token via the upgrade endpoint.
 */

const inboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topic: z.string().min(1).max(128) }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('chat'),
    accountId: z.string().uuid(),
    // Strip CR/LF after the length check so a chat call can't stack commands.
    message: z.string().min(1).max(256),
  }),
]);

const ACCOUNTS_TOPIC = 'accounts';
const accountTopic = (id: string) => `account:${id}`;

interface SocketState {
  subscriptions: Set<string>;
}

const sockets = new WeakMap<WebSocket, SocketState>();

// Simple per-IP failed-auth tracker for /ws upgrades. Resets every minute.
const upgradeFailures = new Map<string, { count: number; firstAt: number }>();
const UPGRADE_FAIL_WINDOW_MS = 60_000;
const UPGRADE_FAIL_LIMIT = 20;

function trackUpgradeFailure(ip: string): boolean {
  const now = Date.now();
  const rec = upgradeFailures.get(ip);
  if (!rec || now - rec.firstAt > UPGRADE_FAIL_WINDOW_MS) {
    upgradeFailures.set(ip, { count: 1, firstAt: now });
    return true;
  }
  rec.count += 1;
  return rec.count <= UPGRADE_FAIL_LIMIT;
}

// Lightweight broadcast helper: serialize once per message, fan out the
// stringified payload to every interested socket.
function broadcast(
  clients: Set<WebSocket>,
  msg: WsOutbound,
  matches: (ws: WebSocket) => boolean,
): void {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!matches(ws)) continue;
    try {
      ws.send(payload);
    } catch (err) {
      logger.debug({ err }, 'ws: send failed');
    }
  }
}

function sendOne(ws: WebSocket, msg: WsOutbound): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    logger.debug({ err }, 'ws: send failed');
  }
}

function getState(ws: WebSocket): SocketState {
  let s = sockets.get(ws);
  if (!s) {
    s = { subscriptions: new Set() };
    sockets.set(ws, s);
  }
  return s;
}

function isSubscribed(ws: WebSocket, topic: string): boolean {
  return sockets.get(ws)?.subscriptions.has(topic) ?? false;
}

export function attachWebSocket(server: HttpServer): WebSocketServer {
  // Cap WS frame size — default is 100 MiB, which is an authenticated DoS
  // vector and absurd for our payloads (account summaries + chat lines).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    try {
      if (!req.url) {
        socket.destroy();
        return;
      }
      const parsed = new URL(req.url, 'http://placeholder');
      if (parsed.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!trackUpgradeFailure(ip)) {
        logger.warn({ ip }, 'ws: upgrade rate-limited');
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!verifyUpgradeAuth(req.headers)) {
        logger.warn({ ip, path: parsed.pathname }, 'ws: auth failed on upgrade');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // Successful upgrade — reset this IP's failure budget so a legitimate
      // user reconnecting frequently doesn't get throttled.
      upgradeFailures.delete(ip);
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      logger.error({ err }, 'ws: upgrade handler threw');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress;
    logger.info({ ip }, 'ws: client connected');
    getState(ws); // initialize state

    ws.on('message', (raw: RawData) => {
      let parsed: WsInbound;
      try {
        const json = JSON.parse(raw.toString()) as unknown;
        parsed = inboundSchema.parse(json) as WsInbound;
      } catch {
        sendOne(ws, { type: 'error', code: 'VALIDATION_ERROR', message: 'Invalid message' });
        return;
      }

      switch (parsed.type) {
        case 'subscribe': {
          getState(ws).subscriptions.add(parsed.topic);
          // Snapshot the current world so the client doesn't wait for the
          // next event to populate its UI.
          if (parsed.topic === ACCOUNTS_TOPIC) {
            for (const summary of accountManager.listSummaries()) {
              sendOne(ws, { type: 'account-update', account: summary });
            }
          } else if (parsed.topic.startsWith('account:')) {
            const id = parsed.topic.slice('account:'.length);
            const summary = accountManager.getSummary(id);
            if (summary) sendOne(ws, { type: 'account-update', account: summary });
          }
          break;
        }
        case 'unsubscribe':
          getState(ws).subscriptions.delete(parsed.topic);
          break;
        case 'chat': {
          // Drop control chars + collapse internal whitespace.
          const cleaned = parsed.message.replace(/[\r\n]+/g, ' ').trim();
          if (!cleaned) {
            sendOne(ws, { type: 'error', code: 'VALIDATION_ERROR', message: 'Empty message' });
            return;
          }
          try {
            accountManager.sendChat(parsed.accountId, cleaned);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'send failed';
            sendOne(ws, { type: 'error', code: 'CHAT_FAILED', message });
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      logger.debug({ ip }, 'ws: client disconnected');
    });

    ws.on('error', (err: Error) => {
      logger.debug({ err, ip }, 'ws: socket error');
    });
  });

  // Wire AccountManager events into the broadcast layer. Payload is
  // JSON-serialized once per event, not per client.
  const onAccountChanged = (summary: AccountSummary): void => {
    const acctTopic = accountTopic(summary.id);
    broadcast(
      wss.clients,
      { type: 'account-update', account: summary },
      (ws) => isSubscribed(ws, ACCOUNTS_TOPIC) || isSubscribed(ws, acctTopic),
    );
  };
  const onAccountRemoved = (accountId: string): void => {
    broadcast(
      wss.clients,
      { type: 'account-removed', accountId },
      (ws) => isSubscribed(ws, ACCOUNTS_TOPIC) || isSubscribed(ws, accountTopic(accountId)),
    );
  };
  const onChat = (accountId: string, chat: ChatEvent): void => {
    const topic = accountTopic(accountId);
    broadcast(wss.clients, { type: 'chat', accountId, chat }, (ws) => isSubscribed(ws, topic));
  };
  const onLifecycle = (accountId: string, event: BotLifecycleEvent): void => {
    const topic = accountTopic(accountId);
    broadcast(
      wss.clients,
      { type: 'event', accountId, event },
      (ws) => isSubscribed(ws, topic) || isSubscribed(ws, ACCOUNTS_TOPIC),
    );
  };

  accountManager.on('account-changed', onAccountChanged);
  accountManager.on('account-removed', onAccountRemoved);
  accountManager.on('chat', onChat);
  accountManager.on('lifecycle', onLifecycle);

  return wss;
}
