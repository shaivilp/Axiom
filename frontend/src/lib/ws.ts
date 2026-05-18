import type { WsInbound, WsOutbound } from './types';

/**
 * Cookie-authenticated WebSocket client. Single shared connection.
 *
 *   - Browser sends the `afkbot_session` cookie automatically on the
 *     upgrade request — no token in the URL (no leak into proxy logs).
 *   - Reconnects with backoff when the socket drops.
 *   - Re-subscribes to all active topics on reconnect.
 */

type Handler = (msg: WsOutbound) => void;

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private subscriptions = new Map<string, number>(); // topic → refcount
  private wireSubscribed = new Set<string>(); // what we've actually told the server
  private reconnectTimer: number | null = null;
  private backoffMs = 1_000;
  private explicitlyClosed = false;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.explicitlyClosed = false;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // No `?token=...` — the HttpOnly session cookie travels on the upgrade
    // automatically.
    const url = `${proto}//${window.location.host}/ws`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.backoffMs = 1_000;
      // Re-send all known subscriptions after reconnect.
      this.wireSubscribed.clear();
      for (const topic of this.subscriptions.keys()) {
        this.sendRaw({ type: 'subscribe', topic });
        this.wireSubscribed.add(topic);
      }
    });

    this.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsOutbound;
        for (const h of this.handlers) {
          try {
            h(msg);
          } catch (err) {
            console.error('ws handler threw', err);
          }
        }
      } catch (err) {
        console.warn('ws: failed to parse message', err);
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.wireSubscribed.clear();
      if (this.explicitlyClosed) return;
      this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      // 'close' will follow — let it handle reconnect.
    });
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.wireSubscribed.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(this.backoffMs, 30_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.connect();
    }, delay);
  }

  private sendRaw(msg: WsInbound): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Reconcile our recorded intent against what's actually on the wire.
   * Called after every refcount change so the server view eventually
   * matches the client view regardless of socket state at the moment of
   * subscribe/unsubscribe.
   */
  private reconcile(): void {
    const desired = new Set(this.subscriptions.keys());
    // Add anything desired but not yet subscribed.
    for (const topic of desired) {
      if (!this.wireSubscribed.has(topic)) {
        this.sendRaw({ type: 'subscribe', topic });
        this.wireSubscribed.add(topic);
      }
    }
    // Drop anything subscribed but no longer desired.
    for (const topic of this.wireSubscribed) {
      if (!desired.has(topic)) {
        this.sendRaw({ type: 'unsubscribe', topic });
        this.wireSubscribed.delete(topic);
      }
    }
  }

  subscribe(topic: string): () => void {
    const count = this.subscriptions.get(topic) ?? 0;
    this.subscriptions.set(topic, count + 1);
    this.reconcile();
    return () => {
      const n = this.subscriptions.get(topic) ?? 0;
      if (n <= 1) {
        this.subscriptions.delete(topic);
      } else {
        this.subscriptions.set(topic, n - 1);
      }
      this.reconcile();
    };
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  sendChat(accountId: string, message: string): void {
    this.sendRaw({ type: 'chat', accountId, message });
  }
}

export const wsManager = new WsManager();
