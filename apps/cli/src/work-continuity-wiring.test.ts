import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  decisionSessionId,
  githubDecisionRoot,
  type DecisionObservation,
  type Issue,
  type PersistedDeliveryState,
  type TimerHandle,
} from "@symphony/domain";
import {
  DecisionService,
  DurableDecisionStore,
} from "@symphony/decision";
import type { PollScheduler } from "@symphony/orchestrator";
import type { TrackerAdapterProfile } from "@symphony/tracker";

import { createHost } from "./host";
import {
  HostWorkObservationSource,
  TrackerWorkIndex,
  createWorkspaceDeliveryCompensationPort,
  issueWorkKey,
  type RuntimeWorkView,
} from "./work-continuity-wiring";

const workKey = githubDecisionRoot("owner", "repo", 7);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-GH-7",
    nativeRef: { repo: "owner/repo", number: 7 },
    identifier: "GH-7",
    title: "GH-7",
    description: null,
    priority: 1,
    state: "open",
    branchName: null,
    url: "https://example.com/GH-7",
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
    ...overrides,
  };
}

function runtimeView(overrides: Partial<RuntimeWorkView> = {}): RuntimeWorkView {
  return {
    running: () => null,
    retry: () => null,
    ...overrides,
  };
}

function decisionObservation(
  overrides: Partial<DecisionObservation> & Pick<DecisionObservation, "tasks">,
): DecisionObservation {
  return {
    workKey,
    session: {
      sessionId: decisionSessionId(workKey),
      status: "active",
      bindingGeneration: 1,
      adapter: "chatgpt-web",
      updatedAtMs: 1_000,
    },
    results: [],
    ...overrides,
  };
}

describe("TrackerWorkIndex", () => {
  it("scans active work and re-reads one issue through the tracker", async () => {
    const calls: string[] = [];
    const index = new TrackerWorkIndex(
      {
        fetchIssuesByStates: async (states) => {
          calls.push(`states:${states.join(",")}`);
          return [makeIssue()];
        },
        fetchIssuesByIds: async (ids) => {
          calls.push(`ids:${ids.join(",")}`);
          return [makeIssue({ state: "open" })];
        },
      },
      () => ["open"],
      (issue) => issueWorkKey(issue, "owner/repo"),
    );

    const keys = await index.listWorkKeys();
    expect(keys).toEqual([workKey]);
    expect(calls).toEqual(["states:open"]);

    const issue = await index.readIssue(workKey);
    expect(issue?.id).toBe("id-GH-7");
    expect(calls).toEqual(["states:open", "ids:id-GH-7"]);
  });

  it("skips issues whose work key cannot be resolved", async () => {
    const index = new TrackerWorkIndex(
      { fetchIssuesByStates: async () => [makeIssue({ nativeRef: null, url: null })] },
      () => ["open"],
      () => null,
    );
    expect(await index.listWorkKeys()).toEqual([]);
  });
});

