import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubDecisionRoot,
  decisionSessionId,
  decisionTaskId,
  type DecisionSession,
  type DecisionTask,
} from "@symphony/domain";
import {
  CorruptedStoreError,
  DecisionStoreLockError,
  UnsupportedStoreVersionError,
} from "./errors";
import { DurableDecisionStore } from "./store";

describe("DurableDecisionStore", () => {
  it("initializes empty store and survives process restart", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-test-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tmpDir });
      await store1.open();

      const root = githubDecisionRoot("owner", "repo", 42);
      const sessionId = decisionSessionId(root);
      const session: DecisionSession = {
        schemaVersion: 1,
        id: sessionId,
        root,
        status: "active",
        binding: null,
        bindingGeneration: 0,
        createdAtMs: 100,
        updatedAtMs: 100,
      };

      const taskId = decisionTaskId({ sessionId, kind: "plan", revision: 1 });
      const task: DecisionTask = {
        schemaVersion: 1,
        id: taskId,
        sessionId,
        kind: "plan",
        revision: 1,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: 100,
        updatedAtMs: 100,
      };

      await store1.transaction((draft) => {
        draft.sessions[sessionId] = session;
        draft.tasks[taskId] = task;
      });

      expect(store1.getSession(sessionId)).toEqual(session);
      expect(store1.getTask(taskId)).toEqual(task);
      await store1.close();

      // Open new store instance on same directory (simulating restart)
      const store2 = new DurableDecisionStore({ storeDir: tmpDir });
      await store2.open();

      expect(store2.getSession(sessionId)).toEqual(session);
      expect(store2.getTask(taskId)).toEqual(task);
      expect(store2.getState().transactionSequence).toBe(1);

      await store2.close();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("prevents second concurrent instance on same store directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-concurrent-"));
    try {
      const store1 = new DurableDecisionStore({ storeDir: tmpDir });
      await store1.open();

      const store2 = new DurableDecisionStore({ storeDir: tmpDir });
      await expect(store2.open()).rejects.toThrow(DecisionStoreLockError);

      await store1.close();
      await store2.open();
      await store2.close();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupted JSON or invalid schema version", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-corrupt-"));
    try {
      const storePath = path.join(tmpDir, "store.json");

      // Corrupted JSON
      await fs.writeFile(storePath, "{ bad json", "utf8");
      const store1 = new DurableDecisionStore({ storeDir: tmpDir });
      await expect(store1.open()).rejects.toThrow(CorruptedStoreError);
      await store1.close();

      // Invalid schema version
      await fs.writeFile(
        storePath,
        JSON.stringify({ schemaVersion: 999, transactionSequence: 1, sessions: {}, tasks: {} }),
        "utf8"
      );
      const store2 = new DurableDecisionStore({ storeDir: tmpDir });
      await expect(store2.open()).rejects.toThrow(UnsupportedStoreVersionError);
      await store2.close();

      // Mismatched referential integrity (task references non-existent session)
      const orphanTask: DecisionTask = {
        schemaVersion: 1,
        id: "github:owner/repo#1:plan:1",
        sessionId: "github:owner/repo#1",
        kind: "plan",
        revision: 1,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: 10,
        updatedAtMs: 10,
      };
      await fs.writeFile(
        storePath,
        JSON.stringify({
          schemaVersion: 1,
          transactionSequence: 1,
          sessions: {},
          tasks: { [orphanTask.id]: orphanTask },
          results: {},
          failures: {},
          receipts: {},
          revisions: {},
          operationReceipts: {},
        }),
        "utf8"
      );
      const store3 = new DurableDecisionStore({ storeDir: tmpDir });
      await expect(store3.open()).rejects.toThrow(CorruptedStoreError);
      await store3.close();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
