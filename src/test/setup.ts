/**
 * Test setup file
 * Runs before all tests to set up global mocks and utilities
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Mock chrome API for extension tests
const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
  },
};

// Mock service worker for web context tests
const mockServiceWorker = {
  controller: {
    postMessage: vi.fn(),
  },
  ready: Promise.resolve(),
};

// Store original values
const originalChrome = (globalThis as any).chrome;
const originalNavigator = globalThis.navigator;

beforeEach(() => {
  // Reset mocks
  vi.clearAllMocks();

  // Set up default mocks (can be overridden in individual tests)
  (globalThis as any).chrome = mockChrome;

  // Mock navigator.serviceWorker
  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: mockServiceWorker,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Restore originals
  (globalThis as any).chrome = originalChrome;

  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  }
});

// Export mock utilities for tests
export { mockChrome, mockServiceWorker };
