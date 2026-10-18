import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
  DecisionStoreError,
  DurableDecisionStore,
} from "@symphony/decision";
import { isActiveState, type PollScheduler } from "@symphony/orchestrator";
import type { TrackerAdapterProfile } from "@symphony/tracker";

import { createHost } from "./host";
import { DeliveryStateConflictError, recoverDeliveryHandoff } from "@symphony/agent";
import { FileDeliveryStateStorage, runDeliverySkillCli } from "./delivery-skill-cli";
import {
  HostWorkObservationSource,
  TrackerWorkIndex,
  createBridgeDecisionReader,
  createTrackerOrchestratorPort,
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

function reviewTask(overrides: Partial<DecisionObservation["tasks"][number]> = {}) {
  return {
    kind: "review" as const,
    taskId: "review-1",
    revision: 4,
    status: "completed" as const,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    claimGeneration: 1,
    lease: null,
    target: { repository: "owner/repo", prNumber: 9, headSha: "a".repeat(40) },
    ...overrides,
  };
}

function reviewResult(
  verdict: "approve" | "changes_requested" | "needs_human",
): DecisionObservation["results"][number] {
  return {
    taskId: "review-1",
    revision: 4,
    createdAtMs: 2_000,
    outcome: {
      kind: "review",
      verdict,
      target: { repository: "owner/repo", prNumber: 9, headSha: "a".repeat(40) },
    },
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
    issue?: Issue | null;
    isActive?: (issue: Issue) => boolean;
  }): HostWorkObservationSource {
    const refreshed = options.issue === undefined ? makeIssue() : options.issue;
    const index = new TrackerWorkIndex(
      {
        fetchIssuesByStates: async () => [makeIssue()],
        fetchIssuesByIds: async () => (refreshed === null ? [] : [refreshed]),
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
      isActive: options.isActive ?? (() => true),
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

  it("reports a pending task with a bound adapter as an external wait, never a fake schedule", async () => {
    const { observation, verdict } = await observe(
      source({
        decision: decisionObservation({
          session: {
            sessionId: decisionSessionId(workKey),
            status: "active",
            bindingGeneration: 3,
            adapter: "chatgpt-web",
            updatedAtMs: 1_000,
          },
          tasks: [
            {
              kind: "plan",
              taskId: "task-1",
              revision: 1,
              status: "pending",
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              claimGeneration: 0,
              lease: null,
            },
          ],
        }),
      }),
    );

    expect(observation.scheduledRecovery).toBeNull();
    expect(observation.externalWait?.authority).toMatchObject({ kind: "external", system: "chatgpt-web" });
    expect(verdict.diagnosis).toBe("awaiting_external");
    expect(verdict.recovery).toBeNull();
  });

  it("blocks a pending task whose session has no bound executor", async () => {
    const { verdict } = await observe(
      source({
        decision: decisionObservation({
          session: {
            sessionId: decisionSessionId(workKey),
            status: "active",
            bindingGeneration: 3,
            adapter: null,
            updatedAtMs: 1_000,
          },
          tasks: [
            {
              kind: "plan",
              taskId: "task-1",
              revision: 1,
              status: "pending",
              createdAtMs: 1_000,
              updatedAtMs: 1_000,
              claimGeneration: 0,
              lease: null,
            },
          ],
        }),
      }),
    );

    expect(verdict.diagnosis).toBe("blocked");
    expect(verdict.recovery).toBeNull();
  });

  it("continues an approved review into Delivery", async () => {
    const { observation, verdict } = await observe(
      source({
        decision: decisionObservation({
          tasks: [reviewTask()],
          results: [reviewResult("approve")],
        }),
      }),
    );

    expect(observation.stage).toBe("delivery");
    expect(observation.expectedAction?.action).toBe("resume");
    expect(verdict.recovery?.authority).toBe("delivery");
    expect(verdict.expectedAction?.target?.headSha).toBe("a".repeat(40));
  });

  it("routes a changes_requested review into repair", async () => {
    const { observation, verdict } = await observe(
      source({
        decision: decisionObservation({
          tasks: [reviewTask()],
          results: [reviewResult("changes_requested")],
        }),
      }),
    );

    expect(observation.stage).toBe("repair");
    expect(observation.expectedAction?.action).toBe("retry");
    expect(verdict.recovery?.authority).toBe("delivery");
  });

  it("blocks a review that completed without a usable verdict", async () => {
    const { verdict } = await observe(
      source({
        decision: decisionObservation({ tasks: [reviewTask()], results: [] }),
      }),
    );

    expect(verdict.diagnosis).toBe("blocked");
    expect(verdict.recovery).toBeNull();
  });

  it("blocks a plan whose verdict is needs_human instead of delegating", async () => {
    const { verdict } = await observe(
      source({
        decision: decisionObservation({
          tasks: [
            {
              kind: "plan",
              taskId: "plan-1",
              revision: 2,
              status: "completed",
              createdAtMs: 1_000,
              updatedAtMs: 2_000,
              claimGeneration: 1,
              lease: null,
            },
          ],
          results: [
            {
              taskId: "plan-1",
              revision: 2,
              createdAtMs: 2_000,
              outcome: { kind: "plan", verdict: "needs_human" },
            },
          ],
        }),
      }),
    );

    expect(verdict.diagnosis).toBe("blocked");
    expect(verdict.recovery).toBeNull();
    expect(verdict.owner).toBeNull();
  });

  it("treats active work as terminal once the refreshed issue left the active states", async () => {
    const closed = makeIssue({ state: "closed", dispatchable: false });
    const { observation, verdict } = await observe(
      source({
        issue: closed,
        isActive: (issue) => issue.state !== "closed",
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
            details: "budget",
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
        } as PersistedDeliveryState,
      }),
    );

    expect(observation.active).toBe(false);
    expect(verdict.diagnosis).toBe("terminal");
    expect(verdict.recovery).toBeNull();
  });

  it("treats a Decision bridge read failure other than not-found as unavailable", async () => {
    const reader = createBridgeDecisionReader({
      getSession: async () => {
        throw new DecisionStoreError("service unavailable", "unavailable", 503);
      },
    } as unknown as Parameters<typeof createBridgeDecisionReader>[0]);

    await expect(reader.read(workKey)).rejects.toThrow();
  });

  it("treats a not-found Decision session as absent work", async () => {
    const reader = createBridgeDecisionReader({
      getSession: async () => {
        throw new DecisionStoreError("not found", "not_found", 404);
      },
    } as unknown as Parameters<typeof createBridgeDecisionReader>[0]);

    expect(await reader.read(workKey)).toBeNull();
  });

  it("keeps open label-less work active so a paused handoff can still be compensated", async () => {
    const policy = {
      activeStates: ["open"],
      terminalStates: ["closed"],
      requiredLabels: ["symphony-ready"],
      maxConcurrentAgentsByState: {},
    };
    const labelLess = makeIssue({ labels: [] });
    const { observation, verdict } = await observe(
      source({
        issue: labelLess,
        // The production predicate: work activity only, no dispatch eligibility.
        isActive: (issue) => isActiveState(issue.state, policy),
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
            details: "budget",
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
            readyLabelRemoved: true,
            handoffId: "handoff-1",
          },
        } as PersistedDeliveryState,
      }),
    );

    expect(observation.active).toBe(true);
    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.recovery?.class).toBe("compensate");
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
          running: () => ({
            startedAt: now - 60_000,
            lastProgressAt: now - 30_000,
            attemptToken: "attempt-1",
          }),
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

describe("Delivery state authority write guards", () => {
  async function tempStateFile(state: unknown): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-guard-"));
    const file = path.join(dir, ".symphony", "delivery-state.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state));
    return { file, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
  }

  const baseState = {
    repo: "owner/repo",
    issueNumber: 7,
    workspaceKey: "GH-7",
    spentRepairs: 0,
    spentWaitSeconds: 0,
    isPaused: true,
    pauseReason: "budget_exhausted",
    lastUpdated: "2026-10-18T00:00:00.000Z",
  };

  it("rejects a write whose base version changed instead of overwriting a newer handoff", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    try {
      const reader = new FileDeliveryStateStorage(file);
      const first = reader.readState();
      expect(first).not.toBeNull();

      const newer = new FileDeliveryStateStorage(file);
      newer.readState();
      newer.writeState({ ...baseState, lastUpdated: "2026-10-19T00:00:00.000Z" });

      expect(() =>
        reader.writeState({ ...baseState, lastUpdated: "2026-10-20T00:00:00.000Z" }),
      ).toThrow(DeliveryStateConflictError);

      const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { lastUpdated: string };
      expect(onDisk.lastUpdated).toBe("2026-10-19T00:00:00.000Z");
    } finally {
      await cleanup();
    }
  });

  it("serializes writers: a same-process write during an exclusive section conflicts", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    try {
      const holder = new FileDeliveryStateStorage(file);
      const intruder = new FileDeliveryStateStorage(file);

      await holder.withExclusive(async () => {
        holder.readState();
        intruder.readState();
        expect(() => intruder.writeState({ ...baseState, isPaused: false })).toThrow(
          DeliveryStateConflictError,
        );
      });

      const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { isPaused: boolean };
      expect(onDisk.isPaused).toBe(true);
    } finally {
      await cleanup();
    }
  });

  /** Publishes a live ticket in the Delivery lock directory. */
  function writeTicket(
    lockRoot: string,
    ticket: number,
    pid: number,
    token: string,
  ): string {
    const dir = path.join(lockRoot, "tickets", String(ticket));
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({ pid, token, ticket }),
      "utf8",
    );
    return dir;
  }

  it("never preempts a live ticket, however old it is", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      const liveDir = writeTicket(lockRoot, 1, child.pid!, "live-child");

      const storage = new FileDeliveryStateStorage(file, 50);
      storage.readState();
      expect(() => storage.writeState({ ...baseState, isPaused: false })).toThrow(
        DeliveryStateConflictError,
      );

      // A non-owner never touches a live ticket.
      expect(fsSync.existsSync(liveDir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await cleanup();
    }
  });

  it("ignores and cleans up a ticket whose process is gone", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      const deadDir = writeTicket(lockRoot, 1, child.pid!, "dead-child");
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;

      const storage = new FileDeliveryStateStorage(file, 500);
      storage.readState();
      storage.writeState({ ...baseState, isPaused: false });

      const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { isPaused: boolean };
      expect(onDisk.isPaused).toBe(false);
      expect(fsSync.existsSync(deadDir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await cleanup();
    }
  });

  it("keeps exactly one owner when several storages contend for the same dead ticket", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      writeTicket(lockRoot, 1, child.pid!, "dead-child");
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;

      const storages = [
        new FileDeliveryStateStorage(file, 5_000),
        new FileDeliveryStateStorage(file, 5_000),
        new FileDeliveryStateStorage(file, 5_000),
      ];
      let active = 0;
      let maxActive = 0;
      const enter = async (storage: FileDeliveryStateStorage): Promise<void> => {
        await storage.withExclusive(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
        });
      };

      await Promise.all(storages.map(enter));

      // Three contenders and one dead ticket: the section is never held by two at once.
      expect(maxActive).toBe(1);
      const remaining = fsSync.readdirSync(path.join(lockRoot, "tickets"));
      expect(remaining.filter((name) => /^\d+$/.test(name))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await cleanup();
    }
  });

  it("blocks higher tickets while a lower registration is unpublished", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      const unpublished = path.join(lockRoot, "tickets", "1");
      fsSync.mkdirSync(unpublished, { recursive: true });
      // Ticket 1 exists but has not published owner.json yet (registration in flight).

      const storage = new FileDeliveryStateStorage(file, 60);
      storage.readState();
      expect(() => storage.writeState({ ...baseState, isPaused: false })).toThrow(
        DeliveryStateConflictError,
      );

      // The unpublished lower ticket kept its place and was not skipped or removed.
      expect(fsSync.existsSync(unpublished)).toBe(true);
      const live = fsSync
        .readdirSync(path.join(lockRoot, "tickets"))
        .filter((name) => /^\d+$/.test(name) && name !== "1");
      expect(live).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("abandons a ticket allocated from a stale snapshot instead of entering below a live owner", async () => {
    class StaleSnapshotStorage extends FileDeliveryStateStorage {
      private staleCalls = 1;
      protected override highestTicket(): number {
        // First allocation believes the directory is empty, as a stale snapshot would.
        if (this.staleCalls > 0) {
          this.staleCalls -= 1;
          return 0;
        }
        return super.highestTicket();
      }
    }

    const { file, cleanup } = await tempStateFile(baseState);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      const ticketsRoot = path.join(lockRoot, "tickets");
      // Ticket 1 was allocated and released (freed), and a live owner holds ticket 2.
      fsSync.mkdirSync(path.join(ticketsRoot, "released-1"), { recursive: true });
      const owner2 = writeTicket(lockRoot, 2, child.pid!, "live-owner");
      // Ticket 1 is free, so a stale candidate of 1 could be created.

      const storage = new StaleSnapshotStorage(file, 60);
      storage.readState();
      expect(() => storage.writeState({ ...baseState, isPaused: false })).toThrow(
        DeliveryStateConflictError,
      );

      // The stale candidate must have been abandoned, never entered.
      expect(fsSync.existsSync(path.join(ticketsRoot, "1"))).toBe(false);
      expect(fsSync.existsSync(owner2)).toBe(true);
      const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { isPaused: boolean };
      expect(onDisk.isPaused).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await cleanup();
    }
  });

  it("does not remove another live ticket when releasing", async () => {
    const { file, cleanup } = await tempStateFile(baseState);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const lockRoot = path.join(path.dirname(file), ".delivery-state.lock");
      const storage = new FileDeliveryStateStorage(file, 2_000);
      let foreignDir = "";
      await storage.withExclusive(async () => {
        // A foreign live contender takes the next ticket while we hold ours.
        foreignDir = writeTicket(lockRoot, 2, child.pid!, "foreign-live");
      });

      expect(fsSync.existsSync(foreignDir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await cleanup();
    }
  });

  it("holds the Delivery authority lock for the whole compensationso a mid-flight writer cannot commit", async () => {
    const handoff = {
      reason: "budget_exhausted",
      details: "budget",
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
    };
    const { file, cleanup } = await tempStateFile({
      ...baseState,
      handoff,
      readyLabelRemoved: false,
      commentPosted: false,
      commentVerifyStatus: "pending",
      pendingCompensation: true,
    });
    try {
      const storage = new FileDeliveryStateStorage(file);
      const intruder = new FileDeliveryStateStorage(file);
      let conflict: unknown = null;

      const result = await recoverDeliveryHandoff({
        cwd: path.dirname(path.dirname(file)),
        repo: "owner/repo",
        issueNumber: 7,
        stateStorage: storage,
        expectedHandoff: { handoffId: "handoff-1" },
        runner: {
          git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          gh: async () => {
            // A concurrent Delivery writer tries to commit a newer handoff mid-recovery.
            intruder.readState();
            try {
              intruder.writeState({ ...baseState, lastUpdated: "2026-10-21T00:00:00.000Z" });
            } catch (error) {
              conflict = error;
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify({ comments: [{ body: "<!-- symphony:handoff-id: handoff-1 -->" }] }),
              stderr: "",
            };
          },
        },
      });

      expect(conflict).toBeInstanceOf(DeliveryStateConflictError);
      expect(result.success).toBe(true);
      const onDisk = JSON.parse(await fs.readFile(file, "utf8")) as { lastUpdated: string };
      expect(onDisk.lastUpdated).not.toBe("2026-10-21T00:00:00.000Z");
    } finally {
      await cleanup();
    }
  });
});

