import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionStoreLockError } from "./errors";
import { StoreLock } from "./lock";

describe("StoreLock single-writer process lock", () => {
  it("acquires and releases exclusive lock file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-lock-test-"));
    try {
      const lock1 = new StoreLock(tmpDir);
      expect(lock1.isAcquired()).toBe(false);

      await lock1.acquire();
      expect(lock1.isAcquired()).toBe(true);

      const lockFilePath = path.join(tmpDir, "store.lock");
      const stat = await fs.stat(lockFilePath);
      expect(stat.isFile()).toBe(true);

      // Second acquire on the same instance is a no-op
      await lock1.acquire();
      expect(lock1.isAcquired()).toBe(true);

      // Another instance cannot acquire while first holds it
      const lock2 = new StoreLock(tmpDir);
      await expect(lock2.acquire()).rejects.toThrow(DecisionStoreLockError);

      await lock1.release();
      expect(lock1.isAcquired()).toBe(false);

      // Now lock2 can acquire it
      await lock2.acquire();
      expect(lock2.isAcquired()).toBe(true);
      await lock2.release();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers from stale lock file with nonexistent PID", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-lock-stale-"));
    try {
      const lockFilePath = path.join(tmpDir, "store.lock");
      // Pick a PID that does not exist (e.g. 999999)
      const staleMeta = {
        pid: 999999,
        hostname: os.hostname(),
        acquiredAtMs: Date.now() - 60000,
      };
      await fs.writeFile(lockFilePath, JSON.stringify(staleMeta), "utf8");

      const lock = new StoreLock(tmpDir);
      await lock.acquire();
      expect(lock.isAcquired()).toBe(true);

      const content = JSON.parse(await fs.readFile(lockFilePath, "utf8"));
      expect(content.pid).toBe(process.pid);

      await lock.release();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
