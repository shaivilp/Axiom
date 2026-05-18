import { describe, expect, it } from 'vitest';
import {
  behaviorConfigSchema,
  parseBehaviorConfig,
  renderTemplate,
} from '../src/minecraft/behaviors/schema.js';

describe('behaviorConfigSchema', () => {
  it('returns a fully-defaulted config from {}', () => {
    const out = behaviorConfigSchema.parse({});
    expect(out.wiggle.enabled).toBe(true);
    expect(out.wiggle.intervalMs).toBe(30_000);
    expect(out.wiggle.jitterPct).toBe(0.2);
    expect(out.chatPing.enabled).toBe(false);
    expect(out.chatPing.intervalMs).toBe(60_000);
    expect(out.chatPing.messages).toEqual(['Still here.']);
    expect(out.loginCommands).toEqual([]);
  });

  it('preserves user-supplied fields and defaults the rest', () => {
    const out = behaviorConfigSchema.parse({
      chatPing: { enabled: true, intervalMs: 90_000, messages: ['hi', 'hello'] },
      loginCommands: [{ command: '/login pw' }],
    });
    expect(out.chatPing.enabled).toBe(true);
    expect(out.chatPing.intervalMs).toBe(90_000);
    expect(out.loginCommands[0]?.delayMs).toBe(1000);
    expect(out.wiggle.enabled).toBe(true);
  });

  it('rejects sub-minimum chat-ping intervals', () => {
    expect(() =>
      behaviorConfigSchema.parse({ chatPing: { intervalMs: 1_000, messages: ['x'] } }),
    ).toThrow();
  });
});

describe('parseBehaviorConfig', () => {
  it('treats null/undefined as defaults', () => {
    expect(parseBehaviorConfig(null).wiggle.enabled).toBe(true);
    expect(parseBehaviorConfig(undefined).wiggle.enabled).toBe(true);
  });
});

describe('renderTemplate', () => {
  const ctx = { ordinal: 7, username: 'Bob', label: 'AFK7' };

  it('substitutes {{ordinal}}, {{username}}, {{label}}', () => {
    expect(renderTemplate('/f warp cac{{ordinal}}', ctx)).toBe('/f warp cac7');
    expect(renderTemplate('hi {{username}}', ctx)).toBe('hi Bob');
    expect(renderTemplate('[{{label}}] online', ctx)).toBe('[AFK7] online');
  });

  it('tolerates inner whitespace', () => {
    expect(renderTemplate('cac{{ ordinal }}', ctx)).toBe('cac7');
  });

  it('leaves unknown tokens untouched', () => {
    expect(renderTemplate('hello {{nope}}', ctx)).toBe('hello {{nope}}');
  });

  it('replaces multiple occurrences', () => {
    expect(renderTemplate('{{ordinal}} and {{ordinal}}', ctx)).toBe('7 and 7');
  });
});
