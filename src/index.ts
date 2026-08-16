/// <reference types="chrome" />

import type { StreamDownloadOptions, StreamDownloadWriter } from './types';
import { createOpfsDownload, isIOSWebKit, isOpfsAvailable } from './opfs';

/**
 * Detects if running in a browser extension context
 */
function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id !== undefined;
}

/**
 * Creates a streaming download writer
 *
 * Paths, in priority order (mode 'auto'):
 * 0. OPFS-staged file on iOS WebKit (iframe downloads are forbidden there)
 * 1. Direct SW controller (background called setupStreamingDownloads, or web app SW)
 * 2. Bridge iframe + dedicated SW (Chrome extensions without background setup)
 * 3. In-memory Blob fallback
 *
 * @param filename - Name of the file to download
 * @param options - Optional configuration
 * @returns A writer that can stream data to a download
 *
 * @example
 * ```typescript
 * const writer = await createStreamingDownload('data.json');
 * await writer.write(new Uint8Array([1, 2, 3]));
 * await writer.close();
 * ```
 */
/**
 * In-memory Blob fallback. Used by Firefox extensions (no
 * navigator.serviceWorker in extension pages), by mode 'blob', and by iOS
 * WebKit when the OPFS staging path is unavailable. Entire file is held in
 * memory and downloaded on close().
 */
function createBlobDownload(
  filename: string,
  onProgress?: (bytesWritten: number) => void
): StreamDownloadWriter {
  const chunks: Uint8Array[] = [];
  let blobBytesWritten = 0;
  let blobClosed = false;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (blobClosed) {
        throw new Error('Cannot write to closed stream');
      }
      chunks.push(chunk);
      blobBytesWritten += chunk.byteLength;
      if (onProgress) {
        onProgress(blobBytesWritten);
      }
    },

    async close(): Promise<void> {
      if (blobClosed) return;
      blobClosed = true;

      const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }, 1000);
      chunks.length = 0;
    },

    async abort(): Promise<void> {
      if (blobClosed) return;
      blobClosed = true;
      chunks.length = 0;
    },

    get bytesWritten(): number {
      return blobBytesWritten;
    },
  } satisfies StreamDownloadWriter;
}

export async function createStreamingDownload(
  filename: string,
  options: StreamDownloadOptions = {}
): Promise<StreamDownloadWriter> {
  const { size, onProgress, mode = 'auto' } = options;

  if (mode === 'opfs') {
    return createOpfsDownload(filename, options);
  }
  if (mode === 'auto' && isIOSWebKit()) {
    // iOS WebKit must never reach the iframe path (it navigates the tab
    // away). Stage through OPFS; if the worker cannot open a handle
    // (old WebKit, quota), buffer in memory instead.
    if (isOpfsAvailable()) {
      try {
        return await createOpfsDownload(filename, options);
      } catch (err) {
        console.warn('drip-fs: OPFS staging unavailable, buffering in memory instead.', err);
      }
    }
    return createBlobDownload(filename, onProgress);
  }
  const forceBlob = mode === 'blob';
  const allowStream = mode === 'auto' || mode === 'stream';

  // Create message channel for communication
  const channel = new MessageChannel();
  const downloadPort = channel.port1;

  // Bridge iframe used only in extension context
  let bridgeIframe: HTMLIFrameElement | null = null;

  if (allowStream && !forceBlob && navigator.serviceWorker?.controller) {
    // Direct path: a service worker controller is available.
    // Works for web apps (SW registered via setupStreamingDownloads) and
    // browser extensions where the background script calls setupStreamingDownloads().
    navigator.serviceWorker.controller.postMessage(
      { filename, size },
      [channel.port2]
    );
  } else if (allowStream && !forceBlob && isExtensionContext() && typeof navigator.serviceWorker !== 'undefined') {
    // Extension fallback: no background SW controller available, but
    // navigator.serviceWorker exists (Chrome). Load bridge iframe which
    // registers its own dedicated SW.
    const bridgeUrl = chrome.runtime.getURL('bridge/bridge.html');
    bridgeIframe = document.createElement('iframe');
    bridgeIframe.hidden = true;
    bridgeIframe.src = bridgeUrl;
    document.body.appendChild(bridgeIframe);

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      bridgeIframe!.onload = () => resolve();
      bridgeIframe!.onerror = () => reject(new Error('Failed to load bridge handler'));
      setTimeout(() => reject(new Error('bridge handler load timeout')), 5000);
    });

    // Send initialization message to bridge iframe
    bridgeIframe.contentWindow!.postMessage(
      { filename, size },
      '*',
      [channel.port2]
    );
  } else {
    return createBlobDownload(filename, onProgress);
  }

  // Wait for download URL from service worker
  const downloadUrl = await new Promise<string>((resolve, reject) => {
    downloadPort.onmessage = (event) => {
      if (event.data.download) {
        resolve(event.data.download);
      } else if (event.data.error) {
        reject(new Error(event.data.error));
      }
    };

    setTimeout(() => reject(new Error('Failed to get download URL from service worker')), 5000);
  });

  // Trigger download via a hidden iframe navigating to the download URL.
  // The URL is within the SW's scope, so the SW intercepts the
  // request and responds with the stream.
  const downloadIframe = document.createElement('iframe');
  downloadIframe.hidden = true;
  downloadIframe.src = downloadUrl;
  document.body.appendChild(downloadIframe);

  // Track bytes written
  let bytesWritten = 0;
  let closed = false;

  // Create writer interface
  const writer: StreamDownloadWriter = {
    async write(chunk: Uint8Array): Promise<void> {
      if (closed) {
        throw new Error('Cannot write to closed stream');
      }

      downloadPort.postMessage(chunk);
      bytesWritten += chunk.byteLength;

      if (onProgress) {
        onProgress(bytesWritten);
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      downloadPort.postMessage('end');
      downloadPort.close();

      // Clean up bridge iframe if used (extension context)
      if (bridgeIframe) {
        document.body.removeChild(bridgeIframe);
      }
    },

    async abort(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      downloadPort.postMessage('abort');
      downloadPort.close();

      // Clean up iframes
      if (bridgeIframe) {
        document.body.removeChild(bridgeIframe);
      }
      if (downloadIframe.parentNode) {
        document.body.removeChild(downloadIframe);
      }
    },

    get bytesWritten(): number {
      return bytesWritten;
    },
  };

  return writer;
}

/**
 * Re-export types for convenience
 */
export type { StreamDownloadOptions, StreamDownloadWriter } from './types';
export { isIOSWebKit, isOpfsAvailable, sweepStagedDownloads } from './opfs';
