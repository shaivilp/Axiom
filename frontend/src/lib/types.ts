/**
 * Shared wire types — kept in sync by hand with backend/src/minecraft/events.ts
 * and backend/src/routes/*. Single source of truth for the JSON contract.
 */

export type BotState =
  | 'idle'
  | 'authenticating'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export type AuthType = 'offline' | 'microsoft';
export type DesiredState = 'running' | 'stopped';
export type ChatKind = 'system' | 'chat' | 'whisper' | 'self';

export interface AccountSummary {
  id: string;
  ordinal: number;
  label: string;
  username: string;
  authType: AuthType;
  serverHost: string;
  serverPort: number;
  version: string;
  autoConnect: boolean;
  desiredState: DesiredState;
  state: BotState;
  lastError: string | null;
  lastConnectedAt: string | null;
  reconnectAttempt: number;
  uptimeMs: number;
}

export interface ChatEvent {
  kind: ChatKind;
  text: string;
  sender?: string;
  timestamp: string;
}

export interface BotLifecycleEvent {
  kind: 'spawn' | 'login' | 'kicked' | 'error' | 'end' | 'auth-needed';
  details?: string;
  timestamp: string;
}

export interface WiggleConfig {
  enabled: boolean;
  intervalMs: number;
  jitterPct: number;
}
export interface ChatPingConfig {
  enabled: boolean;
  intervalMs: number;
  messages: string[];
}
export interface LoginCommand {
  command: string;
  delayMs: number;
}
export interface BehaviorConfig {
  wiggle: WiggleConfig;
  chatPing: ChatPingConfig;
  loginCommands: LoginCommand[];
}

export interface SettingsRow {
  id: string;
  defaultServerHost: string | null;
  defaultServerPort: number | null;
  defaultVersion: string | null;
  defaultBehaviors: BehaviorConfig | Record<string, never>;
  updatedAt: string;
}

export interface DeviceCodeFlow {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

export interface DeviceFlowStatus {
  status: 'idle' | 'pending' | 'success' | 'failed';
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  msUsername: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type WsInbound =
  | { type: 'subscribe'; topic: string }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'chat'; accountId: string; message: string };

export type WsOutbound =
  | { type: 'account-update'; account: AccountSummary }
  | { type: 'account-removed'; accountId: string }
  | { type: 'chat'; accountId: string; chat: ChatEvent }
  | { type: 'event'; accountId: string; event: BotLifecycleEvent }
  | { type: 'error'; code: string; message: string };
