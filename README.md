# drip-fs

Drip large files to disk a chunk at a time instead of pouring them through RAM. Memory stays flat whether the file is 1 MB or 1 GB.

[![npm version](https://badge.fury.io/js/drip-fs.svg)](https://www.npmjs.com/package/drip-fs)

## Features

- **Flat memory profile** - Chunks drip to disk as you write them. RAM usage doesn't grow with file size.
- **Extension support** - Chrome MV3 (streaming via dedicated service worker) and Firefox MV3 (automatic blob fallback).
- **Simple API** - Promise-based, single `createStreamingDownload()` call returns a writer with `write` / `close` / `abort`.
- **TypeScript** - Full type definitions included.
- **Well tested** - Comprehensive coverage including path-selection regression tests.

## How It Works

Most browser "download large file" libraries accumulate the whole file in memory as a `Blob`, then trigger a single download at the end. That breaks down past a few hundred MB — and on memory-constrained devices, far sooner.

`drip-fs` takes the StreamSaver.js approach instead: chunks travel through a `MessageChannel` to a service worker that serves them as a streaming HTTP response. The browser writes bytes to disk as they arrive — no buffering layer, no `Blob` of the full file in RAM.

**Web apps** communicate directly with the page's service worker (registered by you):

```
App calls createStreamingDownload('file.zip')
  → Posts message to navigator.serviceWorker.controller
    → SW receives chunks via MessagePort
    → SW intercepts download URL via fetch event
    → Browser streams file to disk
```

**Chrome extensions** use a hidden iframe + dedicated service worker (to avoid scope conflicts with the background SW):

```
App calls createStreamingDownload('file.zip')
  → Hidden iframe loads bridge.html
    → bridge.js registers sw.js (dedicated service worker)
      → SW receives chunks via MessagePort
      → SW intercepts download URL via fetch event
      → Browser streams file to disk
```

**Firefox extensions** (and any context without service worker support) use an automatic blob fallback:

```
App calls createStreamingDownload('file.zip')
  → Chunks accumulated in memory via write() calls
  → close() concatenates chunks into a Blob
    → URL.createObjectURL(blob) + <a download> click
    → Browser triggers standard file download
```

> **Note:** Firefox MV3 extensions do not expose `navigator.serviceWorker` in extension pages. The blob fallback is automatic — no code changes needed. The trade-off is that the entire file is held in memory until `close()` is called, so very large exports will use more RAM than the streaming path.

## Installation

```bash
npm install drip-fs
```

## Usage: Web App

In a web app, the library's service worker handles everything. You just need to call `setupStreamingDownloads()` in your service worker and use the API in your app code.

### 1. Set up your service worker

```typescript
// service-worker.js
import { setupStreamingDownloads } from 'drip-fs/background';

// Adds message + fetch handlers for streaming downloads
setupStreamingDownloads();

// Your other service worker code...
```

### 2. Use in your app

```typescript
import { createStreamingDownload } from 'drip-fs';

async function downloadLargeFile() {
  const writer = await createStreamingDownload('large-file.bin');

  const response = await fetch('https://api.example.com/large-data');
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
  }

  await writer.close();
}
```

That's it for web apps — no extra files or configuration needed.

## Usage: Browser Extension

Chrome extensions require a few extra steps because the manifest-declared background service worker cannot intercept navigations from pages outside its scope. The library uses a dedicated service worker registered from within a bridge iframe.

Firefox extensions use the blob fallback automatically — bridge files are not needed but can be included harmlessly.

### 1. Copy bridge files into your extension build

The library ships three static files that must be included in your extension's build output under a `bridge/` subdirectory: `bridge.html`, `bridge.js`, and `sw.js`. These are located in the npm package at `node_modules/drip-fs/src/bridge/`.

The `bridge/` subdirectory is important — it ensures the dedicated service worker registers at a scope (`chrome-extension://id/bridge/`) that doesn't conflict with your extension's background service worker (`chrome-extension://id/`).

Copy them during your build process. For example, in a Node.js build script:

```javascript
import fs from 'fs';
import path from 'path';

const dripFsSrc = path.resolve('node_modules', 'drip-fs', 'src', 'bridge');
const outDir = path.join('dist-extension', 'bridge');

fs.mkdirSync(outDir, { recursive: true });

['bridge.html', 'bridge.js', 'sw.js'].forEach(file => {
  fs.copyFileSync(
    path.join(dripFsSrc, file),
    path.join(outDir, file)
  );
});
```

### 2. Add bridge files to your manifest's `web_accessible_resources`

The bridge iframe loads at a `chrome-extension://` URL, so Chrome needs these files declared as accessible.

**Chrome (Manifest V3):**

```json
{
  "manifest_version": 3,
  "web_accessible_resources": [
    {
      "resources": ["bridge/*", "*/*.zip"],
      "matches": ["*://your-target-site.com/*"]
    }
  ]
}
```

**Firefox (Manifest V3):**

```json
{
  "manifest_version": 3,
  "web_accessible_resources": [
    {
      "resources": ["bridge/*", "*/*.zip"],
      "matches": ["*://your-target-site.com/*"]
    }
  ]
}
```

> Bridge files are included for consistency but Firefox will use the blob fallback since `navigator.serviceWorker` is unavailable in Firefox extension pages.

The `*/*.zip` pattern (or whatever download pattern you use) is needed because the dedicated service worker generates download URLs under the extension's scope.

### 3. Use in your extension's app code

```typescript
import { createStreamingDownload } from 'drip-fs';

async function exportData() {
  const writer = await createStreamingDownload('export.zip');

  const chunk1 = new Uint8Array([/* your data */]);
  await writer.write(chunk1);

  const chunk2 = new Uint8Array([/* more data */]);
  await writer.write(chunk2);

  await writer.close();
}
```

Note: `setupStreamingDownloads()` is **not needed** for extensions. On Chrome, the bridge files handle service worker registration independently. On Firefox, the blob fallback is used automatically.

## API Reference

### `createStreamingDownload(filename, options?)`

Creates a streaming download writer.

**Parameters:**
- `filename` (string) - The name of the file to download
- `options` (object, optional)
  - `size` (number) - Expected file size in bytes (for progress tracking)
  - `onProgress` ((bytes: number) => void) - Progress callback

**Returns:** `Promise<StreamDownloadWriter>`

```typescript
const writer = await createStreamingDownload('data.json', {
  size: 1024 * 1024,
  onProgress: (bytes) => console.log(`Written: ${bytes} bytes`)
});
```

### `StreamDownloadWriter`

**Methods:**
- `write(chunk: Uint8Array): Promise<void>` - Write a chunk of data
- `close(): Promise<void>` - Finalize and trigger the download
- `abort(): Promise<void>` - Cancel the download

**Properties:**
- `bytesWritten: number` - Total bytes written so far

```typescript
const writer = await createStreamingDownload('file.bin');

try {
  await writer.write(chunk1);
  await writer.write(chunk2);
  console.log(`Written ${writer.bytesWritten} bytes`);
  await writer.close();
} catch (error) {
  await writer.abort();
  throw error;
}
```

### `setupStreamingDownloads(options?)`

Sets up streaming download support in a service worker. **Web apps only** — not needed for extensions.

**Parameters:**
- `options` (object, optional)
  - `debug` (boolean) - Enable debug logging (default: false)

```typescript
// service-worker.js (web apps only)
import { setupStreamingDownloads } from 'drip-fs/background';

setupStreamingDownloads({ debug: true });
```

## Real-World Example: Streaming ZIP Creation

```typescript
import { createStreamingDownload } from 'drip-fs';
import { Writer } from '@transcend-io/conflux';

async function exportAsZip(files: { name: string; blob: Blob }[]) {
  const { readable, writable } = new Writer();
  const zipWriter = writable.getWriter();

  // Create streaming download
  const downloadWriter = await createStreamingDownload('export.zip', {
    onProgress: (bytes) => {
      console.log(`Exported: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    }
  });

  // Pipe zip stream to download writer
  const pipePromise = (async () => {
    const reader = readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await downloadWriter.write(value);
    }
    await downloadWriter.close();
  })();

  // Add files to the zip
  for (const file of files) {
    await zipWriter.write({
      name: file.name,
      lastModified: new Date(),
      stream: () => new Response(file.blob).body!
    });
  }

  await zipWriter.close();
  await pipePromise;
}
```

## Browser Compatibility

| Context | Chrome | Firefox | Edge |
|---------|--------|---------|------|
| Web app | Streaming (SW) | Streaming (SW) | Streaming (SW) |
| Extension (MV3) | Streaming (bridge SW) | Blob fallback | Streaming (bridge SW) |

- Chrome 52+, Firefox 57+, Edge 79+
- Web apps require [Service Workers](https://caniuse.com/serviceworkers) support
- Extensions: Chrome/Edge use bridge SW for streaming; Firefox uses in-memory blob (no SW in extension pages)

## Troubleshooting

### Downloads don't start (web app)

Make sure you have a service worker registered and that it calls `setupStreamingDownloads()`:

```typescript
// service-worker.js
import { setupStreamingDownloads } from 'drip-fs/background';
setupStreamingDownloads({ debug: true });
```

Then register it in your app:

```typescript
navigator.serviceWorker.register('/service-worker.js');
```

The service worker must be active and controlling the page before `createStreamingDownload()` is called. On the first page load after registration, you may need to reload for the SW to take control.

### Downloads don't start (extension)

1. Verify `bridge/bridge.html`, `bridge/bridge.js`, and `bridge/sw.js` are in your extension's build output
2. Verify `bridge/*` is listed in `web_accessible_resources` in your manifest
3. Verify `*/*.zip` (or your download URL pattern) is also in `web_accessible_resources`
4. The bridge files **must** be in a subdirectory (not the extension root) to avoid scope conflicts with the background service worker

### Firefox extension downloads use more memory

Firefox MV3 extensions don't have `navigator.serviceWorker` available, so the library automatically falls back to accumulating all data in memory and triggering a standard blob download on `close()`. For very large files (hundreds of MBs), this may cause high memory usage. This is a Firefox platform limitation — there is no workaround.

### "Service worker not registered" error

This error no longer occurs — the library falls back to blob downloads when no service worker is available. If you see download failures, check that your service worker is registered (web apps) or bridge files are accessible (Chrome extensions).

### TypeScript errors

Ensure you have the DOM and WebWorker libs in tsconfig.json:

```json
{
  "compilerOptions": {
    "lib": ["ES2020", "DOM", "WebWorker"]
  }
}
```

## Acknowledgements

The service-worker streaming protocol used by `drip-fs` is adapted from
[StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js) by Jimmy Wärting,
which pioneered this approach for browsers without the File System Access API.
`drip-fs` re-implements the same protocol with a TypeScript writer API,
extension-aware path detection (direct SW, dedicated bridge SW, blob fallback),
and Firefox MV3 support. Many thanks to Jimmy and the StreamSaver contributors
for the original work.

## License

[MIT](./LICENSE) © prathercc. Portions adapted from StreamSaver.js, © 2016 Jimmy Wärting (MIT).

---
