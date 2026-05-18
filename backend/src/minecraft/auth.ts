import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Authflow, Titles } from 'prismarine-auth';
import { prisma } from '../db/client.js';
import { decryptJson, encryptJson, type EncryptedBlob } from '../db/crypto.js';
import { logger } from '../logger.js';

/**
 * Microsoft auth integration.
 *
 * Storage model (per spec):
 *   - Postgres `account_tokens` row holds the AUTHORITATIVE encrypted blob
 *     of the prismarine-auth cache directory for that account.
 *   - On bot connect, we materialize the blob to a temp on-disk cache dir
 *     under `data/.msauth-cache/<accountId>/` so mineflayer/prismarine-auth
 *     can read it. After mineflayer refreshes tokens (which it does
 *     transparently before expiry), we re-encrypt the dir back into the DB.
 *
 * Why both layers: prismarine-auth requires a filesystem cache, but the
 * spec demands tokens be encrypted at rest in Postgres. Disk is treated as
 * a working copy; the DB is truth. Wiping the disk cache and restoring from
 * the DB is a no-op for the user.
 */
export interface DeviceCodeStartResult {
  userCode: string;
  verificationUri: string;
  expiresAt: string; // ISO
}

export interface DeviceFlowState {
  status: 'pending' | 'success' | 'failed';
  userCode?: string;
  verificationUri?: string;
  expiresAt?: string;
  errorMessage?: string;
  msUsername?: string; // The user's actual MS profile name, captured after auth
}

const CACHE_ROOT = resolve(process.env.MSAUTH_CACHE_DIR ?? './data/.msauth-cache');

function cacheDirFor(accountId: string): string {
  return join(CACHE_ROOT, accountId);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function walk(dir: string, base = dir): Promise<Array<{ rel: string; data: string }>> {
  const out: Array<{ rel: string; data: string }> = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (ent.isFile()) {
      const data = await readFile(full, 'utf8');
      out.push({ rel: relative(base, full).replace(/\\/g, '/'), data });
    }
  }
  return out;
}

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Active device-code flows, keyed by accountId. In-memory only — the user
 * either finishes the device code dance in the ~15min window or starts over.
 */
const activeFlows = new Map<string, DeviceFlowState>();

/**
 * Kick off a Microsoft device code flow for an account. Returns the code+URI
 * immediately; the actual token fetch continues in the background. Caller
 * polls `getFlowState(accountId)` for completion.
 */
export async function startDeviceCodeFlow(
  accountId: string,
  identifierHint: string,
): Promise<DeviceCodeStartResult> {
  // Wipe any previous flow's disk cache so we don't accidentally reuse a
  // half-completed auth against the wrong identifier.
  await rm(cacheDirFor(accountId), { recursive: true, force: true });
  await ensureDir(cacheDirFor(accountId));

  // Promise that resolves the moment prismarine-auth surfaces the device code.
  let resolveCode: (v: DeviceCodeStartResult) => void = () => undefined;
  let rejectCode: (err: unknown) => void = () => undefined;
  const codePromise = new Promise<DeviceCodeStartResult>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const state: DeviceFlowState = { status: 'pending' };
  activeFlows.set(accountId, state);

  const flow = new Authflow(
    identifierHint,
    cacheDirFor(accountId),
    {
      flow: 'live',
      authTitle: Titles.MinecraftJava,
      deviceType: 'Win32',
    },
    (data) => {
      // Microsoft's device authorization response is snake_case on the wire.
      const expiresInSec = (data as { expires_in?: number }).expires_in ?? 900;
      const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
      state.userCode = data.user_code;
      state.verificationUri = data.verification_uri;
      state.expiresAt = expiresAt;
      resolveCode({
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt,
      });
    },
  );

  // Run the token fetch in the background. Once it succeeds, persist the
  // disk cache to the DB and mark the flow `success`.
  void (async () => {
    try {
      const mcToken = await flow.getMinecraftJavaToken({ fetchProfile: true });
      const profile = (mcToken as { profile?: { name?: string } }).profile;
      if (profile?.name) state.msUsername = profile.name;
      await syncDiskCacheToDb(accountId);
      state.status = 'success';
      logger.info({ accountId, msUsername: state.msUsername }, 'ms-auth: device flow completed');
    } catch (err) {
      state.status = 'failed';
      state.errorMessage = err instanceof Error ? err.message : 'unknown auth error';
      logger.error({ err, accountId }, 'ms-auth: device flow failed');
      rejectCode(err);
    }
  })();

  return codePromise;
}

export function getFlowState(accountId: string): DeviceFlowState | undefined {
  return activeFlows.get(accountId);
}

export function clearFlowState(accountId: string): void {
  activeFlows.delete(accountId);
}

/**
 * Read the on-disk prismarine-auth cache for this account, encrypt the
 * file contents, and write to `account_tokens`. Called after successful
 * auth and any time we observe a token refresh on disk.
 */
export async function syncDiskCacheToDb(accountId: string): Promise<void> {
  const dir = cacheDirFor(accountId);
  if (!(await dirHasFiles(dir))) {
    logger.warn({ accountId, dir }, 'ms-auth: disk cache empty, nothing to sync');
    return;
  }
  const files = await walk(dir);
  const blob: EncryptedBlob = encryptJson({ files });
  await prisma.accountToken.upsert({
    where: { accountId },
    update: {
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
    },
    create: {
      accountId,
      ciphertext: blob.ciphertext,
      nonce: blob.nonce,
      authTag: blob.authTag,
    },
  });
  logger.debug({ accountId, fileCount: files.length }, 'ms-auth: disk cache synced to db');
}

/**
 * Materialize the encrypted blob from `account_tokens` back to disk so
 * prismarine-auth/mineflayer can read it on the next connect. No-op if the
 * disk cache already has content.
 */
export async function restoreDbCacheToDisk(accountId: string): Promise<boolean> {
  const dir = cacheDirFor(accountId);
  if (await dirHasFiles(dir)) return true;

  const row = await prisma.accountToken.findUnique({ where: { accountId } });
  if (!row) {
    logger.warn({ accountId }, 'ms-auth: no cached token row found in db');
    return false;
  }

  const decoded = decryptJson<{ files: Array<{ rel: string; data: string }> }>({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.authTag,
  });

  await ensureDir(dir);
  for (const { rel, data } of decoded.files) {
    const full = join(dir, rel);
    await ensureDir(dirname(full));
    await writeFile(full, data, 'utf8');
  }
  logger.info({ accountId, fileCount: decoded.files.length }, 'ms-auth: disk cache restored from db');
  return true;
}

/**
 * The path mineflayer's `profilesFolder` option should point at. We make
 * sure it exists and (best-effort) is hydrated from the DB.
 */
export async function getProfilesFolder(accountId: string): Promise<string> {
  const dir = cacheDirFor(accountId);
  await ensureDir(dir);
  await restoreDbCacheToDisk(accountId);
  return dir;
}

export async function deleteAuthCache(accountId: string): Promise<void> {
  await rm(cacheDirFor(accountId), { recursive: true, force: true });
  await prisma.accountToken.deleteMany({ where: { accountId } });
}
