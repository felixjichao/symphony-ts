/**
 * Driver persistence checkpoint across ChatGPT Web page navigations.
 * Survives full page reloads and script reinjections.
 */

export type DriverStep =
  | "claimed"
  | "session_bootstrapped"
  | "prompt_submitting"
  | "waiting_response"
  | "result_extracted"
  | "completed";

export interface DriverCheckpoint {
  readonly schemaVersion: 1;
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
  readonly candidateResult?: unknown | undefined;
}

export interface CheckpointStore {
  get(): DriverCheckpoint | null;
  set(checkpoint: DriverCheckpoint): void;
  delete(): void;
}

export const CHECKPOINT_STORAGE_KEY = "symphony_driver_checkpoint_v1";

export class GmCheckpointStore implements CheckpointStore {
  get(): DriverCheckpoint | null {
    if (typeof GM_getValue !== "function") {
      try {
        const item = localStorage.getItem(CHECKPOINT_STORAGE_KEY);
        return item ? (JSON.parse(item) as DriverCheckpoint) : null;
      } catch {
        return null;
      }
    }
    const val = GM_getValue<string | null>(CHECKPOINT_STORAGE_KEY, null);
    if (!val) return null;
    try {
      return JSON.parse(val) as DriverCheckpoint;
    } catch {
      return null;
    }
  }

  set(checkpoint: DriverCheckpoint): void {
    const serialized = JSON.stringify(checkpoint);
    if (typeof GM_setValue !== "function") {
      try {
        localStorage.setItem(CHECKPOINT_STORAGE_KEY, serialized);
      } catch {
        // ignore
      }
      return;
    }
    GM_setValue(CHECKPOINT_STORAGE_KEY, serialized);
  }

  delete(): void {
    if (typeof GM_deleteValue !== "function") {
      try {
        localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
      } catch {
        // ignore
      }
      return;
    }
    GM_deleteValue(CHECKPOINT_STORAGE_KEY);
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  private current: DriverCheckpoint | null = null;

  get(): DriverCheckpoint | null {
    return this.current ? structuredClone(this.current) : null;
  }

  set(checkpoint: DriverCheckpoint): void {
    this.current = structuredClone(checkpoint);
  }

  delete(): void {
    this.current = null;
  }
}

export function isCheckpointExpired(checkpoint: DriverCheckpoint, nowMs: number): boolean {
  return nowMs >= checkpoint.leaseExpiresAtMs;
}
