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
    tabId: "tab-1",
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
    const store = new MemoryCheckpointStore({ tabId: "tab-1" });
    expect(store.get()).toBeNull();

    store.set(sampleCheckpoint);
    expect(store.get()).toEqual(sampleCheckpoint);

    store.delete();
    expect(store.get()).toBeNull();
  });

  it("enforces per-tab isolation between independent tab stores", () => {
    const mockStorage: Record<string, string> = {};
    gmScope.GM_getValue = (k: string) => mockStorage[k] ?? null;
    gmScope.GM_setValue = (k: string, v: unknown) => {
      mockStorage[k] = String(v);
    };
    gmScope.GM_deleteValue = (k: string) => {
      delete mockStorage[k];
    };

    const tabAStore = new GmCheckpointStore({ tabId: "tab-a" });
    const tabBStore = new GmCheckpointStore({ tabId: "tab-b" });

    tabAStore.set({ ...sampleCheckpoint, tabId: "tab-a", leaseOwner: "tab-a-driver" });

    // Tab B cannot read Tab A's lease/checkpoint
    expect(tabBStore.get()).toBeNull();

    // Tab A reads its own checkpoint
    expect(tabAStore.get()?.leaseOwner).toBe("tab-a-driver");

    // Tab B setting its own checkpoint does not overwrite Tab A
    tabBStore.set({ ...sampleCheckpoint, tabId: "tab-b", leaseOwner: "tab-b-driver" });
    expect(tabAStore.get()?.leaseOwner).toBe("tab-a-driver");
    expect(tabBStore.get()?.leaseOwner).toBe("tab-b-driver");
  });

  describe("GmCheckpointStore", () => {
    beforeEach(() => {
      delete gmScope.GM_getValue;
      delete gmScope.GM_setValue;
      delete gmScope.GM_deleteValue;
    });

    it("uses GM storage when GM APIs are available", () => {
      const mockStorage: Record<string, string> = {};
      gmScope.GM_getValue = (k: string) => mockStorage[k] ?? null;
      gmScope.GM_setValue = (k: string, val: unknown) => {
        mockStorage[k] = String(val);
      };
      gmScope.GM_deleteValue = (k: string) => {
        delete mockStorage[k];
      };

      const store = new GmCheckpointStore({ tabId: "tab-1" });
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

      const store = new GmCheckpointStore({ tabId: "tab-1" });
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
