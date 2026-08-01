import { vi } from "vitest";

function storageArea() {
  return {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

export function createBrowserMock() {
  return {
    storage: {
      local: storageArea(),
      sync: storageArea(),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: "9.1.0" })),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    },
  };
}
