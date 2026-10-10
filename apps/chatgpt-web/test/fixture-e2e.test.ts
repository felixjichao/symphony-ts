import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DurableDecisionStore,
  DecisionService,
  DecisionBridge,
} from "@symphony/decision";
import {
  githubDecisionRoot,
  type DecisionContextBundle,
} from "@symphony/domain/decision";
import { FetchBridgeTransport } from "../src/transport";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { ChatGptWebAdapter } from "../src/adapter";
import { DecisionTabDriver } from "../src/driver";
import { MockDocument, MockElement, MockWindow } from "./mock-dom";

describe("Decision Multi-Turn Fixture and Rollover (E2E)", () => {
  let tempDir: string;
  let store: DurableDecisionStore;
  let service: DecisionService;
  let bridge: DecisionBridge;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "symphony-decision-e2e-"));
    store = new DurableDecisionStore({ storeDir: tempDir });
    await store.open();
    service = new DecisionService(store);
    bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();
    baseUrl = `http://127.0.0.1:${bridge.getPort()}`;
  });

  afterEach(async () => {
    await bridge.stop();
    await store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("verifies Plan -> Review SHA-A -> Review SHA-B on single binding, followed by broken-binding rollover N -> N+1", async () => {
    const transport = new FetchBridgeTransport({ baseUrl });
    const cpStore = new MemoryCheckpointStore();

    const doc = new MockDocument();
    const win = new MockWindow();
    win.location.href = "https://chatgpt.com";

    // Setup DOM elements for ChatGPT Web
    const composer = new MockElement("textarea", { id: "prompt-textarea" });
    const sendBtn = new MockElement("button", { "data-testid": "send-button" });
    doc.body.appendChild(composer);
    doc.body.appendChild(sendBtn);

    let nextAssistantResponseJson: unknown = null;
    let nextNavigationUrlOnSend: string | null = null;
    let lastSentPrompt = "";

    sendBtn.addEventListener("click", () => {
      lastSentPrompt = composer.value;
      if (nextNavigationUrlOnSend) {
        win.location.href = nextNavigationUrlOnSend;
      }
      if (nextAssistantResponseJson) {
        const turn = new MockElement("article", { "data-testid": `turn-${Date.now()}` });
        const msg = new MockElement("div", { "data-message-author-role": "assistant" });
        msg.textContent = `Response:\n\`\`\`symphony-result\n${JSON.stringify(nextAssistantResponseJson, null, 2)}\n\`\`\``;
        turn.appendChild(msg);
        doc.body.appendChild(turn);
      }
    });

    const adapter = new ChatGptWebAdapter({
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      checkIntervalMs: 10,
      stabilizationMs: 20,
    });

    const driver = new DecisionTabDriver({
      transport,
      checkpointStore: cpStore,
      adapter,
      ownerId: "driver-fixture",
    });

    // -------------------------------------------------------------
    // Turn 1: Plan Task on fresh session
    // -------------------------------------------------------------
    const root = githubDecisionRoot("owner", "repo", 1);
    const session = await service.createSession(root);
    const sessionId = session.id;

    const planTask = await service.createPlanTask(sessionId);
    const planTaskId = planTask.id;

    const planContext: DecisionContextBundle = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Build web decision executor",
        body: "Detailed requirements for ChatGPT Web driver",
      },
      plan: null,
      pullRequest: null,
      diff: null,
      ci: null,
      repositoryInstructions: "Always write robust tests",
      previousReviews: [],
      unresolvedFindings: [],
    };
    await service.putTaskContext(planTaskId, planContext);

    // Prepare assistant simulated response
    nextNavigationUrlOnSend = "https://chatgpt.com/c/conv-uuid-1111";
    nextAssistantResponseJson = {
      schemaVersion: 1,
      taskId: planTaskId,
      sessionId,
      kind: "plan",
      revision: 1,
      verdict: "ready",
      content: {
        plan: "Step 1: Add adapter\nStep 2: Add driver\nStep 3: Verify gate",
        acceptanceCriteria: ["All vitest suites pass"],
        risks: ["DOM changes in ChatGPT Web"],
        clarifications: [],
      },
      createdAtMs: Date.now(),
    };

    const outcomePlan = await driver.runOnce();
    expect(outcomePlan).not.toBeNull();
    expect(outcomePlan?.status).toBe("completed");
    if (outcomePlan?.status === "completed") {
      expect(outcomePlan.result.verdict).toBe("ready");
    }

    // Verify session bound to conv-uuid-1111 at generation 1
    const sessionAfterPlan = await service.getSession(sessionId);
    expect(sessionAfterPlan?.binding).not.toBeNull();
    expect(sessionAfterPlan?.binding?.externalSessionRef).toBe("conv-uuid-1111");
    expect(sessionAfterPlan?.binding?.generation).toBe(1);
    expect(sessionAfterPlan?.bindingGeneration).toBe(1);

    // -------------------------------------------------------------
    // Turn 2: Review SHA-A on SAME binding (conv-uuid-1111)
    // -------------------------------------------------------------
    const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reviewTaskA = await service.createReviewTask(sessionId, {
      target: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaA,
      },
    });
    const reviewTaskAId = reviewTaskA.id;

    const reviewAContext: DecisionContextBundle = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Build web decision executor",
        body: "Detailed requirements",
      },
      plan: {
        taskId: planTaskId,
        revision: 1,
        plan: "Step 1: Add adapter\nStep 2: Add driver\nStep 3: Verify gate",
        acceptanceCriteria: ["All vitest suites pass"],
        risks: [],
        clarifications: [],
      },
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaA,
        baseRef: "main",
        headRef: "feat/chatgpt-web",
        title: "Initial implementation",
        body: "Implements driver",
      },
      diff: {
        patch: "+ const leak = new Map(); // unbounded growth",
        files: ["src/driver.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "CI checks passed",
        checks: [{ name: "gate", status: "completed", conclusion: "success", url: null }],
      },
      repositoryInstructions: null,
      previousReviews: [],
      unresolvedFindings: [],
    };
    await service.putTaskContext(reviewTaskAId, reviewAContext);

    // Simulated review result: changes_requested with blocker finding
    nextNavigationUrlOnSend = null; // Stays on same conversation
    nextAssistantResponseJson = {
      schemaVersion: 1,
      taskId: reviewTaskAId,
      sessionId,
      kind: "review",
      revision: reviewTaskA.revision,
      target: { repository: "owner/repo", prNumber: 42, headSha: shaA },
      verdict: "changes_requested",
      findings: [
        {
          severity: "blocker",
          message: "Potential memory leak in driver Map",
          location: "src/driver.ts:1",
        },
      ],
      createdAtMs: Date.now(),
    };

    const outcomeReviewA = await driver.runOnce();
    expect(outcomeReviewA).not.toBeNull();
    expect(outcomeReviewA?.status).toBe("completed");
    if (outcomeReviewA?.status === "completed") {
      expect(outcomeReviewA.result.verdict).toBe("changes_requested");
      if (outcomeReviewA.result.kind === "review") {
        expect(outcomeReviewA.result.findings).toHaveLength(1);
      }
    }

    // Verify continuation prompt was used on same conversation
    expect(lastSentPrompt).toContain("[Symphony Continuation");
    expect(lastSentPrompt).toContain(shaA);

    // Session binding remains generation 1 on conv-uuid-1111
    const sessionAfterReviewA = await service.getSession(sessionId);
    expect(sessionAfterReviewA?.binding?.externalSessionRef).toBe("conv-uuid-1111");
    expect(sessionAfterReviewA?.binding?.generation).toBe(1);

    // -------------------------------------------------------------
    // Turn 3: Review SHA-B on SAME binding (conv-uuid-1111)
    // -------------------------------------------------------------
    const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const reviewTaskB = await service.createReviewTask(sessionId, {
      target: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaB,
      },
    });
    const reviewTaskBId = reviewTaskB.id;

    const reviewAResult = outcomeReviewA?.status === "completed" && outcomeReviewA.result.kind === "review" ? outcomeReviewA.result : null;

    const reviewBContext: DecisionContextBundle = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: reviewAContext.issue,
      plan: reviewAContext.plan,
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaB,
        baseRef: "main",
        headRef: "feat/chatgpt-web",
        title: "Initial implementation (revised)",
        body: "Fixed memory leak",
      },
      diff: {
        patch: "- const leak = new Map();\n+ const cache = new WeakMap();",
        files: ["src/driver.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "CI checks passed",
        checks: [{ name: "gate", status: "completed", conclusion: "success", url: null }],
      },
      repositoryInstructions: null,
      previousReviews: reviewAResult ? [reviewAResult] : [],
      unresolvedFindings: [
        {
          severity: "blocker",
          message: "Potential memory leak in driver Map",
          location: "src/driver.ts:1",
        },
      ],
    };
    await service.putTaskContext(reviewTaskBId, reviewBContext);

    // Simulated review result: approve
    nextNavigationUrlOnSend = null;
    nextAssistantResponseJson = {
      schemaVersion: 1,
      taskId: reviewTaskBId,
      sessionId,
      kind: "review",
      revision: reviewTaskB.revision,
      target: { repository: "owner/repo", prNumber: 42, headSha: shaB },
      verdict: "approve",
      findings: [],
      createdAtMs: Date.now(),
    };

    const outcomeReviewB = await driver.runOnce();
    expect(outcomeReviewB).not.toBeNull();
    expect(outcomeReviewB?.status).toBe("completed");
    if (outcomeReviewB?.status === "completed") {
      expect(outcomeReviewB.result.verdict).toBe("approve");
    }

    // Verify prompt specifically enforced re-checking against previous reviewed SHA-A
    expect(lastSentPrompt).toContain("[Symphony Continuation");
    expect(lastSentPrompt).toContain(`Previous reviewed HEAD was: ${shaA}`);
    expect(lastSentPrompt).toContain(`current HEAD: ${shaB}`);

    // Session binding is still generation 1
    const sessionAfterReviewB = await service.getSession(sessionId);
    expect(sessionAfterReviewB?.binding?.externalSessionRef).toBe("conv-uuid-1111");
    expect(sessionAfterReviewB?.binding?.generation).toBe(1);

    // Create a new task on the session: Review SHA-C
    const shaC = "cccccccccccccccccccccccccccccccccccccccc";
    const reviewTaskC = await service.createReviewTask(sessionId, {
      target: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaC,
      },
    });
    const reviewTaskCId = reviewTaskC.id;

    const reviewBResult = outcomeReviewB?.status === "completed" && outcomeReviewB.result.kind === "review" ? outcomeReviewB.result : null;
    const priorReviews = [reviewAResult, reviewBResult].filter((r): r is NonNullable<typeof r> => r !== null);

    const reviewCContext: DecisionContextBundle = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: reviewAContext.issue,
      plan: reviewAContext.plan,
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: shaC,
        baseRef: "main",
        headRef: "feat/chatgpt-web",
        title: "Cleaned up",
        body: "All issues fixed",
      },
      diff: {
        patch: "+ // final cleanups",
        files: ["src/driver.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "CI checks passed",
        checks: [],
      },
      repositoryInstructions: null,
      previousReviews: priorReviews,
      unresolvedFindings: [],
    };
    await service.putTaskContext(reviewTaskCId, reviewCContext);

    // Simulate external session conv-uuid-1111 breaking / purging
    await service.breakBinding(sessionId);
    const sessionBroken = await service.getSession(sessionId);
    expect(sessionBroken?.status).toBe("broken-binding");
    expect(sessionBroken?.binding).toBeNull();
    expect(sessionBroken?.bindingGeneration).toBe(1);

    // Rebind will create a new conversation conv-uuid-2222
    nextNavigationUrlOnSend = "https://chatgpt.com/c/conv-uuid-2222";
    nextAssistantResponseJson = {
      schemaVersion: 1,
      taskId: reviewTaskCId,
      sessionId,
      kind: "review",
      revision: reviewTaskC.revision,
      target: { repository: "owner/repo", prNumber: 42, headSha: shaC },
      verdict: "approve",
      findings: [],
      createdAtMs: Date.now(),
    };

    const outcomeReviewC = await driver.runOnce();
    expect(outcomeReviewC).not.toBeNull();
    expect(outcomeReviewC?.status).toBe("completed");
    if (outcomeReviewC?.status === "completed") {
      expect(outcomeReviewC.result.verdict).toBe("approve");
    }

    // Verify session advanced from generation 1 to generation 2!
    const sessionAfterRollover = await service.getSession(sessionId);
    expect(sessionAfterRollover?.status).toBe("active");
    expect(sessionAfterRollover?.binding?.externalSessionRef).toBe("conv-uuid-2222");
    expect(sessionAfterRollover?.binding?.generation).toBe(2);
    expect(sessionAfterRollover?.bindingGeneration).toBe(2);

    // -------------------------------------------------------------
    // Session Execution Mutual Exclusion Validation
    // -------------------------------------------------------------
    const taskX = await service.createPlanTask(sessionId);
    const claimX = await service.claimTask(taskX.id, { owner: "owner-1", ttlMs: 60_000 });
    expect(claimX.task.status).toBe("claimed");

    const taskY = await service.createReviewTask(sessionId, {
      target: {
        repository: "owner/repo",
        prNumber: 99,
        headSha: shaA,
      },
    });

    // Attempting to claim task Y while task X is active on same session MUST fail with 409 Conflict
    await expect(
      service.claimTask(taskY.id, { owner: "owner-2", ttlMs: 60_000 })
    ).rejects.toThrow("already has an actively executing task");
  });

  it("recovers from navigating checkpoint across tab destruction and new tab reconstitution with real bridge (E2E)", async () => {
    const transport = new FetchBridgeTransport({ baseUrl });
    const cpStore = new MemoryCheckpointStore({ tabId: "shared-tab-store" });

    // 1. Setup session and plan task on Bridge
    const root = githubDecisionRoot("owner", "repo", 2);
    const session = await service.createSession(root);
    const sessionId = session.id;

    // Put existing binding to an external conversation
    const newConvId = "conv-new-2222";
    const targetUri = `https://chatgpt.com/c/${newConvId}`;
    await service.putBinding(sessionId, {
      adapter: "chatgpt-web",
      externalSessionRef: newConvId,
      resumeUri: targetUri,
    });

    const task = await service.createPlanTask(sessionId);
    const context: DecisionContextBundle = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: null,
      headSha: null,
    };
    await service.putTaskContext(task.id, context);

    const { lease } = await service.claimTask(task.id, { owner: "driver-nav", ttlMs: 60_000 });
    await service.startTask(task.id, { owner: lease.owner, token: lease.token, generation: lease.generation });

    // 2. Tab 1: Simulating tab that initiated navigation and was destroyed
    // Checkpoint was saved as "navigating" targeting targetUri and newConvId
    cpStore.set({
      schemaVersion: 1,
      tabId: "shared-tab-store",
      taskId: task.id,
      sessionId,
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseGeneration: lease.generation,
      leaseExpiresAtMs: lease.expiresAtMs,
      bindingGeneration: 1,
      step: "navigating",
      attemptId: `${task.id}-1`,
      savedAtMs: Date.now(),
      targetUri,
      targetConvId: newConvId,
    });

    // Old Tab 1 is now destroyed: tab 1's window, document, and driver are discarded.

    // 3. Tab 2: Brand new window and document simulating newly opened/reconstituted tab
    const win2 = new MockWindow();
    win2.location.href = "https://chatgpt.com/"; // Tab 2 starts at root before navigating to target conversation
    const doc2 = new MockDocument();

    const expectedResult = {
      schemaVersion: 1 as const,
      taskId: task.id,
      sessionId,
      kind: "plan" as const,
      revision: task.revision,
      verdict: "ready" as const,
      content: { plan: "Reconstituted Plan", acceptanceCriteria: ["AC1"], risks: [], clarifications: [] },
      createdAtMs: Date.now(),
    };

    // When win2.location.assign is called, location updates to targetUri and composer appears in doc2
    const composer2 = new MockElement("textarea", { id: "prompt-textarea" });
    const sendBtn2 = new MockElement("button", { "data-testid": "send-button" });
    sendBtn2.addEventListener("click", () => {
      const turn = new MockElement("article", { "data-testid": `turn-${Date.now()}` });
      const msg = new MockElement("div", { "data-message-author-role": "assistant" });
      msg.textContent = `Response:\n\`\`\`symphony-result\n${JSON.stringify(expectedResult, null, 2)}\n\`\`\``;
      turn.appendChild(msg);
      doc2.body.appendChild(turn);
    });

    vi.spyOn(win2.location, "assign").mockImplementation((url: string) => {
      win2.location.href = url;
      // Page finishes loading: composer and send button mounted in doc2
      doc2.body.appendChild(composer2);
      doc2.body.appendChild(sendBtn2);
    });

    const adapter2 = new ChatGptWebAdapter({
      doc: doc2 as unknown as Document,
      win: win2 as unknown as Window,
      checkIntervalMs: 10,
      stabilizationMs: 20,
    });

    const driver2 = new DecisionTabDriver({
      transport,
      checkpointStore: cpStore,
      adapter: adapter2,
      ownerId: "driver-nav",
    });

    // Tab 2 recovers from navigating checkpoint
    const outcome = await driver2.resumeCheckpointIfAvailable();
    expect(outcome?.status).toBe("completed");
    if (outcome?.status === "completed") {
      expect(outcome.result.verdict).toBe("ready");
    }

    // Verify task on real bridge is now completed!
    const bridgeTask = service.getTask(task.id);
    expect(bridgeTask?.status).toBe("completed");
    const receipt = service.getReceipt(task.id);
    expect(receipt?.type).toBe("result");

    // Checkpoint in store cleared upon successful completion!
    expect(cpStore.get()).toBeNull();
  });
});
