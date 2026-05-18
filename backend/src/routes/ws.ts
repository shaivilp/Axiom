import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { logger } from '../logger.js';
import { verifyToken } from '../middleware/auth.js';
import { accountManager } from '../minecraft/account-manager.js';
import type {
  AccountSummary,
  BotLifecycleEvent,
  ChatEvent,
  WsInbound,
  WsOutbound,
} from '../minecraft/events.js';

/**
 * WebSocket layer. Single endpoint `/ws?token=<bearer>` with topic-based
 * pub/sub:
 *
 *   subscribe topic "accounts"        — receive AccountSummary on every change
 *   subscribe topic "account:<uuid>"  — receive chat + lifecycle for that bot
 *
 * Auth is checked on the HTTP upgrade so unauthenticated sockets never
 * even reach `connection`. The same dashboard token (bearer in REST, query
 * string here) protects both surfaces.
 */

const inboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topic: z.string().min(1).max(128) }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string().min(1).max(128) }),
  z.object({
    type: z.literal('chat'),
    accountId: z.string().uuid(),
    message: z.string().min(1).max(256),
  }),
]);

const ACCOUNTS_TOPIC = 'accounts';
const accountTopic = (id: string) => `account:${id}`;

interface SocketState {
  subscriptions: Set<string>;
}

const sockets = new WeakMap<WebSocket, SocketState>();

function send(ws: WebSocket, msg: WsOutbound): void {
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
  const wss = new WebSocketServer({ noServer: true });

  // Auth at upgrade time. We piggyback on the HTTP server's `upgrade` event
  // so unauthenticated requests never allocate a WebSocket.
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    try {
      if (!req.url) {
        socket.destroy();
        return;
      }
      // Only handle our /ws path; other upgrade requests fall through.
      const parsed = new URL(req.url, 'http://placeholder');
      if (parsed.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = parsed.searchParams.get('token');
      if (!verifyToken(token)) {
        logger.warn(
          { ip: req.socket.remoteAddress, path: parsed.pathname },
          'ws: auth failed on upgrade',
        );
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      logger.error({ err }, 'ws: upgrade handler threw');
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info({ ip }, 'ws: client connected');
    getState(ws); // initialize state

    ws.on('message', (raw) => {
      let parsed: WsInbound;
      try {
        const json = JSON.parse(raw.toString()) as unknown;
        parsed = inboundSchema.parse(json) as WsInbound;
      } catch {
        send(ws, { type: 'error', code: 'VALIDATION_ERROR', message: 'Invalid message' });
        return;
      }

      switch (parsed.type) {
        case 'subscribe': {
          getState(ws).subscriptions.add(parsed.topic);
          // Snapshot the current world so the client doesn't wait for the
          // next event to populate its UI.
          if (parsed.topic === ACCOUNTS_TOPIC) {
            for (const summary of accountManager.listSummaries()) {
              send(ws, { type: 'account-update', account: summary });
            }
          } else if (parsed.topic.startsWith('account:')) {
            const id = parsed.topic.slice('account:'.length);
            const summary = accountManager.getSummary(id);
            if (summary) send(ws, { type: 'account-update', account: summary });
          }
          break;
        }
        case 'unsubscribe':
          getState(ws).subscriptions.delete(parsed.topic);
          break;
        case 'chat':
          try {
            accountManager.sendChat(parsed.accountId, parsed.message);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'send failed';
            send(ws, { type: 'error', code: 'CHAT_FAILED', message });
          }
          break;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      logger.debug({ ip }, 'ws: client disconnected');
    });

    ws.on('error', (err) => {
      logger.debug({ err, ip }, 'ws: socket error');
    });
  });

  // Wire AccountManager events into the broadcast layer.
  const onAccountChanged = (summary: AccountSummary): void => {
    const acctTopic = accountTopic(summary.id);
    for (const ws of wss.clients) {
      if (isSubscribed(ws, ACCOUNTS_TOPIC) || isSubscribed(ws, acctTopic)) {
        send(ws, { type: 'account-update', account: summary });
      }
    }
  };
  const onAccountRemoved = (accountId: string): void => {
    for (const ws of wss.clients) {
      if (isSubscribed(ws, ACCOUNTS_TOPIC) || isSubscribed(ws, accountTopic(accountId))) {
        send(ws, { type: 'account-removed', accountId });
      }
    }
  };
  const onChat = (accountId: string, chat: ChatEvent): void => {
    const topic = accountTopic(accountId);
    for (const ws of wss.clients) {
      if (isSubscribed(ws, topic)) {
        send(ws, { type: 'chat', accountId, chat });
      }
    }
  };
  const onLifecycle = (accountId: string, event: BotLifecycleEvent): void => {
    const topic = accountTopic(accountId);
    for (const ws of wss.clients) {
      if (isSubscribed(ws, topic) || isSubscribed(ws, ACCOUNTS_TOPIC)) {
        send(ws, { type: 'event', accountId, event });
      }
    }
  };

  accountManager.on('account-changed', onAccountChanged);
  accountManager.on('account-removed', onAccountRemoved);
  accountManager.on('chat', onChat);
  accountManager.on('lifecycle', onLifecycle);

  return wss;
}
