import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { githubDecisionRoot } from "@symphony/domain";
import {
  CorruptedStoreError,
  DecisionConflictError,
  DecisionStoreLockError,
  DecisionBridge,
  DecisionBridgeClient,
  DecisionService,
  DurableDecisionStore,
  StoreLock,
} from "./index";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-fix-"));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store, { clock: () => 1000 });
  const session = await service.createSession(githubDecisionRoot("owner", "repo", 95));
  return {
    dir,
    store,
    service,
    session,
    cleanup: async () => {
      vi.restoreAllMocks();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("Review blocker regressions", () => {
  it("rejects conflicting failure replay and invalid claim token with 409 conflict", async () => {
    const f = await fixture();
    try {
      const task = await f.service.createPlanTask(f.session.id, { operationKey: "failure" });
      const claim = await f.service.claimTask(task.id, { owner: "worker" });
      const credentials = { owner: "worker", token: claim.lease.token, generation: 1 };
      await f.service.submitFailure(task.id, {
        ...credentials,
        error: "timeout",
        details: { step: 1 },
        retryable: true,
      });

      // Replay with invalid claim token must reject with 409 conflict
      await expect(
        f.service.submitFailure(task.id, {
          ...credentials,
          token: "WRONG",
          error: "timeout",
          details: { step: 1 },
          retryable: true,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Replay with conflicting details or retryable must reject with 409 conflict
      await expect(
        f.service.submitFailure(task.id, {
          ...credentials,
          error: "timeout",
          details: { step: 2 },
          retryable: false,
        })
      ).rejects.toThrow(DecisionConflictError);

      // Idempotent replay with matching token and payload succeeds
      const validReplay = await f.service.submitFailure(task.id, {
        ...credentials,
        error: "timeout",
        details: { step: 1 },
        retryable: true,
      });
      expect(validReplay.failure.retryable).toBe(true);
      expect(validReplay.failure.details).toEqual({ step: 1 });
    } finally {
      await f.cleanup();
    }
  });

  it("rejects operation-key collision across different sessions or task kinds with 409 conflict", async () => {
    const f = await fixture();
    try {
      const first = await f.service.createPlanTask(f.session.id, { operationKey: "shared" });
      const secondSession = await f.service.createSession(githubDecisionRoot("owner", "repo", 96));

      // Attempting to use same operation key for a review task on different session throws 409
      await expect(
        f.service.createReviewTask(secondSession.id, {
          operationKey: "shared",
          target: { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) },
        })
      ).rejects.toThrow(DecisionConflictError);

      // Replaying same operation key for original plan task succeeds idempotently
      const replay = await f.service.createPlanTask(f.session.id, { operationKey: "shared" });
      expect(replay.id).toBe(first.id);
      expect(replay.kind).toBe("plan");
      expect(replay.sessionId).toBe(f.session.id);
    } finally {
      await f.cleanup();
    }
  });

  it("fails closed with CorruptedStoreError when snapshot has key mismatch or missing indexes", async () => {
    const f = await fixture();
    const other = new DurableDecisionStore({ storeDir: f.dir });
    try {
      const target = { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) };
      const task = await f.service.createReviewTask(f.session.id, { operationKey: "review", target });
      const claim = await f.service.claimTask(task.id, { owner: "worker" });
      const credentials = { owner: "worker", token: claim.lease.token, generation: 1 };
      await f.service.startTask(task.id, credentials);
      await f.service.submitResult(task.id, {
        ...credentials,
        result: {
          schemaVersion: 1,
          kind: "review",
          taskId: task.id,
          sessionId: f.session.id,
          revision: 1,
          target,
          verdict: "approve",
          findings: [],
          createdAtMs: 1000,
        },
      });
      const secondTarget = { ...target, prNumber: 2 };
      const secondTask = await f.service.createReviewTask(f.session.id, {
        operationKey: "second-review",
        target: secondTarget,
      });
      await f.store.close();

      const filename = path.join(f.dir, "store.json");
      const raw = JSON.parse(await fs.readFile(filename, "utf8"));
      raw.results[task.id].taskId = secondTask.id;
      raw.results[task.id].target = secondTarget;
      delete raw.revisions;
      delete raw.operationReceipts;
      await fs.writeFile(filename, JSON.stringify(raw));

      // Re-opening corrupted snapshot must fail closed
      await expect(other.open()).rejects.toThrow(CorruptedStoreError);
    } finally {
      await other.close().catch(() => {});
      await f.cleanup();
    }
  });

  it("rejects untrusted simple cross-origin POST and preflight with 403 Forbidden without mutating state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-http-"));
    const bridge = new DecisionBridge({ storeDir: dir, port: 0 });
    try {
      const { port } = await bridge.start();

      // Simple POST from unauthorized origin must be rejected with 403
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "Content-Type": "text/plain" },
        body: JSON.stringify({ root: { provider: "github", key: "owner/repo#95" } }),
      });
      expect(response.status).toBe(403);
      expect(bridge.getService().getAllSessions()).toHaveLength(0);

      // Preflight OPTIONS from unauthorized origin must also be rejected with 403
      const preflight = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: "OPTIONS",
        headers: { Origin: "https://attacker.example" },
      });
      expect(preflight.status).toBe(403);
    } finally {
      await bridge.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates directory fsync EIO and poisons the store", async () => {
    const f = await fixture();
    const originalOpen = fs.open.bind(fs);
    try {
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === f.dir && args[1] === "r") {
          handle.sync = async () => {
            throw Object.assign(new Error("injected I/O error"), { code: "EIO" });
          };
        }
        return handle;
      });

      await expect(
        f.service.createPlanTask(f.session.id, { operationKey: "fsync" })
      ).rejects.toThrow();
      expect(f.store.isPoisoned()).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("prevents dual lock acquisition when two reclaimers race on stale lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-lock-"));
    const lockPath = path.join(dir, "store.lock");
    const a = new StoreLock(dir);
    const b = new StoreLock(dir);
    try {
      // Simulate stale lock from dead PID
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAtMs: 1 })
      );

      // When racing to acquire, mutual exclusion on reclaim guarantees at most one succeeds
      const results = await Promise.allSettled([a.acquire(), b.acquire()]);
      const acquiredCount = (a.isAcquired() ? 1 : 0) + (b.isAcquired() ? 1 : 0);
      expect(acquiredCount).toBe(1);

      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected).toBeDefined();
      if (rejected && rejected.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(DecisionStoreLockError);
      }
    } finally {
      await a.release().catch(() => {});
      await b.release().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("allows controller to read verdict and receipt via HTTP across bridge restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-restart-"));
    const target = { repository: "owner/repo", prNumber: 42, headSha: "b".repeat(40) };

    let taskId = "";
    // Step 1: Bridge instance 1
    const bridge1 = new DecisionBridge({ storeDir: dir, port: 0 });
    const { port: port1 } = await bridge1.start();
    const client1 = new DecisionBridgeClient(`http://127.0.0.1:${port1}`);

    const root = githubDecisionRoot("owner", "repo", 42);
    const sessionRes = await client1.createSession(root);
    const taskRes = await client1.createTask({
      sessionId: sessionRes.session.id,
      kind: "review",
      target,
      operationKey: "op-rev-1",
    });
    taskId = taskRes.task.id;

    const claimRes = await client1.claimTask(taskId, { owner: "executor-1" });
    await client1.startTask(taskId, {
      owner: "executor-1",
      token: claimRes.lease.token,
      generation: claimRes.lease.generation,
    });

    await client1.submitResult(taskId, {
      owner: "executor-1",
      token: claimRes.lease.token,
      generation: claimRes.lease.generation,
      result: {
        schemaVersion: 1,
        kind: "review",
        taskId,
        sessionId: sessionRes.session.id,
        revision: 1,
        target,
        verdict: "changes_requested",
        findings: [{ severity: "blocker", message: "security flaw", location: null }],
        createdAtMs: Date.now(),
      },
    });

    await bridge1.stop();

    // Step 2: Bridge instance 2 (simulating restart)
    const bridge2 = new DecisionBridge({ storeDir: dir, port: 0 });
    const { port: port2 } = await bridge2.start();
    const client2 = new DecisionBridgeClient(`http://127.0.0.1:${port2}`);

    try {
      const resultRes = await client2.getTaskResult(taskId);
      expect(resultRes.result.kind).toBe("review");
      expect(resultRes.result.verdict).toBe("changes_requested");
      if (resultRes.result.kind === "review") {
        expect(resultRes.result.findings).toHaveLength(1);
        expect(resultRes.result.findings[0]?.message).toBe("security flaw");
      }

      const receiptRes = await client2.getTaskReceipt(taskId);
      expect(receiptRes.receipt.type).toBe("result");
      expect(receiptRes.receipt.claimOwner).toBe("executor-1");
      expect(receiptRes.receipt.claimToken).toBe(claimRes.lease.token);
    } finally {
      await bridge2.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
