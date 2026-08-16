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

/** iPhone/iPad, including iPadOS reporting a desktop Mac UA with touch. */
export function isIOSWebKit(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent || '';
  return /iP(hone|ad|od)/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
}

/** OPFS with worker sync access handles is what this path needs. */
export function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createSyncAccessHandle' in FileSystemFileHandle.prototype
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
export async function sweepStaging(dir: FileSystemDirectoryHandle, now = Date.now()): Promise<void> {
  try {
    const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, entry] of entries) {
      if (entry.kind !== 'file') continue;
      const stamp = Number(name.split('-')[0]);
      if (Number.isFinite(stamp) && now - stamp > STAGING_TTL_MS) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    /* sweeping is a nicety */
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
  const { onProgress } = options;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
  await sweepStaging(dir);
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
