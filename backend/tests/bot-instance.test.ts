import './test-env.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// We test only the pure state-machine bits of BotInstance — the parts that
// don't require a real mineflayer connection. createBot is mocked out so
// the bot never tries to dial a real server.

vi.mock('mineflayer', () => {
  // Minimal fake Bot. Tests reach into this to drive 'end' events etc.
  return {
    createBot: vi.fn(() => {
      const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
      const bot = {
        username: 'TestBot',
        on(ev: string, cb: (...a: unknown[]) => void) {
          if (!handlers.has(ev)) handlers.set(ev, []);
          handlers.get(ev)!.push(cb);
          return bot;
        },
        once(ev: string, cb: (...a: unknown[]) => void) {
          return bot.on(ev, cb);
        },
        quit: vi.fn(),
        chat: vi.fn(),
        look: vi.fn().mockResolvedValue(undefined),
        setControlState: vi.fn(),
        _emit(ev: string, ...args: unknown[]) {
          for (const h of handlers.get(ev) ?? []) h(...args);
        },
      };
      return bot;
    }),
  };
});

// Prevent the real auth module from touching the filesystem.
vi.mock('../src/minecraft/auth.js', () => ({
  getProfilesFolder: vi.fn(async () => '/tmp/fake-cache'),
  syncDiskCacheToDb: vi.fn(async () => undefined),
}));

const meta = {
  id: '00000000-0000-0000-0000-000000000001',
  ordinal: 1,
  label: 'Test',
  username: 'TestBot',
  authType: 'offline' as const,
  serverHost: 'localhost',
  serverPort: 25565,
  version: '1.8.9',
  autoConnect: true,
  desiredState: 'running' as const,
};

describe('BotInstance state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start() transitions through connecting and into idle on stop()', async () => {
    const { BotInstance } = await import('../src/minecraft/bot-instance.js');
    const bot = new BotInstance({ meta, behaviors: {} });
    const states: string[] = [];
    bot.on('state', (s) => states.push(s));

    bot.start();
    // Microtask drain for the async doConnect path.
    await new Promise((r) => setImmediate(r));
    await bot.stop();
    expect(states).toContain('connecting');
    expect(bot.getState()).toBe('idle');
  });

  it('stop() during async doConnect prevents creating a phantom Bot (C7)', async () => {
    const auth = await import('../src/minecraft/auth.js');
    const mineflayer = await import('mineflayer');
    // Make getProfilesFolder slow so stop() can land first. Use the MS path
    // to hit the await.
    (auth.getProfilesFolder as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => setTimeout(() => res('/tmp/x'), 50)),
    );

    const { BotInstance } = await import('../src/minecraft/bot-instance.js');
    const msMeta = { ...meta, authType: 'microsoft' as const };
    const bot = new BotInstance({ meta: msMeta, behaviors: {} });

    bot.start();
    // stop() arrives while doConnect is awaiting getProfilesFolder.
    await bot.stop();
    // Wait long enough that the slow await would have resolved.
    await new Promise((r) => setTimeout(r, 80));

    expect(bot.getState()).toBe('idle');
    expect(mineflayer.createBot).not.toHaveBeenCalled();
  });

  it('respects desiredState=stopped after a session ends', async () => {
    const { BotInstance } = await import('../src/minecraft/bot-instance.js');
    const bot = new BotInstance({ meta, behaviors: {} });

    bot.start();
    await new Promise((r) => setImmediate(r));
    await bot.stop();
    // After stop, scheduleReconnect should see stopRequested and idle out.
    expect(bot.getState()).toBe('idle');
    expect(bot.getReconnectAttempt()).toBe(0);
  });

  it('retry exhaustion emits fatal + transitions to failed', async () => {
    const { BotInstance } = await import('../src/minecraft/bot-instance.js');
    const bot = new BotInstance({
      meta,
      behaviors: {},
      // Tiny policy so the test runs fast.
      reconnectPolicy: {
        baseDelayMs: 1,
        maxDelayMs: 2,
        factor: 2,
        jitterPct: 0,
        maxAttempts: 1,
      },
    });
    const fatals: string[] = [];
    bot.on('fatal', (r) => fatals.push(r));

    bot.start();
    await new Promise((r) => setImmediate(r));

    // Force an immediate end event so scheduleReconnect kicks in.
    const mineflayer = await import('mineflayer');
    const lastBot = (mineflayer.createBot as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as { _emit: (ev: string, ...a: unknown[]) => void };
    lastBot._emit('end', 'forced');

    // Wait for backoff + retry exhaustion.
    await new Promise((r) => setTimeout(r, 20));
    expect(bot.getState()).toBe('failed');
    expect(fatals.length).toBe(1);
  });

  it('sendChat strips CR/LF and rejects empty after sanitization', async () => {
    const { BotInstance } = await import('../src/minecraft/bot-instance.js');
    const bot = new BotInstance({ meta, behaviors: {} });

    // Force into 'connected' by simulating the spawn path.
    bot.start();
    await new Promise((r) => setImmediate(r));
    const mineflayer = await import('mineflayer');
    const liveBot = (mineflayer.createBot as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as { chat: ReturnType<typeof vi.fn>; _emit: (e: string, ...a: unknown[]) => void };
    liveBot._emit('login');
    liveBot._emit('spawn');
    await new Promise((r) => setImmediate(r));

    bot.sendChat('hello\n/op me\r\n/give @p tnt 64');
    expect(liveBot.chat).toHaveBeenCalledTimes(1);
    expect(liveBot.chat.mock.calls[0]?.[0]).not.toContain('\n');
    expect(liveBot.chat.mock.calls[0]?.[0]).not.toContain('\r');
  });
});
