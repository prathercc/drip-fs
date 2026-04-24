/**
 * Options for creating a streaming download
 */
export interface StreamDownloadOptions {
  /**
   * Expected file size in bytes (optional, for progress tracking)
   */
  size?: number;

  /**
   * Progress callback - called as chunks are written
   */
  onProgress?: (bytesWritten: number) => void;
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
