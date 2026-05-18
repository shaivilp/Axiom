/**
 * Typed events emitted by BotInstance → AccountManager → WebSocket layer.
 * Single source of truth for the wire format; the frontend re-imports the
 * same shapes via a hand-mirrored type file.
 */

export type ChatKind = 'system' | 'chat' | 'whisper' | 'self';

export interface ChatEvent {
  kind: ChatKind;
  text: string;
  sender?: string;
  timestamp: string; // ISO
}

export type BotState =
  | 'idle'
  | 'authenticating'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export interface BotStatusEvent {
  state: BotState;
  lastError?: string;
  lastConnectedAt?: string; // ISO
  reconnectAttempt: number;
  uptimeMs: number;
  username?: string;
}

export interface BotLifecycleEvent {
  kind: 'spawn' | 'login' | 'kicked' | 'error' | 'end' | 'auth-needed';
  details?: string;
  timestamp: string; // ISO
}

/** Account summary pushed on the `accounts` topic (list view). */
export interface AccountSummary {
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
  state: BotState;
  lastError: string | null;
  lastConnectedAt: string | null;
  reconnectAttempt: number;
  uptimeMs: number;
}

/** Inbound (client → server) WS messages. */
export type WsInbound =
  | { type: 'subscribe'; topic: string }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'chat'; accountId: string; message: string };

/** Outbound (server → client) WS messages. */
export type WsOutbound =
  | { type: 'account-update'; account: AccountSummary }
  | { type: 'account-removed'; accountId: string }
  | { type: 'chat'; accountId: string; chat: ChatEvent }
  | { type: 'event'; accountId: string; event: BotLifecycleEvent }
  | { type: 'error'; code: string; message: string };
