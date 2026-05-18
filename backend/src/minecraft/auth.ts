import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
 *
 * File payloads are stored as base64 inside the blob so binary files
 * round-trip losslessly (prismarine-auth has historically written binary
 * content in some cache variants; UTF-8 decoding silently mangles bytes).
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

/**
 * Reject any path that escapes its parent. Defends against tampered DB
 * blobs producing `rel` values like `../../etc/cron.d/x`.
 */
function isContained(parent: string, candidate: string): boolean {
  const p = resolve(parent);
  const c = resolve(candidate);
  return c === p || c.startsWith(p + sep);
}

interface FileEntry {
  rel: string;
  b64: string;
}

async function walk(dir: string, base = dir): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
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
      // Read as Buffer + base64-encode. Lossless for binary OR text.
      const buf = await readFile(full);
      out.push({ rel: relative(base, full).replace(/\\/g, '/'), b64: buf.toString('base64') });
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
 * Per-account lock for cache↔DB sync. Two flows may complete in parallel
 * (device code finishing while spawn fires), and last-writer-wins on the
 * DB row can clobber a newer refresh token with an older one.
 */
const syncLocks = new Map<string, Promise<void>>();

async function withSyncLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = syncLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  syncLocks.set(
    accountId,
    prev.then(() => next),
  );
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // If this was the latest lock holder, clear the entry to avoid an
    // unbounded chain of resolved promises.
    if (syncLocks.get(accountId) === prev.then(() => next)) {
      syncLocks.delete(accountId);
    }
  }
}

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
 * file contents, and write to `account_tokens`. Serialized per-account.
 */
export async function syncDiskCacheToDb(accountId: string): Promise<void> {
  await withSyncLock(accountId, async () => {
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
  });
}

/**
 * Materialize the encrypted blob from `account_tokens` back to disk so
 * prismarine-auth/mineflayer can read it on the next connect. The DB is
 * authoritative — if its blob is newer than the on-disk cache (or if disk
 * is empty), we overwrite disk from DB. If there's no DB row, leave disk
 * alone.
 *
 * Path-traversal containment: every restored file path is checked against
 * the per-account cache directory. Anything escaping (e.g. via tampered
 * `rel: '../../foo'`) is rejected and logged.
 */
export async function restoreDbCacheToDisk(accountId: string): Promise<boolean> {
  return withSyncLock(accountId, async () => {
    const dir = cacheDirFor(accountId);
    const row = await prisma.accountToken.findUnique({ where: { accountId } });
    if (!row) {
      logger.debug({ accountId }, 'ms-auth: no cached token row found in db');
      return false;
    }

    // DB is authoritative. Wipe any stale on-disk content before restore so
    // we don't merge two generations.
    await rm(dir, { recursive: true, force: true });
    await ensureDir(dir);

    let decoded: { files: FileEntry[] };
    try {
      decoded = decryptJson<{ files: FileEntry[] }>({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
      });
    } catch (err) {
      logger.error({ err, accountId }, 'ms-auth: token blob decrypt/tamper');
      return false;
    }

    if (!Array.isArray(decoded.files)) {
      logger.error({ accountId }, 'ms-auth: decoded blob has no files array — refusing to restore');
      return false;
    }

    for (const entry of decoded.files) {
      if (typeof entry?.rel !== 'string' || typeof entry?.b64 !== 'string') {
        logger.warn({ accountId, entry }, 'ms-auth: malformed file entry, skipping');
        continue;
      }
      const full = join(dir, entry.rel);
      if (!isContained(dir, full)) {
        logger.error(
          { accountId, rel: entry.rel },
          'ms-auth: path-traversal attempt in restored blob — refusing',
        );
        // Bail out entirely — a tampered blob is not partially trustworthy.
        return false;
      }
      await ensureDir(dirname(full));
      await writeFile(full, Buffer.from(entry.b64, 'base64'));
    }
    logger.info({ accountId, fileCount: decoded.files.length }, 'ms-auth: disk cache restored from db');
    return true;
  });
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

/**
 * Does this account have a persisted (encrypted) token row?
 * Used by AccountManager to decide whether to auto-start an MS bot on boot.
 */
export async function hasPersistedTokens(accountId: string): Promise<boolean> {
  const row = await prisma.accountToken.findUnique({
    where: { accountId },
    select: { accountId: true },
  });
  return row !== null;
}

export async function deleteAuthCache(accountId: string): Promise<void> {
  await rm(cacheDirFor(accountId), { recursive: true, force: true });
  await prisma.accountToken.deleteMany({ where: { accountId } });
}

// Test-only: exposed for unit tests of the containment check.
export const __testing = { isContained, cacheDirFor, CACHE_ROOT };