describe("HostWorkObservationSource", () => {
  function source(options: {
    decision?: DecisionObservation | null;
    delivery?: PersistedDeliveryState | null;
    runtime?: RuntimeWorkView;
    deliveryThrows?: boolean;
    now?: number;
    stallTimeoutMs?: number;
  }): HostWorkObservationSource {
    const index = new TrackerWorkIndex(
      {
        fetchIssuesByStates: async () => [makeIssue()],
        fetchIssuesByIds: async () => [makeIssue()],
      },
      () => ["open"],
      (issue) => issueWorkKey(issue, "owner/repo"),
    );
    return new HostWorkObservationSource({
      index,
      runtime: options.runtime ?? runtimeView(),
      decision:
        options.decision === undefined || options.decision === null
          ? null
          : { read: async () => options.decision ?? null },
      delivery:
        options.delivery === undefined && options.deliveryThrows !== true
          ? null
          : {
              read: async () => {
                if (options.deliveryThrows === true) {
                  throw new Error("delivery state unreadable");
                }
                return options.delivery ?? null;
              },
            },
      now: () => options.now ?? 1_770_000_000_000,
      stallTimeoutMs: () => options.stallTimeoutMs ?? 0,
    });
  }

  async function observe(observer: HostWorkObservationSource) {
    const observation = await observer.observe(workKey);
    const { deriveWorkContinuity } = await import("@symphony/domain");
    return { observation, verdict: deriveWorkContinuity(observation) };
  }

  it("treats a Decision task with an expired lease as stranded and reclaimable", async () => {
    const { observation, verdict } = await observe(
      source({
        decision: decisionObservation({
          tasks: [
            {
              kind: "plan",
              taskId: "task-1",
              revision: 3,
              status: "claimed",
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              claimGeneration: 2,
              lease: { owner: "chatgpt-web", generation: 2, expiresAtMs: 1_500 },
            },
          ],
        }),
        now: 1_770_000_000_000,
      }),
    );

    expect(observation.stage).toBe("planning");
    expect(observation.owner?.authority).toBe("decision");
    expect(observation.owner?.fence.leaseGeneration).toBe(2);
    expect(verdict.diagnosis).toBe("stranded");
    // The lease is past its expiry, so the owner is definitively gone.
    expect(verdict.strandedReason).toBe("owner_not_observable");
    expect(verdict.recovery?.class).toBe("reclaim");
    expect(verdict.recovery?.authority).toBe("decision");
    expect(verdict.expectedAction?.taskRef).toEqual({ taskId: "task-1", revision: 3 });
  });

  it("treats a live Decision lease as healthy and never reclaims it", async () => {
    const now = 1_770_000_000_000;
    const { verdict } = await observe(
      source({
        decision: decisionObservation({
          tasks: [
            {
              kind: "review",
              target: { repository: "owner/repo", prNumber: 9, headSha: "a".repeat(40) },
              taskId: "task-2",
              revision: 1,
              status: "running",
              createdAtMs: now - 1_000,
              updatedAtMs: now - 1_000,
              claimGeneration: 1,
              lease: { owner: "chatgpt-web", generation: 1, expiresAtMs: now + 60_000 },
            },
          ],
        }),
        now,
      }),
    );

    expect(verdict.diagnosis).toBe("healthy");
    expect(verdict.recovery).toBeNull();
  });

  it("treats a paused delivery handoff as a compensable stranded work item", async () => {
    const { observation, verdict } = await observe(
      source({
        delivery: {
          repo: "owner/repo",
          issueNumber: 7,
          workspaceKey: "GH-7",
          spentRepairs: 1,
          spentWaitSeconds: 0,
          isPaused: true,
          pauseReason: "budget_exhausted",
          lastUpdated: "2026-10-18T00:00:00.000Z",
          handoff: {
            reason: "budget_exhausted",
            details: "repair budget exhausted",
            repo: "owner/repo",
            issueNumber: 7,
            headBranch: "symphony/GH-7",
            prNumber: 12,
            prUrl: null,
            headSha: "b".repeat(40),
            spentRepairs: 1,
            maxRepairs: 1,
            spentWaitSeconds: 0,
            maxWaitSeconds: 0,
            readyLabel: "symphony-ready",
            readyLabelRemoved: false,
            handoffId: "handoff-1",
          },
        },
      }),
    );

    expect(observation.stage).toBe("delivery");
    expect(observation.expectedAction?.action).toBe("compensate");
    expect(observation.expectedAction?.handoffRef).toEqual({ handoffId: "handoff-1" });
    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.recovery?.authority).toBe("delivery");
  });

  it("reports a paused delivery state without a recoverable handoff as blocked", async () => {
    const { observation, verdict } = await observe(
      source({
        delivery: {
          repo: "owner/repo",
          issueNumber: 7,
          workspaceKey: "GH-7",
          spentRepairs: 1,
          spentWaitSeconds: 0,
          isPaused: true,
          pauseReason: "budget_exhausted",
          lastUpdated: "2026-10-18T00:00:00.000Z",
        },
      }),
    );

    expect(observation.blocked?.unblockCondition).toContain("budget_exhausted");
    expect(verdict.diagnosis).toBe("blocked");
    expect(verdict.recovery).toBeNull();
  });

  it("treats an idle coding item as owned by the orchestrator poll loop", async () => {
    const { verdict } = await observe(source({}));
    expect(verdict.diagnosis).toBe("healthy");
    expect(verdict.owner?.authority).toBe("orchestrator");
    expect(verdict.recovery).toBeNull();
  });

  it("marks a running coding worker with an expired stall deadline as stranded", async () => {
    const now = 1_770_000_000_000;
    const { verdict } = await observe(
      source({
        now,
        stallTimeoutMs: 10_000,
        runtime: runtimeView({
          running: () => ({ startedAt: now - 60_000, lastCodexTimestamp: now - 30_000 }),
        }),
      }),
    );
    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("owner_progress_timeout");
    expect(verdict.recovery?.authority).toBe("orchestrator");
  });

  it("treats an armed retry as scheduled and does not duplicate it", async () => {
    const { verdict } = await observe(
      source({ runtime: runtimeView({ retry: () => ({ attempt: 2 }) }) }),
    );
    expect(verdict.diagnosis).toBe("retry_scheduled");
    expect(verdict.recovery).toBeNull();
  });

  it("fails safe when the delivery source cannot be read", async () => {
    const { observation, verdict } = await observe(
      source({ deliveryThrows: true }),
    );
    expect(observation.sources.some((s) => s.source === "delivery" && s.status === "unavailable")).toBe(true);
    expect(verdict.diagnosis).toBe("observation_unavailable");
    expect(verdict.recovery).toBeNull();
  });
});

