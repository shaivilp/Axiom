import './test-env.js';
import { describe, expect, it } from 'vitest';

describe('verifyUpgradeAuth', () => {
  it('accepts a valid Bearer header', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(
      verifyUpgradeAuth({ authorization: `Bearer ${process.env.DASHBOARD_TOKEN}` }),
    ).toBe(true);
  });

  it('accepts a valid session cookie', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(verifyUpgradeAuth({ cookie: `afkbot_session=${process.env.DASHBOARD_TOKEN}` })).toBe(true);
  });

  it('accepts a valid cookie mixed with other cookies', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(
      verifyUpgradeAuth({
        cookie: `theme=dark; afkbot_session=${process.env.DASHBOARD_TOKEN}; locale=en`,
      }),
    ).toBe(true);
  });

  it('rejects an empty token', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(verifyUpgradeAuth({})).toBe(false);
    expect(verifyUpgradeAuth({ authorization: 'Bearer ' })).toBe(false);
    expect(verifyUpgradeAuth({ cookie: 'afkbot_session=' })).toBe(false);
  });

  it('rejects a wrong-length token', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(verifyUpgradeAuth({ authorization: 'Bearer too-short' })).toBe(false);
    expect(verifyUpgradeAuth({ authorization: 'Bearer ' + 'x'.repeat(1000) })).toBe(false);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    const real = process.env.DASHBOARD_TOKEN!;
    expect(verifyUpgradeAuth({ authorization: `Bearer ${real.slice(0, -1)}` })).toBe(false);
  });

  it('rejects array-valued cookie headers (no crash on weird inputs)', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    // Header value as an array (uncommon but valid in Node's IncomingHttpHeaders)
    expect(verifyUpgradeAuth({ cookie: ['afkbot_session=nope'] as unknown as string })).toBe(false);
  });

  it('rejects null/undefined', async () => {
    const { verifyUpgradeAuth } = await import('../src/middleware/auth.js');
    expect(verifyUpgradeAuth({ authorization: undefined, cookie: undefined })).toBe(false);
  });
});

describe('validateCredential', () => {
  it('accepts the configured DASHBOARD_TOKEN', async () => {
    const { validateCredential } = await import('../src/middleware/auth.js');
    expect(validateCredential(process.env.DASHBOARD_TOKEN!)).toBe(true);
  });

  it('rejects empty / whitespace / wrong values', async () => {
    const { validateCredential } = await import('../src/middleware/auth.js');
    expect(validateCredential('')).toBe(false);
    expect(validateCredential(' '.repeat(48))).toBe(false);
    expect(validateCredential('wrong'.repeat(20))).toBe(false);
  });
});
