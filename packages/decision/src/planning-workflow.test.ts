import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decisionSessionId,
  githubDecisionRoot,
  type DecisionMaterializedContext,
  type DecisionPlanResult,
  type DecisionReviewTarget,
} from "@symphony/domain";
import {
  DecisionPlanningGate,
  DecisionReviewGate,
  DecisionService,
  DurableDecisionStore,
} from "./index";

describe("Decision Planning Workflow — 6 Required Dogfood Paths", () => {
  let tmpDir: string;
  let store: DurableDecisionStore;
  let service: DecisionService;
  let planningGate: DecisionPlanningGate;
  let reviewGate: DecisionReviewGate;
  const clockTime = 1_000_000;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planning-workflow-test-"));
    store = new DurableDecisionStore({
      storeDir: tmpDir,
      clock: () => clockTime,
    });
    service = new DecisionService(store, {
      clock: () => clockTime,
    });
    await store.open();
    planningGate = new DecisionPlanningGate(service);
    reviewGate = new DecisionReviewGate(service);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const repo = "felixjichao/symphony-ts";
  const issueNumber = 99;
  const sessionId = decisionSessionId(githubDecisionRoot("felixjichao", "symphony-ts", issueNumber));

  const sampleContext: DecisionMaterializedContext = {
    strategy: "materialized",
    workItem: { provider: "github", key: `${repo}#${issueNumber}` },
    repository: repo,
    issue: {
      repository: repo,
      number: issueNumber,
      title: "Add planning workflow to Decision Plane",
      body: "Extend decision plane to support pre-execution planning with durable GitHub sync",
    },
    plan: null,
    pullRequest: null,
    diff: null,
    ci: null,
    repositoryInstructions: "AGENTS.md instructions",
    previousReviews: [],
    unresolvedFindings: [],
  };

  it("Path 1: Issue -> PlanTask -> ready -> durable plan -> eligible for dispatch", async () => {
    // 1. Issue dispatched to planning gate
    const task = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Add planning workflow to Decision Plane",
        body: "Extend decision plane to support pre-execution planning with durable GitHub sync",
      },
      context: sampleContext,
    });

    expect(task.kind).toBe("plan");
    expect(task.status).toBe("pending");

    // 2. Executor claims and executes plan task
    const claim = await service.claimTask(task.id, { owner: "chatgpt-planner" });
    await service.startTask(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    const readyResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId,
      revision: task.revision,
      createdAtMs: clockTime,
      kind: "plan",
      verdict: "ready",
      content: {
        plan: "1. Define domain contracts\n2. Implement durable store\n3. Wire authority gate",
        acceptanceCriteria: ["All dogfood tests pass", "Zero typecheck errors"],
        risks: ["Stale plan fingerprints"],
        clarifications: [],
      },
    };

    await service.submitResult(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: readyResult,
    });

    // 3. Before GitHub writeback, dispatch is blocked (fails closed)
    const beforeSync = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Add planning workflow to Decision Plane",
      body: "Extend decision plane to support pre-execution planning with durable GitHub sync",
    });
    expect(beforeSync.eligible).toBe(false);
    expect(beforeSync.reason).toBe("plan_not_published_to_github");

    // 4. Plan is durably written back to GitHub
    await planningGate.markPlanPublished(task.id, { commentId: 888777, publishedAtMs: clockTime + 200 });

    // 5. Execution dispatch is now unblocked
    const afterSync = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Add planning workflow to Decision Plane",
      body: "Extend decision plane to support pre-execution planning with durable GitHub sync",
    });
    expect(afterSync.eligible).toBe(true);
    expect(afterSync.verdict).toBe("ready");
    expect(afterSync.publishedCommentId).toBe(888777);
    expect(afterSync.plan?.plan).toContain("1. Define domain contracts");
  });

  it("Path 2: needs_clarification -> no dispatch -> clarification -> new PlanTask in same session", async () => {
    // 1. Initial plan task
    const task1 = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Feature with vague requirements",
        body: "Make the system faster",
      },
    });

    const claim1 = await service.claimTask(task1.id, { owner: "chatgpt-planner" });
    await service.startTask(task1.id, {
      owner: "chatgpt-planner",
      token: claim1.lease.token,
      generation: claim1.lease.generation,
    });

    // Planner asks clarifying questions
    const clarifyResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task1.id,
      sessionId,
      revision: task1.revision,
      createdAtMs: clockTime,
      kind: "plan",
      verdict: "needs_clarification",
      content: {
        plan: "Pending clarifications on performance metrics.",
        acceptanceCriteria: [],
        risks: [],
        clarifications: ["Which component needs speedup?", "What is the target latency?"],
      },
    };

    await service.submitResult(task1.id, {
      owner: "chatgpt-planner",
      token: claim1.lease.token,
      generation: claim1.lease.generation,
      result: clarifyResult,
    });

    // Dispatch must fail closed
    const check1 = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Feature with vague requirements",
      body: "Make the system faster",
    });
    expect(check1.eligible).toBe(false);
    expect(check1.reason).toBe("verdict_needs_clarification");

    // 2. User/Agent answers clarification in the same session
    const task2 = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "clarification",
      previousTaskId: task1.id,
      requirements: {
        title: "Feature with vague requirements",
        body: "Make the system faster",
        clarifications: ["Decision store write path", "Under 5ms latency"],
      },
    });

    expect(task2.sessionId).toBe(sessionId);
    expect(task2.revision).toBe(2);

    // Verify task1 is superseded
    const storedTask1 = service.getTask(task1.id);
    expect(storedTask1?.status).toBe("superseded");
  });

  it("Path 3: needs_human -> handoff, no dispatch", async () => {
    const task = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Conflicting architectural choice",
        body: "Drop SQLite or drop in-memory?",
      },
    });

    const claim = await service.claimTask(task.id, { owner: "chatgpt-planner" });
    await service.startTask(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    const humanResult: DecisionPlanResult = {
      schemaVersion: 1,
      taskId: task.id,
      sessionId,
      revision: task.revision,
      createdAtMs: clockTime,
      kind: "plan",
      verdict: "needs_human",
      content: {
        plan: "Architectural decision required by maintainer before planning.",
        acceptanceCriteria: [],
        risks: ["Irreversible schema change"],
        clarifications: [],
      },
    };

    await service.submitResult(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: humanResult,
    });

    const eligibility = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Conflicting architectural choice",
      body: "Drop SQLite or drop in-memory?",
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("verdict_needs_human");
  });

  it("Path 4: ChatGPT Web plan -> later ReviewTask resumes same binding", async () => {
    // 1. Establish session and bind to ChatGPT Web conversation
    const task = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Feature with full review cycle",
        body: "Feature details",
      },
    });

    const claim = await service.claimTask(task.id, { owner: "chatgpt-planner" });
    await service.startTask(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    // Executor binds external ChatGPT conversation
    await service.putBinding(sessionId, {
      adapter: "chatgpt-web",
      externalSessionRef: "chatgpt-conv-99001",
      resumeUri: "https://chatgpt.com/c/99001",
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });

    // Complete plan
    await service.submitResult(task.id, {
      owner: "chatgpt-planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: task.id,
        sessionId,
        revision: task.revision,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: {
          plan: "Plan for feature",
          acceptanceCriteria: ["AC1"],
          risks: [],
          clarifications: [],
        },
      },
    });
    await planningGate.markPlanPublished(task.id, { commentId: 10101 });

    // Verify session has binding preserved
    const session = service.getSession(sessionId);
    expect(session?.binding?.externalSessionRef).toBe("chatgpt-conv-99001");
    expect(session?.binding?.adapter).toBe("chatgpt-web");

    // 2. Later PR is created, ReviewTask is created for same session
    const target: DecisionReviewTarget = {
      repository: repo,
      prNumber: 99,
      headSha: "b".repeat(40),
    };
    const reviewTask = await reviewGate.ensureReviewTask(sessionId, target);

    expect(reviewTask.kind).toBe("review");
    expect(reviewTask.sessionId).toBe(sessionId);

    // The session still holds the ChatGPT conversation binding!
    const sessionAfterReview = service.getSession(sessionId);
    expect(sessionAfterReview?.binding?.externalSessionRef).toBe("chatgpt-conv-99001");
    expect(sessionAfterReview?.bindingGeneration).toBe(1);
  });

  it("Path 5: Conversation binding lost -> rollover reconstructs context from durable plan/GitHub facts", async () => {
    // 1. Setup session with plan and active binding
    const task = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Rollover Feature",
        body: "Rollover Body",
      },
    });
    const claim = await service.claimTask(task.id, { owner: "exec-1" });
    await service.startTask(task.id, {
      owner: "exec-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });
    await service.putBinding(sessionId, {
      adapter: "chatgpt-web",
      externalSessionRef: "chatgpt-old-conv",
      resumeUri: "https://chatgpt.com/c/old",
      owner: "exec-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });
    await service.submitResult(task.id, {
      owner: "exec-1",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: task.id,
        sessionId,
        revision: 1,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: { plan: "Durable plan data", acceptanceCriteria: ["AC"], risks: [], clarifications: [] },
      },
    });
    await planningGate.markPlanPublished(task.id, { commentId: 555 });

    // 2. Simulate conversation lost / broken binding (e.g. browser tab closed or 404)
    await service.breakBinding(sessionId);
    const session = service.getSession(sessionId);
    expect(session?.status).toBe("broken-binding");

    // 3. Next task rollover rebinds with new conversation, pulling context from durable plan
    const latestPlan = await planningGate.getLatestPlan(sessionId);
    expect(latestPlan).toBeDefined();
    expect(latestPlan?.result?.content.plan).toBe("Durable plan data");

    const rebindSession = await service.rebindSession(sessionId, {
      adapter: "chatgpt-web",
      externalSessionRef: "chatgpt-new-conv",
      resumeUri: "https://chatgpt.com/c/new",
      expectedGeneration: session!.bindingGeneration,
    });

    expect(rebindSession.status).toBe("active");
    expect(rebindSession.binding?.externalSessionRef).toBe("chatgpt-new-conv");
    expect(rebindSession.bindingGeneration).toBe(2);
  });

  it("Path 6: Requirements change -> new plan revision becomes current, review receives current plan", async () => {
    // 1. Initial plan V1
    const task1 = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "initial",
      requirements: {
        title: "Requirement V1",
        body: "Scope V1",
      },
    });
    const claim1 = await service.claimTask(task1.id, { owner: "planner" });
    await service.startTask(task1.id, { owner: "planner", token: claim1.lease.token, generation: 1 });
    await service.submitResult(task1.id, {
      owner: "planner",
      token: claim1.lease.token,
      generation: 1,
      result: {
        schemaVersion: 1,
        taskId: task1.id,
        sessionId,
        revision: 1,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: { plan: "Plan V1", acceptanceCriteria: ["AC1"], risks: [], clarifications: [] },
      },
    });
    await planningGate.markPlanPublished(task1.id, { commentId: 101 });

    // 2. Initial review task created with Plan V1
    const target: DecisionReviewTarget = {
      repository: repo,
      prNumber: 99,
      headSha: "c".repeat(40),
    };
    const samplePullRequest = {
      repository: repo,
      prNumber: 99,
      headSha: "c".repeat(40),
      baseRef: "main",
      headRef: "feat",
      title: "PR Title",
      body: "PR Body",
    };
    const reviewTask1 = await reviewGate.ensureReviewTask(sessionId, target, {
      ...sampleContext,
      pullRequest: samplePullRequest,
      plan: {
        taskId: task1.id,
        revision: 1,
        plan: "Plan V1",
        acceptanceCriteria: ["AC1"],
        risks: [],
        clarifications: [],
      },
    });
    expect(reviewTask1.revision).toBe(1);

    // 3. Requirements change in issue! Scope expands to V2
    const checkBeforeReplan = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Requirement V2",
      body: "Scope V2 with extra features",
    });
    expect(checkBeforeReplan.eligible).toBe(false);
    expect(checkBeforeReplan.reason).toBe("requirements_changed");

    // 4. New PlanTask revision 2 created
    const task2 = await planningGate.ensurePlanTask(sessionId, {
      triggerKind: "requirements_changed",
      previousTaskId: task1.id,
      requirements: {
        title: "Requirement V2",
        body: "Scope V2 with extra features",
      },
    });
    expect(task2.revision).toBe(2);

    const claim2 = await service.claimTask(task2.id, { owner: "planner" });
    await service.startTask(task2.id, { owner: "planner", token: claim2.lease.token, generation: 1 });
    await service.submitResult(task2.id, {
      owner: "planner",
      token: claim2.lease.token,
      generation: 1,
      result: {
        schemaVersion: 1,
        taskId: task2.id,
        sessionId,
        revision: 2,
        createdAtMs: clockTime,
        kind: "plan",
        verdict: "ready",
        content: { plan: "Plan V2 with extra features", acceptanceCriteria: ["AC1", "AC2"], risks: [], clarifications: [] },
      },
    });
    await planningGate.markPlanPublished(task2.id, { commentId: 102 });

    // 5. Verification succeeds with new plan
    const checkAfterReplan = await planningGate.verifyPlanEligibility(sessionId, {
      title: "Requirement V2",
      body: "Scope V2 with extra features",
    });
    expect(checkAfterReplan.eligible).toBe(true);
    expect(checkAfterReplan.plan?.revision).toBe(2);

    // 6. Creating ReviewTask with updated plan detects changed plan and creates new review revision
    const reviewTask2 = await reviewGate.ensureReviewTask(sessionId, target, {
      ...sampleContext,
      pullRequest: samplePullRequest,
      plan: checkAfterReplan.plan!,
    });
    expect(reviewTask2.revision).toBe(2);

    const context2 = service.getTaskContext(reviewTask2.id);
    expect(context2?.strategy).toBe("materialized");
    if (context2?.strategy === "materialized") {
      expect(context2.plan?.revision).toBe(2);
      expect(context2.plan?.plan).toBe("Plan V2 with extra features");
    }
  });
});
