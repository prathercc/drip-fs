import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupStreamingDownloads } from './background';

describe('setupStreamingDownloads', () => {
  let installListeners: Array<() => void> = [];
  let activateListeners: Array<(event: ExtendableEvent) => void> = [];

  let mockSelf: any;

  beforeEach(() => {
    installListeners = [];
    activateListeners = [];

    mockSelf = {
      addEventListener: vi.fn((event: string, handler: any) => {
        if (event === 'install') {
          installListeners.push(handler);
        } else if (event === 'activate') {
          activateListeners.push(handler);
        }
      }),
      skipWaiting: vi.fn(),
      clients: {
        claim: vi.fn().mockResolvedValue(undefined),
      },
      registration: {
        scope: 'https://example.com/',
      },
      location: {
        origin: 'https://example.com',
      },
      onmessage: null,
      onfetch: null,
    };

    (globalThis as any).self = mockSelf;

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initialization', () => {
    it('should set up service worker lifecycle handlers', () => {
      setupStreamingDownloads();

      expect(mockSelf.addEventListener).toHaveBeenCalledWith('install', expect.any(Function));
      expect(mockSelf.addEventListener).toHaveBeenCalledWith('activate', expect.any(Function));
    });

    it('should set up message handler', () => {
      setupStreamingDownloads();

      expect(mockSelf.onmessage).toBeInstanceOf(Function);
    });

    it('should set up fetch handler', () => {
      setupStreamingDownloads();

      expect(mockSelf.onfetch).toBeInstanceOf(Function);
    });

    it('should log when debug is enabled', () => {
      setupStreamingDownloads({ debug: true });

      expect(console.log).toHaveBeenCalledWith('[drip-fs]', 'Streaming downloads initialized');
    });

    it('should not log when debug is disabled', () => {
      setupStreamingDownloads({ debug: false });

      expect(console.log).not.toHaveBeenCalled();
    });
  });

  describe('Service Worker Lifecycle', () => {
    it('should call skipWaiting on install', () => {
      setupStreamingDownloads();

      installListeners.forEach((listener) => listener());

      expect(mockSelf.skipWaiting).toHaveBeenCalled();
    });

    it('should claim clients on activate', async () => {
      setupStreamingDownloads();

      const mockEvent = {
        waitUntil: vi.fn((promise: Promise<any>) => promise),
      };

      for (const listener of activateListeners) {
        await listener(mockEvent as unknown as ExtendableEvent);
      }

      expect(mockEvent.waitUntil).toHaveBeenCalled();
      expect(mockSelf.clients.claim).toHaveBeenCalled();
    });
  });

  describe('Message Handling', () => {
    it('should ignore messages without ports', () => {
      setupStreamingDownloads();

      const event = new MessageEvent('message', {
        data: { test: 'data' },
        ports: [],
      });

      mockSelf.onmessage(event);
    });

    it('should ignore ping messages', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: 'ping',
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      expect(mockPort.postMessage).not.toHaveBeenCalled();
    });

    it('should register download with provided URL', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        download: 'https://example.com/download/test.zip',
      });
    });

    it('should generate download URL if not provided', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          filename: 'test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        download: expect.stringContaining('https://example.com/'),
      });
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        download: expect.stringContaining('/test.zip'),
      });
    });

    it('should handle direct ReadableStream transfer', () => {
      setupStreamingDownloads();

      const mockStream = new ReadableStream();
      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          filename: 'test.zip',
          readableStream: mockStream,
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        download: expect.any(String),
      });
    });

    it('should handle transferringReadable stream', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          filename: 'test.zip',
          transferringReadable: true,
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      // The port.onmessage should be set for receiving the readable stream
      expect(mockPort.onmessage).toBeInstanceOf(Function);

      // Simulate receiving the readable stream
      const mockStream = new ReadableStream();
      mockPort.onmessage!(new MessageEvent('message', {
        data: { readableStream: mockStream },
      }));

      // After receiving, handler should be cleared
      expect(mockPort.onmessage).toBeNull();
    });

    it('should create ReadableStream for chunk-based transfer', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: { filename: 'test.zip' },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      // Download URL should be generated
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        download: expect.stringContaining('test.zip'),
      });
    });

    it('should enqueue data chunks via port messages', async () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      // Port onmessage is set in the ReadableStream start callback
      expect(mockPort.onmessage).toBeInstanceOf(Function);

      // Simulate sending chunks, then end
      const chunks: Uint8Array[] = [];
      const chunk = new Uint8Array([1, 2, 3]);

      // Send chunk
      mockPort.onmessage!(new MessageEvent('message', { data: chunk }));

      // Send end signal
      mockPort.onmessage!(new MessageEvent('message', { data: 'end' }));

      // Fetch the download to verify stream was set up
      const mockFetchEvent = {
        request: { url: 'https://example.com/download/test.zip' },
        respondWith: vi.fn(),
      };
      mockSelf.onfetch(mockFetchEvent);

      expect(mockFetchEvent.respondWith).toHaveBeenCalledWith(expect.any(Response));

      // Read the stream to verify chunks were enqueued
      const response = mockFetchEvent.respondWith.mock.calls[0][0] as Response;
      const reader = response.body!.getReader();
      const result = await reader.read();
      expect(result.value).toEqual(chunk);
    });

    it('should handle abort signal via port messages', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/abort-test.zip',
          filename: 'abort-test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      // Simulate sending abort signal — should not throw
      expect(() => {
        mockPort.onmessage!(new MessageEvent('message', { data: 'abort' }));
      }).not.toThrow();
    });

    it('should preserve original onmessage handler', () => {
      const originalHandler = vi.fn();
      mockSelf.onmessage = originalHandler;

      setupStreamingDownloads();

      const event = new MessageEvent('message', {
        data: { other: 'data' },
        ports: [],
      });

      mockSelf.onmessage(event);

      expect(originalHandler).toHaveBeenCalledWith(event);
    });
  });

  describe('Fetch Handling', () => {
    let mockFetchEvent: any;

    beforeEach(() => {
      mockFetchEvent = {
        request: { url: '' },
        respondWith: vi.fn(),
      };
    });

    it('should respond to ping requests', () => {
      setupStreamingDownloads();

      mockFetchEvent.request.url = 'https://example.com/ping';
      mockSelf.onfetch(mockFetchEvent);

      expect(mockFetchEvent.respondWith).toHaveBeenCalledWith(expect.any(Response));
    });

    it('should ignore non-download requests', () => {
      setupStreamingDownloads();

      mockFetchEvent.request.url = 'https://example.com/other';
      mockSelf.onfetch(mockFetchEvent);

      expect(mockFetchEvent.respondWith).not.toHaveBeenCalled();
    });

    it('should serve registered downloads', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const messageEvent = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
          headers: { 'Content-Length': '1024' },
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(messageEvent);

      mockFetchEvent.request.url = 'https://example.com/download/test.zip';
      mockSelf.onfetch(mockFetchEvent);

      expect(mockFetchEvent.respondWith).toHaveBeenCalledWith(expect.any(Response));

      const response = mockFetchEvent.respondWith.mock.calls[0][0];
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream; charset=utf-8');
      expect(response.headers.get('Content-Length')).toBe('1024');
    });

    it('should remove download from map after serving', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const messageEvent = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(messageEvent);

      mockFetchEvent.request.url = 'https://example.com/download/test.zip';
      mockSelf.onfetch(mockFetchEvent);
      expect(mockFetchEvent.respondWith).toHaveBeenCalledTimes(1);

      mockFetchEvent.respondWith.mockClear();
      mockSelf.onfetch(mockFetchEvent);
      expect(mockFetchEvent.respondWith).not.toHaveBeenCalled();
    });

    it('should include Content-Disposition header when provided', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const messageEvent = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
          headers: {
            'Content-Length': '2048',
            'Content-Disposition': 'attachment; filename="test.zip"',
          },
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(messageEvent);

      mockFetchEvent.request.url = 'https://example.com/download/test.zip';
      mockSelf.onfetch(mockFetchEvent);

      const response = mockFetchEvent.respondWith.mock.calls[0][0];
      expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="test.zip"');
      expect(response.headers.get('Content-Length')).toBe('2048');
    });

    it('should handle stream cancellation', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn(),
      };

      const event = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/cancel-test.zip',
          filename: 'cancel-test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(event);

      // Fetch the download to get the stream
      mockFetchEvent.request.url = 'https://example.com/download/cancel-test.zip';
      mockSelf.onfetch(mockFetchEvent);

      const response = mockFetchEvent.respondWith.mock.calls[0][0] as Response;

      // Cancel the stream
      response.body!.cancel('User cancelled');

      // Port should be notified of abort
      expect(mockPort.postMessage).toHaveBeenCalledWith({ abort: true });
    });

    it('should notify port when download starts', () => {
      setupStreamingDownloads();

      const mockPort = {
        onmessage: null,
        postMessage: vi.fn(),
      };

      const messageEvent = new MessageEvent('message', {
        data: {
          url: 'https://example.com/download/test.zip',
          filename: 'test.zip',
        },
        ports: [mockPort as any],
      });

      mockSelf.onmessage(messageEvent);

      mockFetchEvent.request.url = 'https://example.com/download/test.zip';
      mockSelf.onfetch(mockFetchEvent);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        debug: 'Download started',
      });
    });
  });
});
