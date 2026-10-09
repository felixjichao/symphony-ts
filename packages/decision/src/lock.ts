import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DecisionStoreLockError } from "./errors";

export interface LockMetadata {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAtMs: number;
}

export class StoreLock {
  private readonly lockPath: string;
  private readonly reclaimLockPath: string;
  private readonly storeDir: string;
  private acquired = false;
  private exitHandler: (() => void) | null = null;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    this.lockPath = path.join(storeDir, "store.lock");
    this.reclaimLockPath = path.join(storeDir, "store.reclaim.lock");
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  async acquire(): Promise<void> {
    if (this.acquired) {
      return;
    }

    await fs.mkdir(this.storeDir, { recursive: true });

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const metadata: LockMetadata = {
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAtMs: Date.now(),
        };

        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }

        this.acquired = true;
        this.installExitHandler();
        return;
      } catch (error: unknown) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "EEXIST") {
          throw new DecisionStoreLockError(
            `Failed to acquire lock for store directory "${this.storeDir}": ${nodeError.message}`
          );
        }

        // Lock file already exists. Inspect if it is stale.
        const staleMeta = await this.inspectExistingLock();
        if (staleMeta && attempt < maxAttempts) {
          const reclaimed = await this.reclaimStaleLock(staleMeta);
          if (reclaimed) {
            continue;
          }
        }

        if (attempt < maxAttempts) {
          // Brief pause before retry
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }

        throw new DecisionStoreLockError(
          `Store directory "${this.storeDir}" is currently locked by another process. Only one active writer is permitted. Remove "${this.lockPath}" only if the owning process is no longer running.`
        );
      }
    }
  }

  private async reclaimStaleLock(expected: LockMetadata): Promise<boolean> {
    let reclaimHandle: fs.FileHandle | null = null;
    try {
      reclaimHandle = await fs.open(this.reclaimLockPath, "wx");
      const meta: LockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
      };
      await reclaimHandle.writeFile(JSON.stringify(meta), "utf8");
      await reclaimHandle.sync();
    } catch (err: unknown) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code === "EEXIST") {
        // Another process is currently reclaiming or holding reclaim lock.
        // Check if reclaim lock itself is stale (> 5s or dead PID on same host):
        try {
          const recContent = await fs.readFile(this.reclaimLockPath, "utf8");
          const recMeta = JSON.parse(recContent) as LockMetadata;
          if (recMeta.hostname === os.hostname() && typeof recMeta.pid === "number") {
            try {
              process.kill(recMeta.pid, 0);
            } catch (kErr: unknown) {
              if ((kErr as NodeJS.ErrnoException).code === "ESRCH") {
                await fs.unlink(this.reclaimLockPath).catch(() => {});
              }
            }
          }
        } catch {
          // Ignore
        }
        return false;
      }
      throw err;
    }

    try {
      // Re-read lockPath while holding the exclusive reclaim lock
      const current = await this.readLockMetadata();
      if (
        current &&
        current.pid === expected.pid &&
        current.hostname === expected.hostname &&
        current.acquiredAtMs === expected.acquiredAtMs
      ) {
        // Still matches the exact inspected stale lock; safe to unlink
        await fs.unlink(this.lockPath);
        return true;
      }
      return false;
    } finally {
      if (reclaimHandle) {
        await reclaimHandle.close().catch(() => {});
        await fs.unlink(this.reclaimLockPath).catch(() => {});
      }
    }
  }

  private async readLockMetadata(): Promise<LockMetadata | null> {
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      return JSON.parse(content) as LockMetadata;
    } catch {
      return null;
    }
  }

  private async inspectExistingLock(): Promise<LockMetadata | null> {
    try {
      const metadata = await this.readLockMetadata();
      if (!metadata) return null;

      if (metadata.hostname === os.hostname() && typeof metadata.pid === "number") {
        try {
          // Check if process is running
          process.kill(metadata.pid, 0);
          // Process is alive
          return null;
        } catch (killError: unknown) {
          const err = killError as NodeJS.ErrnoException;
          if (err.code === "ESRCH") {
            // Process does not exist; lock is stale
            return metadata;
          }
          // EPERM means process exists but we lack permission to signal it
          return null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async release(): Promise<void> {
    if (!this.acquired) {
      return;
    }

    this.removeExitHandler();
    this.acquired = false;

    try {
      const metadata = await this.readLockMetadata();
      if (metadata && metadata.pid === process.pid && metadata.hostname === os.hostname()) {
        await fs.unlink(this.lockPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private installExitHandler(): void {
    if (this.exitHandler) return;
    this.exitHandler = () => {
      if (this.acquired) {
        try {
          if (fsSync.existsSync(this.lockPath)) {
            const content = fsSync.readFileSync(this.lockPath, "utf8");
            const meta = JSON.parse(content) as LockMetadata;
            if (meta.pid === process.pid && meta.hostname === os.hostname()) {
              fsSync.unlinkSync(this.lockPath);
            }
          }
        } catch {
          // Process exiting, ignore errors
        }
      }
    };
    process.once("exit", this.exitHandler);
  }

  private removeExitHandler(): void {
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
  }
}
