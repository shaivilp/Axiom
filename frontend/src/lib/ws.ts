import type { WsInbound, WsOutbound } from './types';
import { getToken } from './api';

/**
 * Token-authenticated WebSocket client. Single shared connection for the
 * whole dashboard. Components subscribe to topics; the manager routes
 * incoming messages by topic and exposes typed handlers.
 *
 * Reconnects with backoff when the socket drops. Re-subscribes to all
 * active topics on reconnect so component listeners don't need to know
 * the socket cycled.
 */

type Handler = (msg: WsOutbound) => void;

class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private subscriptions = new Map<string, number>(); // topic → refcount
  private reconnectTimer: number | null = null;
  private backoffMs = 1_000;
  private explicitlyClosed = false;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const token = getToken();
    if (!token) return;
    this.explicitlyClosed = false;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.backoffMs = 1_000;
      // Re-send all known subscriptions after reconnect.
      for (const topic of this.subscriptions.keys()) {
        this.sendRaw({ type: 'subscribe', topic });
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

  subscribe(topic: string): () => void {
    const count = this.subscriptions.get(topic) ?? 0;
    this.subscriptions.set(topic, count + 1);
    if (count === 0) {
      this.sendRaw({ type: 'subscribe', topic });
    }
    return () => {
      const n = this.subscriptions.get(topic) ?? 0;
      if (n <= 1) {
        this.subscriptions.delete(topic);
        this.sendRaw({ type: 'unsubscribe', topic });
      } else {
        this.subscriptions.set(topic, n - 1);
      }
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