describe("Orchestrator recovery port", () => {
  function port(calls: string[], reclaimOutcome: "stopped" | "skipped" | "stale" | "stopping" = "stopped") {
    const index = new TrackerWorkIndex(
      {
        fetchIssuesByStates: async () => [makeIssue()],
        fetchIssuesByIds: async () => [makeIssue()],
      },
      () => ["open"],
      (issue) => issueWorkKey(issue, "owner/repo"),
    );
    return createTrackerOrchestratorPort({
      index,
      dispatch: () => {
        calls.push("dispatch");
        return { kind: "dispatched" };
      },
      reclaim: async (input) => {
        calls.push(`reclaim:${input.expectedAttemptToken}`);
        return reclaimOutcome;
      },
    });
  }

  it("reclaims a dead owner through the authority instead of dispatching over it", async () => {
    const calls: string[] = [];
    const outcome = await port(calls).dispatchWork({
      workKey,
      expectedFence: { retryToken: "attempt-9", hasLeaseToken: false },
      idempotencyKey: "k",
      recoveryClass: "reclaim",
    });
    expect(outcome.kind).toBe("applied");
    expect(calls).toEqual(["reclaim:attempt-9"]);
  });

  it("refuses reclaim without the observed attempt token", async () => {
    const calls: string[] = [];
    const outcome = await port(calls).dispatchWork({
      workKey,
      expectedFence: { hasLeaseToken: false },
      idempotencyKey: "k",
      recoveryClass: "reclaim",
    });
    expect(outcome.kind).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("reports a stale attempt as refused", async () => {
    const calls: string[] = [];
    const outcome = await port(calls, "stale").dispatchWork({
      workKey,
      expectedFence: { retryToken: "attempt-old", hasLeaseToken: false },
      idempotencyKey: "k",
      recoveryClass: "reclaim",
    });
    expect(outcome.kind).toBe("refused");
  });

  it("dispatches for a non-reclaim recovery class", async () => {
    const calls: string[] = [];
    const outcome = await port(calls).dispatchWork({
      workKey,
      expectedFence: { hasLeaseToken: false },
      idempotencyKey: "k",
      recoveryClass: "dispatch",
    });
    expect(outcome.kind).toBe("applied");
    expect(calls).toEqual(["dispatch"]);
  });
});

describe("Delivery halt / compensation concurrency", () => {
  it("posts exactly one handoff report when a compensation races a halt", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-halt-race-"));
    await fs.mkdir(path.join(workspace, ".symphony"), { recursive: true });
    let commentCalls = 0;
    const runner = {
      git: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      gh: async (args: readonly string[]) => {
        const command = args.slice(0, 2).join(" ");
        if (command === "issue edit") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "issue view") {
          return { exitCode: 0, stdout: JSON.stringify({ labels: [] }), stderr: "" };
        }
        if (command === "issue comment") {
          commentCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    };
    try {
      const halt = runDeliverySkillCli(
        ["halt", "--repo", "owner/repo", "--issue", "7", "--cwd", workspace, "--ready-label", "symphony-ready"],
        { stdout: { write: () => {} }, stderr: { write: () => {} } },
        runner,
      );

      // Wait until the halt has begun its remote comment submission.
      const deadline = Date.now() + 2_000;
      while (commentCalls === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(commentCalls).toBe(1);

      const competing = new FileDeliveryStateStorage(
        path.join(workspace, ".symphony", "delivery-state.json"),
        2_000,
      );
      const racing = await recoverDeliveryHandoff({
        cwd: workspace,
        repo: "owner/repo",
        issueNumber: 7,
        stateStorage: competing,
        runner,
      });
      // Whatever the outcome, the racing compensation must not post a second report.
      expect(commentCalls).toBe(1);

      await halt;
      expect(commentCalls).toBe(1);
      expect(racing.success).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
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
      isActive: () => true,
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
