import type {
  AccountSummary,
  BehaviorConfig,
  DeviceCodeFlow,
  DeviceFlowStatus,
  SettingsRow,
} from './types';

/**
 * Single fetch wrapper.
 *
 *   - Sends `credentials: 'include'` so the HttpOnly session cookie travels
 *     with every request (set by /api/v1/auth/login).
 *   - Triggers a logout-style redirect on 401 (cookie absent / expired).
 *
 * No bearer token is ever read from localStorage — XSS cannot exfiltrate
 * the session.
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

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(cb: () => void): void {
  onUnauthorized = cb;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
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
  // Auth session
  login: (token: string) =>
    request<void>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

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
