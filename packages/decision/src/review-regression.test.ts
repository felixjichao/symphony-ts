import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { githubDecisionRoot, decisionTaskId } from "@symphony/domain";
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
import { validateStoreRecord } from "./store";
import type { DecisionStoreRecord } from "./types";

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

  it("rejects rebind operation payload conflict and replays original resulting session", async () => {
    const f = await fixture();
    try {
      await f.service.putBinding(f.session.id, {
        adapter: "browser",
        externalSessionRef: "one",
        resumeUri: null,
      });
      const params = {
        adapter: "browser",
        externalSessionRef: "two",
        resumeUri: null,
        expectedGeneration: 1,
        operationKey: "rebind",
      };
      const first = await f.service.rebindSession(f.session.id, params);
      expect(first.bindingGeneration).toBe(2);
      expect(first.binding?.externalSessionRef).toBe("two");

      // Conflicting payload on same operation key throws 409
      await expect(
        f.service.rebindSession(f.session.id, {
          ...params,
          adapter: "OTHER",
          externalSessionRef: "DIFFERENT",
          resumeUri: "different",
        })
      ).rejects.toThrow(DecisionConflictError);

      // Subsequent rebind advances session to generation 3
      await f.service.rebindSession(f.session.id, {
        ...params,
        externalSessionRef: "three",
        expectedGeneration: 2,
        operationKey: "next-rebind",
      });
      expect(f.store.getSession(f.session.id)?.bindingGeneration).toBe(3);

      // Replay of the first operation returns the original historical session (generation 2, 'two')
      const replay = await f.service.rebindSession(f.session.id, params);
      expect(replay.bindingGeneration).toBe(2);
      expect(replay.binding?.externalSessionRef).toBe("two");
    } finally {
      await f.cleanup();
    }
  });

  it("fails closed on corrupted operation receipt target mismatch on restart", async () => {
    const f = await fixture();
    const reopened = new DurableDecisionStore({ storeDir: f.dir });
    try {
      const targetA = { repository: "owner/repo", prNumber: 1, headSha: "a".repeat(40) };
      const targetB = { ...targetA, headSha: "b".repeat(40) };
      await f.service.createReviewTask(f.session.id, { operationKey: "review", target: targetA });
      await f.store.close();

      const filename = path.join(f.dir, "store.json");
      const raw = JSON.parse(await fs.readFile(filename, "utf8"));
      raw.operationReceipts.review.target = targetB;
      await fs.writeFile(filename, JSON.stringify(raw));

      // Startup must fail closed with CorruptedStoreError
      await expect(reopened.open()).rejects.toThrow(CorruptedStoreError);
    } finally {
      await reopened.close().catch(() => {});
      await f.cleanup();
    }
  });

  it("fails closed on corrupted receipt claim credentials on restart", async () => {
    const f = await fixture();
    const reopened = new DurableDecisionStore({ storeDir: f.dir });
    try {
      const task = await f.service.createPlanTask(f.session.id, { operationKey: "failure" });
      const claim = await f.service.claimTask(task.id, { owner: "worker" });
      await f.service.submitFailure(task.id, {
        owner: "worker",
        token: claim.lease.token,
        generation: 1,
        error: "timeout",
      });
      await f.store.close();

      const filename = path.join(f.dir, "store.json");
      const raw = JSON.parse(await fs.readFile(filename, "utf8"));
      raw.receipts[task.id].claimToken = "WRONG";
      raw.receipts[task.id].claimGeneration = 999;
      await fs.writeFile(filename, JSON.stringify(raw));

      // Startup must fail closed with CorruptedStoreError
      await expect(reopened.open()).rejects.toThrow(CorruptedStoreError);
    } finally {
      await reopened.close().catch(() => {});
      await f.cleanup();
    }
  });

  it("prevents dual lock acquisition when both main lock and reclaim mutex are stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-r2-lock-"));
    const main = path.join(dir, "store.lock");
    const reclaim = path.join(dir, "store.reclaim.lock");
    const a = new StoreLock(dir);
    const b = new StoreLock(dir);
    try {
      const dead = JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAtMs: 1 });
      await fs.writeFile(main, dead);
      await fs.writeFile(reclaim, dead);

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

  it("validates the canonical persistence envelope documented in decision-protocol.md", () => {
    const sessionId = "github:owner/repo#42";
    const planId = decisionTaskId({ sessionId, kind: "plan", revision: 1 });
    const reviewTarget = {
      repository: "owner/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };
    const reviewId = decisionTaskId({
      sessionId,
      kind: "review",
      revision: 1,
      target: reviewTarget,
    });

    const record = {
      schemaVersion: 1,
      transactionSequence: 2,
      sessions: {
        [sessionId]: {
          schemaVersion: 1,
          id: sessionId,
          root: { provider: "github", key: "owner/repo#42" },
          status: "active",
          binding: {
            schemaVersion: 1,
            adapter: "browser-agent",
            externalSessionRef: "chat-002",
            resumeUri: null,
            generation: 2,
          },
          bindingGeneration: 2,
          createdAtMs: 1700000000000,
          updatedAtMs: 1700000001000,
        },
      },
      tasks: {
        [planId]: {
          schemaVersion: 1,
          id: planId,
          sessionId,
          kind: "plan",
          revision: 1,
          status: "completed",
          lease: null,
          claimGeneration: 1,
          lastClaimToken: "00000000-0000-0000-0000-000000000001",
          createdAtMs: 1700000000000,
          updatedAtMs: 1700000000500,
        },
        [reviewId]: {
          schemaVersion: 1,
          id: reviewId,
          sessionId,
          kind: "review",
          revision: 1,
          status: "pending",
          target: reviewTarget,
          lease: null,
          claimGeneration: 0,
          lastClaimToken: null,
          createdAtMs: 1700000000600,
          updatedAtMs: 1700000000600,
        },
      },
      results: {
        [planId]: {
          schemaVersion: 1,
          kind: "plan",
          taskId: planId,
          sessionId,
          revision: 1,
          verdict: "ready",
          content: {
            plan: "Step 1",
            acceptanceCriteria: ["AC1"],
            risks: [],
            clarifications: [],
          },
          createdAtMs: 1700000000500,
        },
      },
      failures: {},
      receipts: {
        [planId]: {
          schemaVersion: 1,
          taskId: planId,
          type: "result",
          claimGeneration: 1,
          claimOwner: "worker-1",
          claimToken: "00000000-0000-0000-0000-000000000001",
          acceptedAtMs: 1700000000500,
          payload: {
            schemaVersion: 1,
            kind: "plan",
            taskId: planId,
            sessionId,
            revision: 1,
            verdict: "ready",
            content: {
              plan: "Step 1",
              acceptanceCriteria: ["AC1"],
              risks: [],
              clarifications: [],
            },
            createdAtMs: 1700000000500,
          },
        },
      },
      revisions: {
        "plan:github:owner/repo#42": 1,
        "review:github:owner/repo#42:owner/repo:42": 1,
      },
      operationReceipts: {
        "op-plan-1": {
          schemaVersion: 1,
          operationKey: "op-plan-1",
          kind: "create-plan-task",
          sessionId,
          entityId: planId,
          createdAtMs: 1700000000000,
        },
        "op-rev-1": {
          schemaVersion: 1,
          operationKey: "op-rev-1",
          kind: "create-review-task",
          sessionId,
          target: reviewTarget,
          entityId: reviewId,
          createdAtMs: 1700000000600,
        },
        "op-rebind-1": {
          schemaVersion: 1,
          operationKey: "op-rebind-1",
          kind: "rebind-session",
          sessionId,
          bindingGeneration: 2,
          expectedGeneration: 1,
          adapter: "browser-agent",
          externalSessionRef: "chat-002",
          resumeUri: null,
          resultingSession: {
            schemaVersion: 1,
            id: sessionId,
            root: { provider: "github", key: "owner/repo#42" },
            status: "active",
            binding: {
              schemaVersion: 1,
              adapter: "browser-agent",
              externalSessionRef: "chat-002",
              resumeUri: null,
              generation: 2,
            },
            bindingGeneration: 2,
            createdAtMs: 1700000000000,
            updatedAtMs: 1700000001000,
          },
          entityId: sessionId,
          createdAtMs: 1700000001000,
        },
      },
    };
    expect(() => validateStoreRecord(record as unknown as DecisionStoreRecord)).not.toThrow();
  });

  it("fails closed on corrupted or stripped rebind operation receipt fields on restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-r3-rebind-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    try {
      await store.open();
      const service = new DecisionService(store, { clock: () => 1000 });
      const session = await service.createSession(githubDecisionRoot("owner", "repo", 95));
      await service.putBinding(session.id, {
        adapter: "browser",
        externalSessionRef: "one",
        resumeUri: null,
      });
      await service.rebindSession(session.id, {
        adapter: "browser",
        externalSessionRef: "two",
        resumeUri: null,
        expectedGeneration: 1,
        operationKey: "rebind",
      });
      await store.close();

      const filename = path.join(dir, "store.json");
      const originalRaw = JSON.parse(await fs.readFile(filename, "utf8"));

      for (const field of [
        "adapter",
        "externalSessionRef",
        "expectedGeneration",
        "bindingGeneration",
        "resultingSession",
      ]) {
        const corrupted = JSON.parse(JSON.stringify(originalRaw));
        delete corrupted.operationReceipts.rebind[field];
        await fs.writeFile(filename, JSON.stringify(corrupted));

        const reopenStore = new DurableDecisionStore({ storeDir: dir });
        await expect(reopenStore.open()).rejects.toThrow(CorruptedStoreError);
        await reopenStore.close();
      }
    } finally {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("prevents dual lock acquisition when three instances race on stale main and reclaim locks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-r3-lock-"));
    const main = path.join(dir, "store.lock");
    const reclaim = path.join(dir, "store.reclaim.lock");
    const a = new StoreLock(dir);
    const b = new StoreLock(dir);
    const c = new StoreLock(dir);
    try {
      const dead = JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAtMs: 1 });
      await fs.writeFile(main, dead);
      await fs.writeFile(reclaim, dead);

      const results = await Promise.allSettled([a.acquire(), b.acquire(), c.acquire()]);
      const acquiredCount =
        (a.isAcquired() ? 1 : 0) + (b.isAcquired() ? 1 : 0) + (c.isAcquired() ? 1 : 0);
      expect(acquiredCount).toBe(1);

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(2);
      for (const rej of rejected) {
        if (rej.status === "rejected") {
          expect(rej.reason).toBeInstanceOf(DecisionStoreLockError);
        }
      }
    } finally {
      await a.release().catch(() => {});
      await b.release().catch(() => {});
      await c.release().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("guarantees mutual exclusion with staggered three-instance concurrency on stale locks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review101-r3-staggered-"));
    const main = path.join(dir, "store.lock");
    const reclaim = path.join(dir, "store.reclaim.lock");
    const a = new StoreLock(dir);
    const b = new StoreLock(dir);
    const c = new StoreLock(dir);
    try {
      const dead = JSON.stringify({ pid: 999999, hostname: os.hostname(), acquiredAtMs: 1 });
      await fs.writeFile(main, dead);
      await fs.writeFile(reclaim, dead);

      // Start A, wait 5ms, start B, wait 15ms, start C
      const pa = a.acquire().then(() => "a", (e) => e);
      await new Promise((r) => setTimeout(r, 5));
      const pb = b.acquire().then(() => "b", (e) => e);
      await new Promise((r) => setTimeout(r, 15));
      const pc = c.acquire().then(() => "c", (e) => e);

      const results = await Promise.all([pa, pb, pc]);
      const acquiredList = [a, b, c].filter((lock) => lock.isAcquired());
      expect(acquiredList).toHaveLength(1);

      const successfulNames = results.filter((r) => r === "a" || r === "b" || r === "c");
      expect(successfulNames).toHaveLength(1);
    } finally {
      await a.release().catch(() => {});
      await b.release().catch(() => {});
      await c.release().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
