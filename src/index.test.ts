import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStreamingDownload } from './index';

/** Flush microtask queue */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createStreamingDownload', () => {
  let mockPort1: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  let mockPort2: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  let mockContentWindow: { postMessage: ReturnType<typeof vi.fn> };
  let bridgeIframe: HTMLIFrameElement | null = null;
  let downloadIframe: HTMLIFrameElement | null = null;
  let iframeCount: number;

  beforeEach(() => {
    mockPort1 = {
      onmessage: null,
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    mockPort2 = {
      onmessage: null,
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    (globalThis as any).MessageChannel = class {
      port1 = mockPort1;
      port2 = mockPort2;
    };

    mockContentWindow = { postMessage: vi.fn() };
    iframeCount = 0;

    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if ((node as HTMLElement).tagName === 'IFRAME') {
        iframeCount++;
        if (iframeCount === 1) {
          // First iframe is the bridge (extension) or download (web)
          bridgeIframe = node as HTMLIFrameElement;
          Object.defineProperty(bridgeIframe, 'contentWindow', {
            value: mockContentWindow,
            configurable: true,
          });
        } else {
          // Second iframe is the download trigger (extension only)
          downloadIframe = node as HTMLIFrameElement;
        }
      }
      return node;
    });

    vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridgeIframe = null;
    downloadIframe = null;
    (globalThis as any).chrome = undefined;
  });

  /** Trigger bridge iframe onload (extension context only) */
  const simulateIframeLoad = () => {
    if (bridgeIframe?.onload) {
      (bridgeIframe.onload as (ev: Event) => void).call(bridgeIframe, new Event('load'));
    }
  };

  /** Simulate service worker sending download URL via port1 */
  const simulateDownloadUrl = (url: string) => {
    if (mockPort1.onmessage) {
      mockPort1.onmessage(new MessageEvent('message', { data: { download: url } }));
    }
  };

  /**
   * Complete the full init flow for extension context:
   * 1. Trigger bridge iframe load
   * 2. Wait a tick for the async code to set port1.onmessage
   * 3. Simulate the download URL response
   */
  const completeExtensionInit = async (url = 'chrome-extension://test-ext/12345/test.bin') => {
    simulateIframeLoad();
    await tick();
    simulateDownloadUrl(url);
  };

  /**
   * Complete the full init flow for web context:
   * 1. Wait a tick for postMessage to complete and port1.onmessage to be set
   * 2. Simulate the download URL response
   */
  const completeWebInit = async (url = 'http://localhost/12345/test.bin') => {
    await tick();
    simulateDownloadUrl(url);
  };

  describe('Extension Context', () => {
    beforeEach(() => {
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
        },
      };

      // No SW controller — forces bridge iframe path (path 2)
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: null, ready: Promise.resolve() },
        writable: true,
        configurable: true,
      });
    });

    it('should create a writer in extension context', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();

      const writer = await promise;

      expect(writer).toBeDefined();
      expect(writer.write).toBeInstanceOf(Function);
      expect(writer.close).toBeInstanceOf(Function);
      expect(writer.abort).toBeInstanceOf(Function);
      expect(writer.bytesWritten).toBe(0);
    });

    it('should use chrome.runtime.getURL for bridge path', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      await promise;

      expect(bridgeIframe!.src).toContain('chrome-extension://test-extension-id/bridge/bridge.html');
    });

    it('should trigger download via iframe with download URL', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit('chrome-extension://test-ext/bridge/12345/test.bin');
      await promise;

      expect(downloadIframe).not.toBeNull();
      expect(downloadIframe!.src).toBe('chrome-extension://test-ext/bridge/12345/test.bin');
      expect(downloadIframe!.hidden).toBe(true);
    });

    it('should send initialization message to bridge iframe', async () => {
      const promise = createStreamingDownload('test.bin', { size: 2048 });
      await completeExtensionInit();
      await promise;

      expect(mockContentWindow.postMessage).toHaveBeenCalledWith(
        { filename: 'test.bin', size: 2048 },
        '*',
        [mockPort2]
      );
    });

    it('should write chunks and track bytes', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.write(new Uint8Array([1, 2, 3]));
      expect(writer.bytesWritten).toBe(3);

      await writer.write(new Uint8Array([4, 5, 6, 7]));
      expect(writer.bytesWritten).toBe(7);
    });

    it('should call onProgress callback', async () => {
      const onProgress = vi.fn();
      const promise = createStreamingDownload('test.bin', { onProgress });
      await completeExtensionInit();
      const writer = await promise;

      await writer.write(new Uint8Array([1, 2, 3]));
      expect(onProgress).toHaveBeenCalledWith(3);

      await writer.write(new Uint8Array([4, 5]));
      expect(onProgress).toHaveBeenCalledWith(5);
    });

    it('should close and clean up bridge iframe', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.close();

      expect(mockPort1.postMessage).toHaveBeenCalledWith('end');
      expect(mockPort1.close).toHaveBeenCalled();
      expect(document.body.removeChild).toHaveBeenCalledWith(bridgeIframe);
    });

    it('should abort and clean up both iframes', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.abort();

      expect(mockPort1.postMessage).toHaveBeenCalledWith('abort');
      expect(mockPort1.close).toHaveBeenCalled();
      expect(document.body.removeChild).toHaveBeenCalledWith(bridgeIframe);
    });

    it('should not write after close', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.close();

      await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
        'Cannot write to closed stream'
      );
    });

    it('should handle close called multiple times', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.close();
      await writer.close(); // should not throw

      expect(document.body.removeChild).toHaveBeenCalledTimes(1);
    });

    it('should abort and clean up download iframe', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      // Simulate download iframe having a parentNode
      Object.defineProperty(downloadIframe!, 'parentNode', {
        value: document.body,
        configurable: true,
      });

      await writer.abort();

      expect(mockPort1.postMessage).toHaveBeenCalledWith('abort');
      // Should remove both bridge and download iframes
      expect(document.body.removeChild).toHaveBeenCalledWith(bridgeIframe);
      expect(document.body.removeChild).toHaveBeenCalledWith(downloadIframe);
    });

    it('should not abort if already closed', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.close();
      mockPort1.postMessage.mockClear();

      await writer.abort(); // should be a no-op

      expect(mockPort1.postMessage).not.toHaveBeenCalledWith('abort');
    });

    it('should not write after abort', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      const writer = await promise;

      await writer.abort();

      await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
        'Cannot write to closed stream'
      );
    });
  });

  describe('Web Context', () => {
    let mockController: { postMessage: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      (globalThis as any).chrome = undefined;

      mockController = { postMessage: vi.fn() };
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: {
          controller: mockController,
          ready: Promise.resolve(),
        },
        writable: true,
        configurable: true,
      });
    });

    it('should create a writer in web context', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();

      const writer = await promise;
      expect(writer).toBeDefined();
    });

    it('should post directly to service worker controller', async () => {
      const promise = createStreamingDownload('test.bin', { size: 1024 });
      await completeWebInit();
      await promise;

      expect(mockController.postMessage).toHaveBeenCalledWith(
        { filename: 'test.bin', size: 1024 },
        [mockPort2]
      );
    });

    it('should not create a bridge iframe in web context', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      await promise;

      // Only one iframe should be created (the download iframe)
      expect(iframeCount).toBe(1);
    });

    it('should trigger download via iframe with download URL', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit('http://localhost/12345/test.bin');
      await promise;

      // In web context, bridgeIframe variable holds the download iframe (first iframe)
      expect(bridgeIframe).not.toBeNull();
      expect(bridgeIframe!.src).toContain('http://localhost/12345/test.bin');
      expect(bridgeIframe!.hidden).toBe(true);
    });

    it('should write chunks and track bytes', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      const writer = await promise;

      await writer.write(new Uint8Array([1, 2, 3]));
      expect(writer.bytesWritten).toBe(3);
    });

    it('should close without removing bridge iframe', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      const writer = await promise;

      await writer.close();

      expect(mockPort1.postMessage).toHaveBeenCalledWith('end');
      expect(mockPort1.close).toHaveBeenCalled();
      // No bridge iframe to remove in web context
      expect(document.body.removeChild).not.toHaveBeenCalled();
    });

    it('should abort and clean up download iframe in web context', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      const writer = await promise;

      // In web context, the first iframe IS the download iframe (stored as bridgeIframe in test)
      Object.defineProperty(bridgeIframe!, 'parentNode', {
        value: document.body,
        configurable: true,
      });

      await writer.abort();

      expect(mockPort1.postMessage).toHaveBeenCalledWith('abort');
      expect(mockPort1.close).toHaveBeenCalled();
      // Should remove download iframe
      expect(document.body.removeChild).toHaveBeenCalledWith(bridgeIframe);
    });

    it('should handle close called multiple times in web context', async () => {
      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      const writer = await promise;

      await writer.close();
      await writer.close(); // should not throw

      expect(mockPort1.postMessage).toHaveBeenCalledWith('end');
      // postMessage('end') should only be called once
      expect(mockPort1.postMessage.mock.calls.filter((c: any[]) => c[0] === 'end')).toHaveLength(1);
    });

    it('should call onProgress in web context', async () => {
      const onProgress = vi.fn();
      const promise = createStreamingDownload('test.bin', { onProgress });
      await completeWebInit();
      const writer = await promise;

      await writer.write(new Uint8Array([1, 2, 3, 4, 5]));
      expect(onProgress).toHaveBeenCalledWith(5);
    });

    it('should use blob fallback when service worker not available', async () => {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const writer = await createStreamingDownload('test.bin');

      expect(writer).toBeDefined();
      expect(writer.write).toBeInstanceOf(Function);
      expect(writer.close).toBeInstanceOf(Function);
      expect(writer.abort).toBeInstanceOf(Function);
    });

    it('should use blob fallback when service worker controller missing', async () => {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: null, ready: Promise.resolve() },
        writable: true,
        configurable: true,
      });

      const writer = await createStreamingDownload('test.bin');

      expect(writer).toBeDefined();
      // No iframes should be created (no bridge, no download)
      expect(iframeCount).toBe(0);
    });
  });

  describe('Blob Fallback Context', () => {
    beforeEach(() => {
      // Firefox extension: chrome API available but no navigator.serviceWorker
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: (path: string) => `moz-extension://test-extension-id/${path}`,
        },
      };

      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    });

    it('should create a writer immediately without SW wait', async () => {
      const writer = await createStreamingDownload('test.bin');

      expect(writer).toBeDefined();
      expect(writer.write).toBeInstanceOf(Function);
      expect(writer.close).toBeInstanceOf(Function);
      expect(writer.abort).toBeInstanceOf(Function);
      expect(writer.bytesWritten).toBe(0);
    });

    it('should not create any iframes', async () => {
      await createStreamingDownload('test.bin');

      expect(iframeCount).toBe(0);
    });

    it('should accumulate chunks and track bytesWritten', async () => {
      const writer = await createStreamingDownload('test.bin');

      await writer.write(new Uint8Array([1, 2, 3]));
      expect(writer.bytesWritten).toBe(3);

      await writer.write(new Uint8Array([4, 5, 6, 7]));
      expect(writer.bytesWritten).toBe(7);
    });

    it('should call onProgress on each write', async () => {
      const onProgress = vi.fn();
      const writer = await createStreamingDownload('test.bin', { onProgress });

      await writer.write(new Uint8Array([1, 2, 3]));
      expect(onProgress).toHaveBeenCalledWith(3);

      await writer.write(new Uint8Array([4, 5]));
      expect(onProgress).toHaveBeenCalledWith(5);
    });

    it('should create blob and trigger download on close', async () => {
      const mockObjectUrl = 'blob:test-url';
      const mockCreateObjectURL = vi.fn().mockReturnValue(mockObjectUrl);
      const mockRevokeObjectURL = vi.fn();
      globalThis.URL.createObjectURL = mockCreateObjectURL;
      globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

      const mockClick = vi.fn();
      const mockAnchor = {
        href: '',
        download: '',
        style: { display: '' },
        click: mockClick,
      };
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'a') return mockAnchor as unknown as HTMLAnchorElement;
        return document.createElement(tag);
      });

      const writer = await createStreamingDownload('export.zip');
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5, 6]));
      await writer.close();

      expect(mockCreateObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(mockAnchor.href).toBe(mockObjectUrl);
      expect(mockAnchor.download).toBe('export.zip');
      expect(mockAnchor.style.display).toBe('none');
      expect(mockClick).toHaveBeenCalled();
      expect(document.body.appendChild).toHaveBeenCalledWith(mockAnchor);
    });

    it('should not write after close', async () => {
      const writer = await createStreamingDownload('test.bin');
      await writer.close();

      await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
        'Cannot write to closed stream'
      );
    });

    it('should not write after abort', async () => {
      const writer = await createStreamingDownload('test.bin');
      await writer.abort();

      await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
        'Cannot write to closed stream'
      );
    });

    it('should handle close called multiple times', async () => {
      const mockCreateObjectURL = vi.fn().mockReturnValue('blob:url');
      globalThis.URL.createObjectURL = mockCreateObjectURL;
      globalThis.URL.revokeObjectURL = vi.fn();
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        if (tag === 'a') return { href: '', download: '', style: { display: '' }, click: vi.fn() } as any;
        return document.createElement(tag);
      });

      const writer = await createStreamingDownload('test.bin');
      await writer.close();
      await writer.close(); // should not throw or create another blob

      expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    });

    it('should clear chunks on abort without triggering download', async () => {
      const mockCreateObjectURL = vi.fn();
      globalThis.URL.createObjectURL = mockCreateObjectURL;

      const writer = await createStreamingDownload('test.bin');
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.abort();

      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });
  });

  describe('Download Path Selection', () => {
    it('Chrome web app: uses direct SW path', async () => {
      (globalThis as any).chrome = undefined;

      const mockController = { postMessage: vi.fn() };
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: mockController, ready: Promise.resolve() },
        writable: true,
        configurable: true,
      });

      const promise = createStreamingDownload('test.bin');
      await completeWebInit();
      await promise;

      // Direct path: posts to controller, no bridge iframe
      expect(mockController.postMessage).toHaveBeenCalled();
      expect(iframeCount).toBe(1); // Only download iframe, no bridge
    });

    it('Chrome extension: uses bridge iframe path', async () => {
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
        },
      };

      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: null, ready: Promise.resolve() },
        writable: true,
        configurable: true,
      });

      const promise = createStreamingDownload('test.bin');
      await completeExtensionInit();
      await promise;

      // Bridge path: creates bridge iframe + download iframe
      expect(iframeCount).toBe(2);
      expect(bridgeIframe!.src).toContain('bridge/bridge.html');
    });

    it('Firefox extension: uses blob fallback (no SW)', async () => {
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: (path: string) => `moz-extension://test-extension-id/${path}`,
        },
      };

      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const writer = await createStreamingDownload('test.bin');

      // Blob path: no iframes created, writer returned immediately
      expect(iframeCount).toBe(0);
      expect(writer.bytesWritten).toBe(0);
    });

    it('No SW, no extension: uses blob fallback', async () => {
      (globalThis as any).chrome = undefined;

      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const writer = await createStreamingDownload('test.bin');

      expect(iframeCount).toBe(0);
      expect(writer.bytesWritten).toBe(0);
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      (globalThis as any).chrome = {
        runtime: {
          id: 'test-extension-id',
          getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
        },
      };

      // No SW controller — forces bridge iframe path (path 2)
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: null, ready: Promise.resolve() },
        writable: true,
        configurable: true,
      });
    });

    it('should timeout if iframe fails to load', async () => {
      vi.useFakeTimers();

      const promise = createStreamingDownload('test.bin');

      vi.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow('bridge handler load timeout');

      vi.useRealTimers();
    });

    it('should timeout if download URL not received', async () => {
      vi.useFakeTimers();

      const promise = createStreamingDownload('test.bin');

      // Trigger iframe load
      simulateIframeLoad();
      // Flush microtasks so the code proceeds to the download URL wait
      await vi.advanceTimersByTimeAsync(0);

      // Now advance past the download URL timeout
      vi.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow(
        'Failed to get download URL from service worker'
      );

      vi.useRealTimers();
    });

    it('should handle iframe error event', async () => {
      const promise = createStreamingDownload('test.bin');

      if (bridgeIframe?.onerror) {
        (bridgeIframe.onerror as OnErrorEventHandler).call(
          bridgeIframe,
          new Event('error')
        );
      }

      await expect(promise).rejects.toThrow('Failed to load bridge handler');
    });

    it('should handle error message from port', async () => {
      const promise = createStreamingDownload('test.bin');

      simulateIframeLoad();
      await tick();

      // Simulate error via port1's onmessage
      if (mockPort1.onmessage) {
        mockPort1.onmessage(
          new MessageEvent('message', { data: { error: 'Test error' } })
        );
      }

      await expect(promise).rejects.toThrow('Test error');
    });
  });
});
