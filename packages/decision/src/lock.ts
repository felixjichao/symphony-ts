import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DecisionStoreLockError } from "./errors";

export interface LockMetadata {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAtMs: number;
  readonly nonce?: string;
}

export class StoreLock {
  private readonly lockPath: string;
  private readonly reclaimLockPath: string;
  private readonly storeDir: string;
  private acquired = false;
  private currentNonce: string | null = null;
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
      const myNonce = crypto.randomUUID();
      const metadata: LockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
        nonce: myNonce,
      };

      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }

        this.acquired = true;
        this.currentNonce = myNonce;
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
          const reclaimed = await this.reclaimStaleLock(staleMeta, myNonce);
          if (reclaimed) {
            this.acquired = true;
            this.currentNonce = myNonce;
            this.installExitHandler();
            return;
          }
        }

        if (attempt < maxAttempts) {
          // Jittered backoff before retry
          const jitter = 10 + Math.floor(Math.random() * 20);
          await new Promise((r) => setTimeout(r, jitter));
          continue;
        }

        throw new DecisionStoreLockError(
          `Store directory "${this.storeDir}" is currently locked by another process. Only one active writer is permitted. Remove "${this.lockPath}" only if the owning process is no longer running.`
        );
      }
    }
  }

  private async acquireReclaimMutex(reclaimNonce: string): Promise<boolean> {
    const reclaimMeta: LockMetadata = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAtMs: Date.now(),
      nonce: reclaimNonce,
    };

    try {
      const handle = await fs.open(this.reclaimLockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(reclaimMeta, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (err: unknown) {
      const nodeError = err as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        return false;
      }
    }

    // reclaimLockPath exists; check if it is stale
    const existing = await this.readReclaimMetadata();
    if (!existing) {
      return false;
    }

    if (existing.hostname !== os.hostname() || typeof existing.pid !== "number") {
      return false;
    }

    try {
      process.kill(existing.pid, 0);
      return false; // Process is alive
    } catch (killErr: unknown) {
      const kErr = killErr as NodeJS.ErrnoException;
      if (kErr.code !== "ESRCH") {
        return false;
      }
    }

    // Process is dead. Atomically retire the stale reclaim lock via hardlink tombstone.
    const tombstone = `${this.reclaimLockPath}.retired.${existing.pid}.${existing.acquiredAtMs}.${existing.nonce || "0"}`;
    try {
      await fs.link(this.reclaimLockPath, tombstone);
    } catch {
      return false;
    }

    // Inode and identity verification
    const stLock = await fs.stat(this.reclaimLockPath).catch(() => null);
    const stTomb = await fs.stat(tombstone).catch(() => null);
    if (!stLock || !stTomb || stLock.ino !== stTomb.ino) {
      return false;
    }

    const tombContent = await fs.readFile(tombstone, "utf8").catch(() => null);
    if (!tombContent) {
      return false;
    }
    try {
      const tombMeta = JSON.parse(tombContent) as LockMetadata;
      if (
        tombMeta.pid !== existing.pid ||
        tombMeta.hostname !== existing.hostname ||
        tombMeta.acquiredAtMs !== existing.acquiredAtMs
      ) {
        return false;
      }
    } catch {
      return false;
    }

    // Safe to unlink the retired reclaim lock
    await fs.unlink(this.reclaimLockPath).catch(() => {});

    // Acquire reclaim lock via O_CREAT | O_EXCL
    try {
      const handle = await fs.open(this.reclaimLockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(reclaimMeta, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch {
      return false;
    }
  }

  private async reclaimStaleLock(expected: LockMetadata, lockNonce: string): Promise<boolean> {
    const reclaimNonce = crypto.randomUUID();
    const gotMutex = await this.acquireReclaimMutex(reclaimNonce);
    if (!gotMutex) {
      return false;
    }

    try {
      const current = await this.readLockMetadata();
      if (
        !current ||
        current.pid !== expected.pid ||
        current.hostname !== expected.hostname ||
        current.acquiredAtMs !== expected.acquiredAtMs
      ) {
        return false;
      }

      try {
        process.kill(current.pid, 0);
        return false; // Alive!
      } catch (kErr: unknown) {
        if ((kErr as NodeJS.ErrnoException).code !== "ESRCH") {
          return false;
        }
      }

      // Atomically retire the stale main lock via hardlink tombstone
      const tombstone = `${this.lockPath}.retired.${current.pid}.${current.acquiredAtMs}.${current.nonce || "0"}`;
      try {
        await fs.link(this.lockPath, tombstone);
      } catch {
        return false;
      }

      // Inode and identity verification
      const stLock = await fs.stat(this.lockPath).catch(() => null);
      const stTomb = await fs.stat(tombstone).catch(() => null);
      if (!stLock || !stTomb || stLock.ino !== stTomb.ino) {
        return false;
      }

      const tombContent = await fs.readFile(tombstone, "utf8").catch(() => null);
      if (!tombContent) {
        return false;
      }
      try {
        const tombMeta = JSON.parse(tombContent) as LockMetadata;
        if (
          tombMeta.pid !== current.pid ||
          tombMeta.hostname !== current.hostname ||
          tombMeta.acquiredAtMs !== current.acquiredAtMs
        ) {
          return false;
        }
      } catch {
        return false;
      }

      // Safe to unlink the retired main lock
      await fs.unlink(this.lockPath).catch(() => {});

      const myMainMeta: LockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
        nonce: lockNonce,
      };

      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(myMainMeta, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      } catch {
        return false;
      }
    } finally {
      try {
        const check = await this.readReclaimMetadata();
        if (
          check &&
          check.pid === process.pid &&
          check.hostname === os.hostname() &&
          check.nonce === reclaimNonce
        ) {
          await fs.unlink(this.reclaimLockPath).catch(() => {});
        }
      } catch {
        // Ignore
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

  private async readReclaimMetadata(): Promise<LockMetadata | null> {
    try {
      const content = await fs.readFile(this.reclaimLockPath, "utf8");
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
      if (
        metadata &&
        metadata.pid === process.pid &&
        metadata.hostname === os.hostname() &&
        (this.currentNonce ? metadata.nonce === this.currentNonce : true)
      ) {
        await fs.unlink(this.lockPath).catch(() => {});
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
            if (
              meta.pid === process.pid &&
              meta.hostname === os.hostname() &&
              (this.currentNonce ? meta.nonce === this.currentNonce : true)
            ) {
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
