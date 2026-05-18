import type {
  AccountSummary,
  BehaviorConfig,
  DeviceCodeFlow,
  DeviceFlowStatus,
  SettingsRow,
} from './types';

/**
 * Single fetch wrapper that:
 *   1. Injects the dashboard bearer token from localStorage
 *   2. Parses JSON and throws ApiClientError on non-2xx
 *   3. Triggers a logout (clear token + redirect) on 401
 *
 * Everything else is just typed wrappers around it.
 */
export class ApiClientError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TOKEN_KEY = 'afkbot.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(cb: () => void): void {
  onUnauthorized = cb;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api/v1${path}`, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    onUnauthorized?.();
    throw new ApiClientError('Unauthorized', 'INVALID_TOKEN', 401);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiClientError(`HTTP ${res.status}`, 'INVALID_RESPONSE', res.status);
  }

  if (!res.ok) {
    const errBody = body as { error?: { code?: string; message?: string } };
    throw new ApiClientError(
      errBody.error?.message ?? `HTTP ${res.status}`,
      errBody.error?.code ?? 'INTERNAL_ERROR',
      res.status,
    );
  }

  return body as T;
}

export const api = {
  ping: () => request<{ pong: boolean }>('/ping'),
  whoami: () => request<{ authenticated: boolean }>('/whoami'),

  listAccounts: () => request<{ accounts: AccountSummary[] }>('/accounts'),
  getAccount: (id: string) => request<{ account: AccountSummary }>(`/accounts/${id}`),
  createAccount: (input: {
    label: string;
    username: string;
    authType: 'offline' | 'microsoft';
    serverHost: string;
    serverPort: number;
    version: string;
    autoConnect: boolean;
    behaviors?: BehaviorConfig;
  }) =>
    request<{ account: AccountSummary }>('/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAccount: (
    id: string,
    patch: Partial<{
      label: string;
      serverHost: string;
      serverPort: number;
      version: string;
      autoConnect: boolean;
      behaviors: BehaviorConfig;
    }>,
  ) =>
    request<{ account: AccountSummary }>(`/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteAccount: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),
  startAccount: (id: string) =>
    request<{ account: AccountSummary }>(`/accounts/${id}/start`, { method: 'POST' }),
  stopAccount: (id: string) =>
    request<{ account: AccountSummary }>(`/accounts/${id}/stop`, { method: 'POST' }),
  sendChat: (id: string, message: string) =>
    request<{ sent: boolean }>(`/accounts/${id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Microsoft auth flow
  startMsAuth: (id: string) =>
    request<{ flow: DeviceCodeFlow }>(`/accounts/${id}/auth/start`, { method: 'POST' }),
  getMsAuthStatus: (id: string) =>
    request<DeviceFlowStatus>(`/accounts/${id}/auth/status`),
  completeMsAuth: (id: string) =>
    request<{ account: AccountSummary }>(`/accounts/${id}/auth/complete`, { method: 'POST' }),

  // Settings
  getSettings: () => request<{ settings: SettingsRow }>('/settings'),
  updateSettings: (
    patch: Partial<{
      defaultServerHost: string | null;
      defaultServerPort: number | null;
      defaultVersion: string | null;
      defaultBehaviors: BehaviorConfig;
    }>,
  ) =>
    request<{ settings: SettingsRow }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
