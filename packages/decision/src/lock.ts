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

    const maxAttempts = 5;
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
    const myMeta: LockMetadata = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAtMs: Date.now(),
    };
    let reclaimHandle: fs.FileHandle | null = null;
    try {
      reclaimHandle = await fs.open(this.reclaimLockPath, "wx");
      await reclaimHandle.writeFile(JSON.stringify(myMeta), "utf8");
      await reclaimHandle.sync();
    } catch (err: unknown) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code === "EEXIST") {
        // Another process is currently reclaiming or holding reclaim lock.
        // Check if reclaim lock itself is stale (dead PID on same host):
        try {
          const recContent = await fs.readFile(this.reclaimLockPath, "utf8");
          const recMeta = JSON.parse(recContent) as LockMetadata;
          if (recMeta.hostname === os.hostname() && typeof recMeta.pid === "number") {
            try {
              process.kill(recMeta.pid, 0);
              // Process is ALIVE; cannot reclaim
            } catch (kErr: unknown) {
              if ((kErr as NodeJS.ErrnoException).code === "ESRCH") {
                // The holder of reclaimLockPath is DEAD.
                // Reclaim it atomically without racing direct unlinks:
                const cleanupTmp = `${this.reclaimLockPath}.clean.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
                try {
                  await fs.rename(this.reclaimLockPath, cleanupTmp);
                  try {
                    const movedContent = await fs.readFile(cleanupTmp, "utf8");
                    const movedMeta = JSON.parse(movedContent) as LockMetadata;
                    if (
                      movedMeta.pid === recMeta.pid &&
                      movedMeta.hostname === recMeta.hostname &&
                      movedMeta.acquiredAtMs === recMeta.acquiredAtMs
                    ) {
                      await fs.unlink(cleanupTmp);
                    } else {
                      // Unexpected content; put it back
                      await fs.rename(cleanupTmp, this.reclaimLockPath).catch(() => {});
                    }
                  } catch {
                    await fs.unlink(cleanupTmp).catch(() => {});
                  }
                } catch {
                  // Another process already renamed or unlinked it; ignore
                }
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
        // Still matches the exact inspected stale lock; atomically rename before unlinking
        const cleanupMain = `${this.lockPath}.clean.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fs.rename(this.lockPath, cleanupMain);
          await fs.unlink(cleanupMain);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } finally {
      if (reclaimHandle) {
        await reclaimHandle.close().catch(() => {});
        // Safely remove reclaimLockPath only if it still belongs to this process!
        const releaseTmp = `${this.reclaimLockPath}.rel.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fs.rename(this.reclaimLockPath, releaseTmp);
          try {
            const relContent = await fs.readFile(releaseTmp, "utf8");
            const relMeta = JSON.parse(relContent) as LockMetadata;
            if (
              relMeta.pid === process.pid &&
              relMeta.hostname === os.hostname() &&
              relMeta.acquiredAtMs === myMeta.acquiredAtMs
            ) {
              await fs.unlink(releaseTmp);
            } else {
              // Not ours, put back
              await fs.rename(releaseTmp, this.reclaimLockPath).catch(() => {});
            }
          } catch {
            await fs.unlink(releaseTmp).catch(() => {});
          }
        } catch {
          // If rename failed (already unlinked/moved), ignore
        }
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
        const releaseTmp = `${this.lockPath}.rel.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          await fs.rename(this.lockPath, releaseTmp);
          await fs.unlink(releaseTmp);
        } catch {
          // Best-effort cleanup
        }
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
              const releaseTmp = `${this.lockPath}.exit.${process.pid}.${Date.now()}.tmp`;
              try {
                fsSync.renameSync(this.lockPath, releaseTmp);
                fsSync.unlinkSync(releaseTmp);
              } catch {
                // Ignore
              }
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
