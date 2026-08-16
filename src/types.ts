/**
 * Options for creating a streaming download
 */
export interface StreamDownloadOptions {
  /**
   * Expected file size in bytes (optional). Used for progress tracking,
   * and by the OPFS path as the up-front free-storage check for the part.
   */
  size?: number;

  /**
   * Progress callback - called as chunks are written
   */
  onProgress?: (bytesWritten: number) => void;

  /**
   * Download path. 'auto' (default) picks the service-worker stream where
   * it works, the OPFS-staged path on iOS WebKit (which cannot download
   * from iframes), and the in-memory Blob as the last resort. Set 'opfs',
   * 'stream', or 'blob' to force a path.
   */
  mode?: 'auto' | 'stream' | 'opfs' | 'blob';
}

/**
 * Writer interface for streaming downloads
 */
export interface StreamDownloadWriter {
  /**
   * Write a chunk of data to the download stream
   */
  write(chunk: Uint8Array): Promise<void>;

  /**
   * Finalize the download and trigger the browser's save dialog
   */
  close(): Promise<void>;

  /**
   * Abort the download
   */
  abort(): Promise<void>;

  /**
   * Total bytes written so far
   */
  readonly bytesWritten: number;
}

/**
 * Internal metadata for tracking downloads
 * @internal
 */
export interface DownloadMetadata {
  stream: ReadableStream | null;
  data: unknown;
  port: MessagePort;
}

/**
 * Options for background script setup
 */
export interface BackgroundSetupOptions {
  /**
   * Enable debug logging
   */
  debug?: boolean;
}
