/**
 * Exponential backoff with jitter, capped at 5 minutes (per spec).
 *
 * Sequence (base 2s, factor 2, cap 5min, jitter ±20%):
 *   2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s, ...
 *
 * After `maxAttempts` the AccountManager surfaces a permanent failure rather
 * than infinite-looping (spec quality bar).
 */
export interface ReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitterPct: number;
  maxAttempts: number;
}

export const defaultReconnectPolicy: ReconnectPolicy = {
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  factor: 2,
  jitterPct: 0.2,
  maxAttempts: 100,
};

export function computeBackoff(attempt: number, policy: ReconnectPolicy = defaultReconnectPolicy): number {
  if (attempt < 1) return 0;
  const raw = policy.baseDelayMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  // Jitter prevents thundering-herd reconnects from multiple accounts that
  // got dropped together (server restart, network blip).
  const jitter = capped * policy.jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export function hasExceededRetries(attempt: number, policy: ReconnectPolicy = defaultReconnectPolicy): boolean {
  return attempt >= policy.maxAttempts;
}
