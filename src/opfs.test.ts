import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _resetStagingState,
  createOpfsDownload,
  sweepStagedDownloads,
  assertStagingRoom,
  STARTUP_SWEEP_TTL_MS,
  isIOSWebKit,
  isOpfsAvailable,
  sweepStaging,
  STAGING_DIR,
  STAGING_TTL_MS,
  OPFS_WORKER_SOURCE,
} from './opfs';
import { createStreamingDownload } from './index';

const nav = (o: Partial<Navigator>) => ({ userAgent: '', platform: '', maxTouchPoints: 0, ...o }) as Navigator;

/** In-memory stand-in for the worker: replies to the protocol like the real script. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failOn: string | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  bytes = 0;
  terminated = false;
  messages: unknown[] = [];
  constructor(public url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: { type: string; chunk?: Uint8Array }) {
    this.messages.push(msg);
    queueMicrotask(() => {
      if (FakeWorker.failOn === msg.type) {
        this.onmessage?.({ data: { type: 'error', message: `boom on ${msg.type}` } } as MessageEvent);
        return;
      }
      if (msg.type === 'write') this.bytes += msg.chunk!.byteLength;
      const reply =
        msg.type === 'open' ? { type: 'opened' }
        : msg.type === 'write' ? { type: 'written', bytes: this.bytes }
        : msg.type === 'close' ? { type: 'closed', bytes: this.bytes }
        : { type: 'aborted' };
      this.onmessage?.({ data: reply } as MessageEvent);
    });
  }
  terminate() {
    this.terminated = true;
  }
}

type Entry = { kind: 'file'; name: string };
const makeOpfs = () => {
  const files = new Map<string, Entry>();
  const removeEntry = vi.fn(async (name: string) => {
    files.delete(name);
  });
  const dir = {
    getFileHandle: vi.fn(async (name: string) => {
      files.set(name, { kind: 'file', name });
      return {
        kind: 'file',
        name,
        getFile: async () => new File(['zip-bytes'], name),
      };
    }),
    removeEntry,
    entries: async function* () {
      for (const [name, e] of files) yield [name, e] as [string, FileSystemHandle];
    },
  };
  const root = { getDirectoryHandle: vi.fn(async () => dir) };
  return { files, dir, root, removeEntry };
};

describe('detection', () => {
  it('isIOSWebKit matches iPhone, iPad, CriOS, and iPadOS-as-Mac', () => {
    expect(isIOSWebKit(nav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/126' }))).toBe(true);
    expect(isIOSWebKit(nav({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }))).toBe(true);
    expect(isIOSWebKit(nav({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }))).toBe(true);
    expect(isIOSWebKit(nav({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }))).toBe(false);
    expect(isIOSWebKit(nav({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126', platform: 'Linux armv8l' }))).toBe(false);
  });

  it('isOpfsAvailable needs getDirectory, Worker, and FileSystemFileHandle (sync handles are worker-only, not probed)', () => {
    const saved = { storage: (navigator as any).storage, FSFH: (globalThis as any).FileSystemFileHandle, Worker: (globalThis as any).Worker };
    Object.defineProperty(navigator, 'storage', { value: { getDirectory: vi.fn() }, configurable: true });
    (globalThis as any).Worker = class {};
    (globalThis as any).FileSystemFileHandle = class {};
    expect(isOpfsAvailable()).toBe(true);
    (globalThis as any).FileSystemFileHandle = undefined;
    expect(isOpfsAvailable()).toBe(false);
    (globalThis as any).FileSystemFileHandle = class {};
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    expect(isOpfsAvailable()).toBe(false);
    Object.defineProperty(navigator, 'storage', { value: saved.storage, configurable: true });
    (globalThis as any).FileSystemFileHandle = saved.FSFH;
    (globalThis as any).Worker = saved.Worker;
  });

  it('ships a worker script that speaks the open/write/close/abort protocol', () => {
    for (const word of ['createSyncAccessHandle', "'open'", "'write'", "'close'", "'abort'", 'flush']) {
      expect(OPFS_WORKER_SOURCE).toContain(word);
    }
  });
});

describe('createOpfsDownload', () => {
  let opfs: ReturnType<typeof makeOpfs>;
  let click: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetStagingState();
    FakeWorker.instances = [];
    FakeWorker.failOn = null;
    opfs = makeOpfs();
    (globalThis as any).Worker = FakeWorker;
    Object.defineProperty(navigator, 'storage', { value: { getDirectory: vi.fn(async () => opfs.root) }, configurable: true });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:staged'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stages chunks through the worker, then saves a file-backed URL on close', async () => {
    const progress: number[] = [];
    const w = await createOpfsDownload('export.zip', { onProgress: (b) => progress.push(b) });
    expect(opfs.root.getDirectoryHandle).toHaveBeenCalledWith(STAGING_DIR, { create: true });
    const worker = FakeWorker.instances[0];
    expect(worker.messages[0]).toMatchObject({ type: 'open' });

    await w.write(new Uint8Array([1, 2, 3]));
    await w.write(new Uint8Array([4, 5]));
    expect(progress).toEqual([3, 5]);
    expect(w.bytesWritten).toBe(5);
    expect(worker.messages.filter((m) => (m as { type: string }).type === 'write')).toHaveLength(2);

    await w.close();
    expect(worker.messages.at(-1)).toMatchObject({ type: 'close' });
    expect(worker.terminated).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(File));
    const a = document.querySelector('a[download="export.zip"]') as HTMLAnchorElement;
    expect(a.href).toContain('blob:staged');
    expect(click).toHaveBeenCalledTimes(1);
    // Staged file is NOT removed eagerly: the browser may still be reading it.
    expect(opfs.removeEntry).not.toHaveBeenCalled();
    await expect(w.write(new Uint8Array([9]))).rejects.toThrow(/closed/);
  });

  it('abort closes the handle, terminates the worker, and removes the staged file', async () => {
    const w = await createOpfsDownload('x.zip');
    await w.write(new Uint8Array([1]));
    await w.abort();
    const worker = FakeWorker.instances[0];
    expect(worker.messages.at(-1)).toMatchObject({ type: 'abort' });
    expect(worker.terminated).toBe(true);
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it('cleans up and throws when the worker cannot open a sync access handle', async () => {
    FakeWorker.failOn = 'open';
    await expect(createOpfsDownload('x.zip')).rejects.toThrow(/boom on open/);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1);
  });

  it('releases the previous part\'s staged file when the next part starts, but never its own', async () => {
    const first = await createOpfsDownload('part-1.zip');
    await first.write(new Uint8Array([1]));
    await first.close();
    expect(opfs.removeEntry).not.toHaveBeenCalled();
    const firstName = [...opfs.files.keys()][0];

    const second = await createOpfsDownload('part-2.zip');
    expect(opfs.removeEntry).toHaveBeenCalledWith(firstName);
    expect([...opfs.files.keys()]).toHaveLength(1);
    await second.write(new Uint8Array([2]));
    await second.close();
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1);
  });

  it('refuses up front with a readable error when the part will not fit, and skips when it cannot estimate', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory: vi.fn(async () => opfs.root), estimate: vi.fn(async () => ({ quota: 10 * 1024 ** 3, usage: 9.5 * 1024 ** 3 })) },
      configurable: true,
    });
    await expect(createOpfsDownload('x.zip', { size: 4 * 1024 ** 3 })).rejects.toThrow(/Not enough free storage to stage a 4\.0 GB download part/);
    expect(FakeWorker.instances).toHaveLength(0);
    await expect(createOpfsDownload('x.zip', { size: 100 * 1024 ** 2 })).resolves.toBeTruthy();

    Object.defineProperty(navigator, 'storage', { value: { getDirectory: vi.fn(async () => opfs.root) }, configurable: true });
    await expect(assertStagingRoom(1)).resolves.toBeUndefined();
  });

  it('sweepStagedDownloads at startup clears leftovers older than 5 minutes and no-ops without OPFS', async () => {
    const now = Date.now();
    opfs.files.set(`${now - STARTUP_SWEEP_TTL_MS - 1}-stale`, { kind: 'file', name: 'stale' });
    opfs.files.set(`${now - 1000}-live`, { kind: 'file', name: 'live' });
    await sweepStagedDownloads();
    expect([...opfs.files.keys()]).toEqual([`${now - 1000}-live`]);

    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    await expect(sweepStagedDownloads()).resolves.toBeUndefined();
  });

  it('sweeps staged files older than the TTL and keeps fresh ones', async () => {
    const now = 1_700_000_000_000;
    opfs.files.set(`${now - STAGING_TTL_MS - 1}-old`, { kind: 'file', name: 'old' });
    opfs.files.set(`${now - 1000}-fresh`, { kind: 'file', name: 'fresh' });
    opfs.files.set('not-a-stamp', { kind: 'file', name: 'odd' });
    await sweepStaging(opfs.dir as unknown as FileSystemDirectoryHandle, now);
    expect([...opfs.files.keys()]).toEqual([`${now - 1000}-fresh`, 'not-a-stamp']);
  });
});

describe('createStreamingDownload mode selection', () => {
  const originalUA = navigator.userAgent;
  beforeEach(() => {
    _resetStagingState();
    FakeWorker.instances = [];
    FakeWorker.failOn = null;
    const opfs = makeOpfs();
    (globalThis as any).Worker = FakeWorker;
    (globalThis as any).FileSystemFileHandle = class { createSyncAccessHandle() {} };
    Object.defineProperty(navigator, 'storage', { value: { getDirectory: vi.fn(async () => opfs.root) }, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', { value: { controller: { postMessage: vi.fn() } }, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
  });

  it('auto on iOS WebKit with OPFS takes the staged path even when a SW controller exists', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/126', configurable: true });
    await createStreamingDownload('x.zip');
    expect(FakeWorker.instances).toHaveLength(1);
    expect((navigator.serviceWorker!.controller as any).postMessage).not.toHaveBeenCalled();
  });

  it('auto on iOS falls back to the in-memory Blob (never the iframe) when the worker cannot open a handle', async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', configurable: true });
    FakeWorker.failOn = 'open';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const append = vi.spyOn(document.body, 'appendChild');
    const w = await createStreamingDownload('x.zip');
    expect((navigator.serviceWorker!.controller as any).postMessage).not.toHaveBeenCalled();
    expect(append.mock.calls.some(([n]) => (n as HTMLElement).tagName === 'IFRAME')).toBe(false);
    await w.write(new Uint8Array([1, 2]));
    expect(w.bytesWritten).toBe(2);
    expect(console.warn).toHaveBeenCalled();
  });

  it("mode 'opfs' forces the staged path off iOS", async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux) Chrome/126', configurable: true });
    await createStreamingDownload('x.zip', { mode: 'opfs' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("mode 'blob' skips the SW stream entirely", async () => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux) Chrome/126', configurable: true });
    const w = await createStreamingDownload('x.zip', { mode: 'blob' });
    expect((navigator.serviceWorker!.controller as any).postMessage).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(w.bytesWritten).toBe(0);
  });
});
