/**
 * Driver persistence checkpoint across ChatGPT Web page navigations.
 * Survives full page reloads and script reinjections with per-tab isolation.
 */

export type DriverStep =
  | "claimed"
  | "navigating"
  | "started"
  | "prompt_submitting"
  | "waiting_response"
  | "result_extracted"
  | "completed";

export interface DriverCheckpoint {
  readonly schemaVersion: 1;
  readonly tabId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresAtMs: number;
  readonly bindingGeneration: number;
  readonly step: DriverStep;
  readonly attemptId: string;
  readonly savedAtMs: number;
  readonly targetUri?: string | undefined;
  readonly targetConvId?: string | null | undefined;
  readonly baselineCount?: number | undefined;
  readonly candidateResult?: unknown | undefined;
}

export interface CheckpointStore {
  readonly tabId: string;
  get(): DriverCheckpoint | null;
  set(checkpoint: DriverCheckpoint): void;
  delete(): void;
}

export const CHECKPOINT_STORAGE_KEY_PREFIX = "symphony_driver_checkpoint_v1";

export function getOrCreateTabId(win?: Window | null): string {
  if (win && win.sessionStorage) {
    try {
      let tabId = win.sessionStorage.getItem("symphony_tab_id");
      if (!tabId) {
        tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        win.sessionStorage.setItem("symphony_tab_id", tabId);
      }
      return tabId;
    } catch {
      // In restricted sandbox, fallback to memory
    }
  }
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class GmCheckpointStore implements CheckpointStore {
  readonly tabId: string;

  constructor(options?: { tabId?: string; win?: Window | null }) {
    this.tabId =
      options?.tabId ??
      getOrCreateTabId(options?.win ?? (typeof window !== "undefined" ? window : null));
  }

  private getStorageKey(): string {
    return `${CHECKPOINT_STORAGE_KEY_PREFIX}_${this.tabId}`;
  }

  get(): DriverCheckpoint | null {
    const key = this.getStorageKey();
    let val: string | null = null;
    if (typeof GM_getValue === "function") {
      val = GM_getValue<string | null>(key, null);
    } else if (typeof localStorage !== "undefined") {
      try {
        val = localStorage.getItem(key);
      } catch {
        val = null;
      }
    }
    if (!val) return null;
    try {
      const parsed = JSON.parse(val) as DriverCheckpoint;
      // Fail closed on tab mismatch or corrupted schema
      if (!parsed || parsed.tabId !== this.tabId) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  set(checkpoint: DriverCheckpoint): void {
    const withTabId: DriverCheckpoint = {
      ...checkpoint,
      tabId: this.tabId,
    };
    const key = this.getStorageKey();
    const serialized = JSON.stringify(withTabId);
    if (typeof GM_setValue === "function") {
      GM_setValue(key, serialized);
    } else if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(key, serialized);
      } catch {
        // ignore
      }
    }
  }

  delete(): void {
    const key = this.getStorageKey();
    if (typeof GM_deleteValue === "function") {
      GM_deleteValue(key);
    } else if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  readonly tabId: string;
  private current: DriverCheckpoint | null = null;

  constructor(options?: { tabId?: string }) {
    this.tabId = options?.tabId ?? `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  get(): DriverCheckpoint | null {
    if (!this.current) return null;
    if (this.current.tabId !== this.tabId) return null;
    return structuredClone(this.current);
  }

  set(checkpoint: DriverCheckpoint): void {
    this.current = structuredClone({
      ...checkpoint,
      tabId: this.tabId,
    });
  }

  delete(): void {
    this.current = null;
  }
}

export function isCheckpointExpired(checkpoint: DriverCheckpoint, nowMs: number): boolean {
  return nowMs >= checkpoint.leaseExpiresAtMs;
}
