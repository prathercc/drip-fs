import type { StreamDownloadOptions, StreamDownloadWriter } from './types';

/**
 * OPFS-staged download path.
 *
 * iOS WebKit (Safari, and every other iPhone/iPad browser, which all use
 * WebKit) forbids downloads that start inside an iframe: the service-worker
 * stream gets promoted to a top-level navigation that unloads the app.
 * Buffering the whole file as a Blob works but scales with RAM.
 *
 * This path drips chunks to the Origin Private File System through a Worker
 * holding a sync access handle (Safari 15.2+), so memory stays flat, then
 * hands the browser a File-backed object URL on close. A blob URL over an
 * OPFS File streams from disk, so the save itself does not load the file
 * into memory either. The staged file is removed on abort and swept on the
 * next call once it is older than STAGING_TTL_MS (the browser may still be
 * reading it right after close, so it is never deleted eagerly).
 */

export const STAGING_DIR = 'drip-fs-staging';
export const STAGING_TTL_MS = 60 * 60 * 1000;
/** Startup sweep tolerance: anything older than this cannot be an in-flight part of THIS page. */
export const STARTUP_SWEEP_TTL_MS = 5 * 60 * 1000;

/**
 * Staged files this page created whose writer has finished (closed). The
 * next part releases them, so a multi-part export occupies one part of
 * storage at a time instead of every part until the TTL sweep.
 */
const finishedStaged = new Set<string>();

/** @internal Test hook: forget finished parts from a previous test. */
export function _resetStagingState(): void {
  finishedStaged.clear();
}

const formatBytes = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(n / 1024 ** 2)} MB`;

/**
 * Refuse up front when the origin clearly cannot hold a part of `size`
 * bytes, so the caller gets a readable error instead of a mid-part write
 * failure. Skipped when the browser cannot estimate.
 */
export async function assertStagingRoom(size: number): Promise<void> {
  const estimate = await navigator.storage.estimate?.().catch(() => undefined);
  if (!estimate || estimate.quota == null || estimate.usage == null) return;
  const free = estimate.quota - estimate.usage;
  if (free < size) {
    throw new Error(
      `Not enough free storage to stage a ${formatBytes(size)} download part (about ${formatBytes(Math.max(free, 0))} available). Lower the part size or free some space.`
    );
  }
}

/** iPhone/iPad, including iPadOS reporting a desktop Mac UA with touch. */
export function isIOSWebKit(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent || '';
  return /iP(hone|ad|od)/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

/**
 * What the main thread can see of OPFS. `createSyncAccessHandle` only
 * exists on FileSystemFileHandle INSIDE a worker, so it cannot be probed
 * here; a missing handle surfaces as the worker's 'open' error instead,
 * which createStreamingDownload turns into the Blob fallback.
 */
export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

/**
 * Worker body, inlined so consumers need no bundler configuration. It is
 * intentionally plain JS: the file handle crosses via postMessage and the
 * sync access handle never leaves the worker.
 */
export const OPFS_WORKER_SOURCE = `
let handle = null;
let offset = 0;
self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'open') {
      handle = await msg.fileHandle.createSyncAccessHandle();
      handle.truncate(0);
      offset = 0;
      self.postMessage({ type: 'opened' });
    } else if (msg.type === 'write') {
      handle.write(msg.chunk, { at: offset });
      offset += msg.chunk.byteLength;
      self.postMessage({ type: 'written', bytes: offset });
    } else if (msg.type === 'close') {
      handle.flush();
      handle.close();
      handle = null;
      self.postMessage({ type: 'closed', bytes: offset });
    } else if (msg.type === 'abort') {
      if (handle) { handle.close(); handle = null; }
      self.postMessage({ type: 'aborted' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
`;

/** @internal Exposed for tests. */
export function createOpfsWorker(): Worker {
  const url = URL.createObjectURL(new Blob([OPFS_WORKER_SOURCE], { type: 'text/javascript' }));
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Drop staged files older than the TTL. Best effort; never throws. */
export async function sweepStaging(
  dir: FileSystemDirectoryHandle,
  now = Date.now(),
  ttlMs = STAGING_TTL_MS
): Promise<void> {
  try {
    const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, entry] of entries) {
      if (entry.kind !== 'file') continue;
      const stamp = Number(name.split('-')[0]);
      if (Number.isFinite(stamp) && now - stamp > ttlMs) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    /* sweeping is a nicety */
  }
}

/** Release staged files whose writers already closed (previous parts). */
async function releaseFinished(dir: FileSystemDirectoryHandle): Promise<void> {
  for (const name of [...finishedStaged]) {
    finishedStaged.delete(name);
    await dir.removeEntry(name).catch(() => undefined);
  }
}

/**
 * Call once at app startup: clears staged downloads left by earlier
 * sessions (a closed tab never gets to its own next-part release). No-op
 * where OPFS is unavailable; never throws.
 */
export async function sweepStagedDownloads(ttlMs = STARTUP_SWEEP_TTL_MS): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STAGING_DIR, { create: false }).catch(() => null);
    if (dir) await sweepStaging(dir, Date.now(), ttlMs);
  } catch {
    /* best effort */
  }
}

/** Save a File through a hidden download anchor (file-backed URL). */
function saveFile(file: File, filename: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export async function createOpfsDownload(
  filename: string,
  options: StreamDownloadOptions = {}
): Promise<StreamDownloadWriter> {
  const { onProgress, size } = options;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
  await releaseFinished(dir);
  await sweepStaging(dir);
  if (size && size > 0) await assertStagingRoom(size);
  const stagedName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const fileHandle = await dir.getFileHandle(stagedName, { create: true });
  const worker = createOpfsWorker();

  // One in-flight request at a time: every message gets exactly one reply.
  const request = <T = unknown>(msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; message?: string };
        if (data.type === 'error') reject(new Error(data.message ?? 'OPFS worker error'));
        else resolve(data as T);
      };
      worker.onerror = (event: ErrorEvent) => reject(new Error(event.message || 'OPFS worker failed'));
      worker.postMessage(msg, transfer);
    });

  try {
    await request({ type: 'open', fileHandle });
  } catch (err) {
    worker.terminate();
    await dir.removeEntry(stagedName).catch(() => undefined);
    throw err;
  }

  let bytesWritten = 0;
  let closed = false;
  let pending: Promise<unknown> = Promise.resolve();

  const writer: StreamDownloadWriter = {
    async write(chunk: Uint8Array): Promise<void> {
      if (closed) throw new Error('Cannot write to closed stream');
      const copy = chunk.slice(); // the caller may reuse its buffer; transfer our copy
      pending = pending.then(() => request({ type: 'write', chunk: copy }, [copy.buffer]));
      await pending;
      bytesWritten += chunk.byteLength;
      onProgress?.(bytesWritten);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pending;
      await request({ type: 'close' });
      worker.terminate();
      const file = await fileHandle.getFile();
      saveFile(file, filename);
      // Released when the next part starts (or by the TTL sweep): the
      // browser may still be copying this file right now.
      finishedStaged.add(stagedName);
    },

    async abort(): Promise<void> {
      if (closed) return;
      closed = true;
      await pending.catch(() => undefined);
      await request({ type: 'abort' }).catch(() => undefined);
      worker.terminate();
      await dir.removeEntry(stagedName).catch(() => undefined);
    },

    get bytesWritten(): number {
      return bytesWritten;
    },
  };
  return writer;
}
