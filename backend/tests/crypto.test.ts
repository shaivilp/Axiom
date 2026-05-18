import { describe, expect, it, beforeAll } from 'vitest';

// Set env BEFORE the module under test loads (config validates at import time).
beforeAll(() => {
  process.env.DASHBOARD_TOKEN = 'a'.repeat(32);
  process.env.TOKEN_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/x';
  process.env.ALLOWED_ORIGIN = 'http://localhost:8080';
});

describe('crypto roundtrip', () => {
  it('encrypts and decrypts JSON values', async () => {
    const { encryptJson, decryptJson } = await import('../src/db/crypto.js');
    const value = { hello: 'world', n: 42, nested: { a: [1, 2, 3] } };
    const blob = encryptJson(value);
    expect(blob.ciphertext).toBeTruthy();
    expect(blob.nonce).toBeTruthy();
    expect(blob.authTag).toBeTruthy();
    const restored = decryptJson<typeof value>(blob);
    expect(restored).toEqual(value);
  });

  it('produces a different ciphertext for the same plaintext (random nonce)', async () => {
    const { encryptJson } = await import('../src/db/crypto.js');
    const a = encryptJson({ x: 1 });
    const b = encryptJson({ x: 1 });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('rejects tampered ciphertext (GCM auth tag)', async () => {
    const { encryptJson, decryptJson } = await import('../src/db/crypto.js');
    const blob = encryptJson({ x: 1 });
    // Flip a base64 char in the ciphertext.
    const tampered = {
      ...blob,
      ciphertext: blob.ciphertext.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
    };
    expect(() => decryptJson(tampered)).toThrow();
  });
});
