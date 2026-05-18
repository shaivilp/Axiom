import { describe, expect, it } from 'vitest';
import {
  computeBackoff,
  defaultReconnectPolicy,
  hasExceededRetries,
  type ReconnectPolicy,
} from '../src/minecraft/reconnect.js';

const noJitter: ReconnectPolicy = { ...defaultReconnectPolicy, jitterPct: 0 };

describe('computeBackoff', () => {
  it('returns 0 for attempt < 1', () => {
    expect(computeBackoff(0, noJitter)).toBe(0);
    expect(computeBackoff(-1, noJitter)).toBe(0);
  });

  it('doubles each attempt at factor 2 with no jitter', () => {
    expect(computeBackoff(1, noJitter)).toBe(2_000);
    expect(computeBackoff(2, noJitter)).toBe(4_000);
    expect(computeBackoff(3, noJitter)).toBe(8_000);
    expect(computeBackoff(4, noJitter)).toBe(16_000);
  });

  it('caps at the configured max delay', () => {
    // 2s * 2^15 = ~65s when uncapped; at attempt 100 it definitely exceeds 5min.
    expect(computeBackoff(100, noJitter)).toBe(noJitter.maxDelayMs);
  });

  it('with jitter, stays within ±jitterPct of the capped value', () => {
    const policy: ReconnectPolicy = { ...defaultReconnectPolicy, jitterPct: 0.2 };
    for (let i = 0; i < 200; i++) {
      const v = computeBackoff(3, policy); // base 8000
      // 8000 ± 20% = [6400, 9600]
      expect(v).toBeGreaterThanOrEqual(6_400 - 1); // round() slack
      expect(v).toBeLessThanOrEqual(9_600 + 1);
    }
  });
});

describe('hasExceededRetries', () => {
  it('returns true when attempt >= maxAttempts', () => {
    expect(hasExceededRetries(100)).toBe(true);
    expect(hasExceededRetries(101)).toBe(true);
  });
  it('returns false below the cap', () => {
    expect(hasExceededRetries(0)).toBe(false);
    expect(hasExceededRetries(99)).toBe(false);
  });
});
