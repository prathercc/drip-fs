/// <reference lib="webworker" />

import type { BackgroundSetupOptions, DownloadMetadata } from './types';

declare const self: ServiceWorkerGlobalScope;

/**
 * Sets up streaming download support in a service worker.
 *
 * For **web apps** (non-extension), call this in your service worker to handle
 * download message/fetch events directly without needing the bridge files.
 *
 * For **browser extensions**, this is NOT required — the bridge files
 * (bridge.html, bridge.js, sw.js) handle everything via a dedicated SW.
 * Just copy the bridge files to your extension and add them to
 * web_accessible_resources.
 *
 * @param options - Optional configuration
 *
 * @example
 * ```typescript
 * // service-worker.js (web app only)
 * import { setupStreamingDownloads } from 'drip-fs/background';
 *
 * setupStreamingDownloads({ debug: true });
 * ```
 */
export function setupStreamingDownloads(options: BackgroundSetupOptions = {}): void {
  const { debug = false } = options;

  const log = (...args: unknown[]) => {
    if (debug) {
      console.log('[drip-fs]', ...args);
    }
  };

  // Map to track active downloads
  const downloadMap = new Map<string, DownloadMetadata>();

  // Service worker lifecycle - claim clients immediately
  self.addEventListener('install', () => {
    log('Service worker installing');
    self.skipWaiting();
  });

  self.addEventListener('activate', (event: ExtendableEvent) => {
    log('Service worker activating');
    event.waitUntil(self.clients.claim());
  });

  // Store original message handler
  const originalOnMessage = self.onmessage;

  // Handle messages from bridge
  self.onmessage = (event: ExtendableMessageEvent) => {
    // Check if this is a drip-fs message (has ports)
    if (!event.ports || event.ports.length === 0) {
      // Not our message - call original handler
      if (originalOnMessage) {
        originalOnMessage.call(self, event);
      }
      return;
    }

    // Ignore ping messages
    if (event.data === 'ping') {
      return;
    }

    const data = event.data;
    const port = event.ports[0];

    // Generate download URL
    const baseScope = self.registration?.scope ?? `${self.location.origin}/`;
    const downloadUrl =
      data.url ||
      `${baseScope}${Math.random().toString().slice(2)}/${
        typeof data === 'string' ? data : data.filename
      }`;

    log('Registering download:', downloadUrl);

    // Create metadata entry
    const metadata: DownloadMetadata = {
      stream: null,
      data,
      port,
    };

    // Handle different stream transfer methods
    if (event.data.readableStream) {
      metadata.stream = event.data.readableStream;
    } else if (event.data.transferringReadable) {
      port.onmessage = (evt: MessageEvent) => {
        port.onmessage = null;
        metadata.stream = evt.data.readableStream;
      };
    } else {
      metadata.stream = new ReadableStream({
        start(controller) {
          port.onmessage = ({ data: messageData }) => {
            if (messageData === 'end') {
              log('Stream ended');
              return controller.close();
            }

            if (messageData === 'abort') {
              log('Stream aborted');
              controller.error('Download aborted');
              return;
            }

            controller.enqueue(messageData);
          };
        },
        cancel(reason) {
          log('Stream cancelled:', reason);
          port.postMessage({ abort: true });
        },
      });
    }

    downloadMap.set(downloadUrl, metadata);
    port.postMessage({ download: downloadUrl });
  };

  // Handle fetch requests for downloads.
  // Uses onfetch property assignment (not addEventListener) for Firefox
  // event page compatibility — Firefox treats background scripts with
  // onfetch as having service worker fetch interception capability.
  (self as unknown as { onfetch: ((event: FetchEvent) => void) | null }).onfetch = (event: FetchEvent) => {
    const url = event.request.url;

    if (url.endsWith('/ping')) {
      event.respondWith(new Response('pong'));
      return;
    }

    const metadata = downloadMap.get(url);
    if (!metadata) {
      return;
    }

    log('Serving download:', url);
    downloadMap.delete(url);

    const { stream, data, port } = metadata;

    const headers = new Headers({
      'Content-Type': 'application/octet-stream; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Security-Policy': "default-src 'none'",
      'X-WebKit-CSP': "default-src 'none'",
      'X-XSS-Protection': '1; mode=block',
    });

    const dataHeaders = new Headers((data as { headers?: HeadersInit }).headers || {});
    if (dataHeaders.has('Content-Length')) {
      headers.set('Content-Length', dataHeaders.get('Content-Length')!);
    }
    if (dataHeaders.has('Content-Disposition')) {
      headers.set('Content-Disposition', dataHeaders.get('Content-Disposition')!);
    }

    event.respondWith(new Response(stream, { headers }));
    port.postMessage({ debug: 'Download started' });
  };

  log('Streaming downloads initialized');
}