describe("Workspace delivery compensation port", () => {
  async function setup(state: unknown): Promise<{
    workspace: string;
    cleanup: () => Promise<void>;
  }> {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-port-"));
    await fs.mkdir(path.join(workspace, ".symphony"), { recursive: true });
    await writeFile(
      path.join(workspace, ".symphony", "delivery-state.json"),
      JSON.stringify(state),
    );
    return {
      workspace,
      cleanup: async () => {
        await fs.rm(workspace, { recursive: true, force: true });
      },
    };
  }

  function pausedState(handoffId = "handoff-1", headSha = "b".repeat(40)) {
    return {
      repo: "owner/repo",
      issueNumber: 7,
      workspaceKey: "GH-7",
      spentRepairs: 1,
      spentWaitSeconds: 0,
      isPaused: true,
      pauseReason: "budget_exhausted",
      lastUpdated: "2026-10-18T00:00:00.000Z",
      handoff: {
        reason: "budget_exhausted",
        details: "budget",
        repo: "owner/repo",
        issueNumber: 7,
        headBranch: "symphony/GH-7",
        prNumber: 12,
        prUrl: null,
        headSha,
        spentRepairs: 1,
        maxRepairs: 1,
        spentWaitSeconds: 0,
        maxWaitSeconds: 0,
        readyLabel: "symphony-ready",
        readyLabelRemoved: true,
        handoffId,
        commentPosted: true,
      },
      readyLabelRemoved: true,
      commentPosted: true,
      commentVerifyStatus: "posted",
      pendingCompensation: false,
    };
  }

  function port(workspace: string, calls: string[]) {
    const issue = makeIssue();
    return createWorkspaceDeliveryCompensationPort({
      workspacePath: () => workspace,
      resolveIssue: async () => issue,
      runner: {
        git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        gh: async (args: readonly string[]) => {
          calls.push(args.join(" "));
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    });
  }

  it("refuses to compensate a different handoff than the one observed", async () => {
    const { workspace, cleanup } = await setup(pausedState("handoff-new"));
    try {
      const calls: string[] = [];
      const result = await port(workspace, calls).compensateHandoff({
        workKey,
        handoffId: "handoff-old",
        expectedHeadSha: "b".repeat(40),
        idempotencyKey: "k",
      });
      expect(result.kind).toBe("refused");
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("refuses to compensate when the observed HEAD changed", async () => {
    const { workspace, cleanup } = await setup(pausedState("handoff-1", "c".repeat(40)));
    try {
      const calls: string[] = [];
      const result = await port(workspace, calls).compensateHandoff({
        workKey,
        handoffId: "handoff-1",
        expectedHeadSha: "b".repeat(40),
        idempotencyKey: "k",
      });
      expect(result.kind).toBe("refused");
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("holds a filesystem mutex so a concurrent compensation is skipped", async () => {
    const { workspace, cleanup } = await setup(pausedState());
    try {
      await fs.mkdir(path.join(workspace, ".symphony", "delivery-compensation.lock"));
      const calls: string[] = [];
      const result = await port(workspace, calls).compensateHandoff({
        workKey,
        handoffId: "handoff-1",
        expectedHeadSha: "b".repeat(40),
        idempotencyKey: "k",
      });
      expect(result.kind).toBe("skipped");
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("compensates the pinned handoff and releases the lock", async () => {
    const { workspace, cleanup } = await setup(pausedState());
    try {
      const calls: string[] = [];
      const result = await port(workspace, calls).compensateHandoff({
        workKey,
        handoffId: "handoff-1",
        expectedHeadSha: "b".repeat(40),
        idempotencyKey: "k",
      });
      expect(result.kind).toBe("applied");
      await expect(
        fs.access(path.join(workspace, ".symphony", "delivery-compensation.lock")),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Host entry: the real process must detect and release an expired Decision claim
// ---------------------------------------------------------------------------

class ManualScheduler implements PollScheduler {
  private pending: Array<{ delayMs: number; callback: () => void }> = [];

  schedule(delayMs: number, callback: () => void): TimerHandle {
    this.pending.push({ delayMs, callback });
    return this.pending.length;
  }

  cancel(): void {
    /* single-use manual scheduler */
  }

  fire(): void {
    const due = this.pending;
    this.pending = [];
    for (const entry of due) {
      entry.callback();
    }
  }
}

function fixtureProfile(issues: Issue[]): TrackerAdapterProfile {
  return {
    kind: "fixture",
    documentation: "docs/testing.md#fixture-tracker",
    secretProviderKeys: [],
    secretEnvVars: [],
    defaultActiveStates: ["open"],
    defaultTerminalStates: ["closed"],
    createAdapter: () => ({
      kind: "fixture",
      fetchIssuesByIds: async (ids) => issues.filter((issue) => ids.includes(issue.id)),
      fetchIssuesByStates: async (states) => issues.filter((issue) => states.includes(issue.state)),
    }),
  };
}

describe("createHost work-level reconciliation (NEST-137)", () => {
  it("releases an expired Decision claim from a real host tick", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "host-work-continuity-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const storeDir = path.join(temp, "decision-store");
    await fs.mkdir(storeDir, { recursive: true });

    // Seed a Decision session with a claimed task whose lease is long expired.
    const seedStore = new DurableDecisionStore({ storeDir, clock: () => 1_000, defaultClaimTtlMs: 1_000 });
    await seedStore.open();
    const seedService = new DecisionService(seedStore, { clock: () => 1_000, defaultClaimTtlMs: 1_000 });
    const session = await seedService.createSession(workKey);
    const task = await seedService.createPlanTask(session.id, {
      requirements: { title: "liveness", body: "detect stranded work" },
    });
    await seedService.claimTask(task.id, { owner: "chatgpt-web", ttlMs: 1_000 });
    await seedStore.close();

    const scheduler = new ManualScheduler();
    let host;
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\npolling:\n  interval_ms: 60000\ncodex:\n  command: "echo test"\n---\nPrompt\n`,
      );

      host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile([makeIssue()])],
        decisionStoreDir: storeDir,
        scheduler,
      });

      await host.start();
      scheduler.fire();
      await host.loop.settled();

      expect(host.workContinuity).toBeDefined();

      // Release the store lock before reading the result from a second handle.
      await host.stop();

      const store = new DurableDecisionStore({ storeDir });
      await store.open();
      const after = store.getTask(task.id);
      await store.close();

      expect(after?.status).toBe("pending");
      expect(after?.lease).toBeNull();
    } finally {
      await host?.stop();
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
