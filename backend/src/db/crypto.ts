import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex');

if (KEY.length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
}

export interface EncryptedBlob {
  ciphertext: string; // base64
  nonce: string; // base64
  authTag: string; // base64
}

export function encryptJson(value: unknown): EncryptedBlob {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, nonce);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptJson<T = unknown>(blob: EncryptedBlob): T {
  const nonce = Buffer.from(blob.nonce, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, KEY, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
