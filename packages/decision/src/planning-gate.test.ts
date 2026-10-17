import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decisionSessionId,
  type DecisionMaterializedContext,
  type DecisionPlanResult,
} from "@symphony/domain";
import { DurableDecisionStore } from "./store.js";
import { DecisionService } from "./service.js";
import { DecisionBridge } from "./bridge.js";
import { DecisionBridgeClient } from "./client.js";
import { DecisionPlanningGate } from "./planning-gate.js";

describe("DecisionPlanningGate", () => {
  let tmpDir: string;
  let store: DurableDecisionStore;
  let service: DecisionService;
  let gate: DecisionPlanningGate;
  const clockTime = 1_000_000;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planning-gate-test-"));
    store = new DurableDecisionStore({
      storeDir: tmpDir,
      clock: () => clockTime,
    });
    service = new DecisionService(store, {
      clock: () => clockTime,
    });
    await store.open();
    gate = new DecisionPlanningGate(service);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const sessionId = decisionSessionId({
    provider: "github",
    key: "felixjichao/symphony-ts#99",
  });

  const sampleContext: DecisionMaterializedContext = {
    strategy: "materialized",
    workItem: { provider: "github", key: "felixjichao/symphony-ts#99" },
    repository: "felixjichao/symphony-ts",
    issue: {
      repository: "felixjichao/symphony-ts",
      number: 99,
      title: "Add planning workflow",
      body: "Extend decision plane to pre-execution planning",
    },
    plan: null,
    pullRequest: null,
    diff: null,
    ci: null,
    repositoryInstructions: "AGENTS.md instructions",
    previousReviews: [],
    unresolvedFindings: [],
  };

  it("ensures session and emits plan task with atomic record", async () => {
    const task = await gate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Add planning workflow",
        body: "Extend decision plane to pre-execution planning",
      },
      context: sampleContext,
    });

    expect(task.kind).toBe("plan");
    expect(task.status).toBe("pending");
    expect(task.sessionId).toBe(sessionId);

    const latestPlan = await gate.getLatestPlan(sessionId);
    expect(latestPlan).toBeDefined();
    expect(latestPlan?.taskId).toBe(task.id);
    expect(latestPlan?.status).toBe("pending");
    expect(latestPlan?.triggerKind).toBe("initial");
    expect(latestPlan?.requirements.title).toBe("Add planning workflow");

    // Initially not eligible because task is not completed or published
    const eligibility = await gate.verifyPlanEligibility(sessionId, {
      title: "Add planning workflow",
      body: "Extend decision plane to pre-execution planning",
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("plan_status_pending");
  });

  it("supports full planning lifecycle: ready verdict -> published -> eligible for dispatch", async () => {
    const task = await gate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Add planning workflow",
        body: "Extend decision plane to pre-execution planning",
      },
      context: sampleContext,
    });

    // Claim and start
    const claim = await service.claimTask(task.id, { owner: "executor-1" });
    await service.startTask(task.id, {
      owner: "executor-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    const readyResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId: task.sessionId,
      revision: task.revision,
      createdAtMs: clockTime,
      kind: "plan",
      verdict: "ready",
      content: {
        plan: "Step 1: domain contracts. Step 2: service.",
        acceptanceCriteria: ["Tests pass"],
        risks: ["Concurrency"],
        clarifications: [],
      },
    };

    await service.submitResult(task.id, {
      owner: "executor-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: readyResult,
    });

    // Plan is completed but not yet published to GitHub
    const unpublishedEligibility = await gate.verifyPlanEligibility(sessionId, {
      title: "Add planning workflow",
      body: "Extend decision plane to pre-execution planning",
    });
    expect(unpublishedEligibility.eligible).toBe(false);
    expect(unpublishedEligibility.reason).toBe("plan_not_published_to_github");

    // Mark plan published to GitHub
    const publishedPlan = await gate.markPlanPublished(task.id, {
      commentId: 123456,
      publishedAtMs: clockTime + 500,
    });
    expect(publishedPlan.publishedCommentId).toBe(123456);

    // Now verification succeeds!
    const eligibleResult = await gate.verifyPlanEligibility(sessionId, {
      title: "Add planning workflow",
      body: "Extend decision plane to pre-execution planning",
    });
    expect(eligibleResult.eligible).toBe(true);
    expect(eligibleResult.verdict).toBe("ready");
    expect(eligibleResult.plan?.plan).toBe("Step 1: domain contracts. Step 2: service.");
    expect(eligibleResult.plan?.acceptanceCriteria).toEqual(["Tests pass"]);
  });

  it("fails closed on needs_clarification and allows clarifying in the same session", async () => {
    const task1 = await gate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Ambiguous task",
        body: "Do something somewhere",
      },
      context: sampleContext,
    });

    const claim1 = await service.claimTask(task1.id, { owner: "executor-1" });
    await service.startTask(task1.id, {
      owner: "executor-1",
      token: claim1.lease.token,
      generation: claim1.lease.generation,
    });

    const clarifyResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task1.id,
      sessionId: task1.sessionId,
      revision: task1.revision,
      createdAtMs: clockTime,
      kind: "plan",
      verdict: "needs_clarification",
      content: {
        plan: "Pending clarification before finalizing plan.",
        acceptanceCriteria: [],
        risks: [],
        clarifications: ["What repo?", "What framework?"],
      },
    };

    await service.submitResult(task1.id, {
      owner: "executor-1",
      token: claim1.lease.token,
      generation: claim1.lease.generation,
      result: clarifyResult,
    });

    // Verification must fail closed with verdict_needs_clarification
    const eligibility1 = await gate.verifyPlanEligibility(sessionId, {
      title: "Ambiguous task",
      body: "Do something somewhere",
    });
    expect(eligibility1.eligible).toBe(false);
    expect(eligibility1.reason).toBe("verdict_needs_clarification");

    // Clarification loop: create new plan task in the same session
    const task2 = await gate.ensurePlanTask(sessionId, {
      triggerKind: "clarification",
      previousTaskId: task1.id,
      requirements: {
        title: "Ambiguous task",
        body: "Do something somewhere",
        clarifications: ["Use symphony-ts repo", "Use TypeScript"],
      },
    });

    expect(task2.sessionId).toBe(sessionId);
    expect(task2.revision).toBe(2);

    const latestPlan2 = await gate.getLatestPlan(sessionId);
    expect(latestPlan2?.taskId).toBe(task2.id);
    expect(latestPlan2?.triggerKind).toBe("clarification");
    expect(latestPlan2?.previousTaskId).toBe(task1.id);
  });

  it("detects requirement changes and blocks dispatch", async () => {
    const task = await gate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Requirement V1",
        body: "Body V1",
      },
    });

    const claim = await service.claimTask(task.id, { owner: "executor-1" });
    await service.startTask(task.id, {
      owner: "executor-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    await service.submitResult(task.id, {
      owner: "executor-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: task.id,
        sessionId: task.sessionId,
        revision: task.revision,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: { plan: "Do V1", acceptanceCriteria: [], risks: [], clarifications: [] },
      },
    });
    await gate.markPlanPublished(task.id, { commentId: 101, publishedAtMs: clockTime });

    // Fingerprint matches -> eligible
    const check1 = await gate.verifyPlanEligibility(sessionId, {
      title: "Requirement V1",
      body: "Body V1",
    });
    expect(check1.eligible).toBe(true);

    // Requirement changed -> ineligible
    const check2 = await gate.verifyPlanEligibility(sessionId, {
      title: "Requirement V2",
      body: "Body V1 with changes",
    });
    expect(check2.eligible).toBe(false);
    expect(check2.reason).toBe("requirements_changed");
  });

  it("operates identically over DecisionBridge HTTP client", async () => {
    const bridge = new DecisionBridge(service, {
      host: "127.0.0.1",
      port: 0,
      authToken: "secret-token",
    });
    const addr = await bridge.start();

    try {
      const client = new DecisionBridgeClient(`http://${addr.host}:${addr.port}`, {
        authToken: "secret-token",
      });
      const httpGate = new DecisionPlanningGate(client);

      const task = await httpGate.ensurePlanTask(sessionId, {
        triggerKind: "initial",
        requirements: {
          title: "HTTP Test Issue",
          body: "HTTP Test Body",
        },
      });
      expect(task.kind).toBe("plan");

      const latestPlan = await httpGate.getLatestPlan(sessionId);
      expect(latestPlan?.taskId).toBe(task.id);

      const check1 = await httpGate.verifyPlanEligibility(sessionId, {
        title: "HTTP Test Issue",
        body: "HTTP Test Body",
      });
      expect(check1.eligible).toBe(false);
      expect(check1.reason).toBe("plan_status_pending");

      // Complete task
      const claim = await client.claimTask(task.id, { owner: "http-exec" });
      await client.startTask(task.id, {
        owner: "http-exec",
        token: claim.lease.token,
        generation: claim.lease.generation,
      });
      await client.submitResult(task.id, {
        owner: "http-exec",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: {
          schemaVersion: 1,
          taskId: task.id,
          sessionId: task.sessionId,
          revision: task.revision,
          createdAtMs: clockTime,
          kind: "plan",
          verdict: "ready",
          content: { plan: "Work plan", acceptanceCriteria: [], risks: [], clarifications: [] },
        },
      });

      // Mark published
      const pub = await httpGate.markPlanPublished(task.id, { commentId: 999, publishedAtMs: clockTime });
      expect(pub.publishedCommentId).toBe(999);

      const check2 = await httpGate.verifyPlanEligibility(sessionId, {
        title: "HTTP Test Issue",
        body: "HTTP Test Body",
      });
      expect(check2.eligible).toBe(true);
      expect(check2.plan?.plan).toBe("Work plan");
    } finally {
      await bridge.stop();
    }
  });

  it("sync bridge lookups observe planning state changes (no stale cache)", async () => {
    await service.createSession({ provider: "github", key: "felixjichao/symphony-ts#99" });
    // The default sync transport shells out to curl (bridge runs out-of-process).
    // Inject a transport backed by the live service so the no-cache behavior can
    // be asserted without blocking an in-process HTTP server.
    const client = new DecisionBridgeClient("http://127.0.0.1:0", {
      syncTransport: (_method, path, body) => {
        if (path === "/v1/plans/verify") {
          const payload = body as {
            sessionId: string;
            requirements?: { title: string; body: string; clarifications?: readonly string[] };
          };
          return { eligibility: service.verifyPlanEligibility(payload.sessionId, payload.requirements) };
        }
        const latest = /^\/v1\/plans\/(.+)\/latest$/.exec(path);
        if (latest) {
          return { plan: service.getLatestPlanForSession(decodeURIComponent(latest[1]!)) };
        }
        throw new Error(`unexpected sync path: ${path}`);
      },
    });

    const requirements = { title: "Sync Issue", body: "Sync Body" };

    // No plan yet: fail closed. This negative result must not be cached.
    expect(client.verifyPlanEligibilitySync(sessionId, requirements).eligible).toBe(false);
    expect(client.getLatestPlanSync(sessionId)).toBeNull();

    // Complete and publish revision 1.
    const task1 = await service.createPlanTask(sessionId, { requirements });
    const c1 = await service.claimTask(task1.id, { owner: "p", ttlMs: 60_000 });
    await service.startTask(task1.id, {
      owner: "p",
      token: c1.lease.token,
      generation: c1.lease.generation,
    });
    await service.submitResult(task1.id, {
      owner: "p",
      token: c1.lease.token,
      generation: c1.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: task1.id,
        sessionId,
        revision: task1.revision,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: { plan: "v1", acceptanceCriteria: [], risks: [], clarifications: [] },
      },
    });
    await service.markPlanPublished(task1.id, { commentId: 1 });

    // Positive result is observed immediately.
    expect(client.verifyPlanEligibilitySync(sessionId, requirements).eligible).toBe(true);
    expect(client.getLatestPlanSync(sessionId)?.revision).toBe(1);

    // A pending replan must invalidate the earlier positive authorization.
    const task2 = await service.createPlanTask(sessionId, {
      triggerKind: "requirements_changed",
      previousTaskId: task1.id,
      requirements: { title: "Sync Issue", body: "Sync Body v2" },
    });

    const afterReplan = client.verifyPlanEligibilitySync(sessionId, {
      title: "Sync Issue",
      body: "Sync Body v2",
    });
    expect(afterReplan.eligible).toBe(false);
    const latest2 = client.getLatestPlanSync(sessionId);
    expect(latest2?.revision).toBe(2);
    expect(latest2?.taskId).toBe(task2.id);
  });

  it("concurrent ensurePlanTask reuses active pending task atomically without bumping revision or superseding", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-concurrent-plan-"));
    const store = new DurableDecisionStore({ storeDir: path.join(dir, "decision") });
    await store.open();
    const service = new DecisionService(store);
    try {
      const session = await service.createSession({ provider: "github", key: "acme/repo#1" });
      const gate = new DecisionPlanningGate(service);
      const req = { title: "Title", body: "Description" };
      await Promise.all([
        gate.ensurePlanTask(session.id, { requirements: req }),
        gate.ensurePlanTask(session.id, { requirements: req }),
      ]);
      const tasks = service.getTasksForSession(session.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe("pending");
      expect(tasks[0]?.revision).toBe(1);
    } finally {
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
