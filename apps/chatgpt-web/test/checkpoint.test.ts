import { describe, it, expect, beforeEach } from "vitest";
import {
  type DriverCheckpoint,
  MemoryCheckpointStore,
  GmCheckpointStore,
  isCheckpointExpired,
} from "../src/checkpoint";

interface MockGmScope {
  GM_getValue?: (key: string, def?: unknown) => unknown;
  GM_setValue?: (key: string, val: unknown) => void;
  GM_deleteValue?: (key: string) => void;
  localStorage?: Storage;
}

const gmScope = globalThis as unknown as MockGmScope;

describe("Driver Checkpoints", () => {
  const sampleCheckpoint: DriverCheckpoint = {
    schemaVersion: 1,
    taskId: "task-1",
    sessionId: "github:owner/repo#1",
    leaseOwner: "driver-1",
    leaseToken: "tok-abc",
    leaseGeneration: 1,
    leaseExpiresAtMs: 100_000,
    bindingGeneration: 1,
    step: "claimed",
    attemptId: "att-1",
    savedAtMs: 50_000,
  };

  it("MemoryCheckpointStore stores, retrieves, and clears checkpoint", () => {
    const store = new MemoryCheckpointStore();
    expect(store.get()).toBeNull();

    store.set(sampleCheckpoint);
    expect(store.get()).toEqual(sampleCheckpoint);

    store.delete();
    expect(store.get()).toBeNull();
  });

  describe("GmCheckpointStore", () => {
    beforeEach(() => {
      delete gmScope.GM_getValue;
      delete gmScope.GM_setValue;
      delete gmScope.GM_deleteValue;
    });

    it("uses GM storage when GM APIs are available", () => {
      let stored: string | null = null;
      gmScope.GM_getValue = () => stored;
      gmScope.GM_setValue = (_key: string, val: unknown) => {
        stored = String(val);
      };
      gmScope.GM_deleteValue = () => {
        stored = null;
      };

      const store = new GmCheckpointStore();
      expect(store.get()).toBeNull();

      store.set(sampleCheckpoint);
      expect(store.get()).toEqual(sampleCheckpoint);

      store.delete();
      expect(store.get()).toBeNull();
    });

    it("falls back to localStorage when GM APIs are not available", () => {
      const mockLocalStorage: Record<string, string> = {};
      gmScope.localStorage = {
        getItem: (k: string) => mockLocalStorage[k] ?? null,
        setItem: (k: string, v: string) => {
          mockLocalStorage[k] = v;
        },
        removeItem: (k: string) => {
          delete mockLocalStorage[k];
        },
        clear: () => {
          for (const k of Object.keys(mockLocalStorage)) {
            delete mockLocalStorage[k];
          }
        },
        key: (_idx: number) => null,
        length: 0,
      };

      const store = new GmCheckpointStore();
      expect(store.get()).toBeNull();

      store.set(sampleCheckpoint);
      expect(store.get()).toEqual(sampleCheckpoint);

      store.delete();
      expect(store.get()).toBeNull();
    });
  });

  it("detects expired checkpoint based on lease expiration", () => {
    expect(isCheckpointExpired(sampleCheckpoint, 99_999)).toBe(false);
    expect(isCheckpointExpired(sampleCheckpoint, 100_000)).toBe(true);
    expect(isCheckpointExpired(sampleCheckpoint, 100_001)).toBe(true);
  });
});
