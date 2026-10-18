/**
 * Production wiring for work-level liveness and stranded-state reconciliation
 * (NEST-137 / GitHub #147).
 *
 * This module is the composition root that turns the provider-neutral coordinator into
 * something a real Symphony process runs:
 *
 * - {@link createTrackerWorkIndex}: scans active tracker work and re-reads one issue by
 *   `WorkKey` (never a cached projection);
 * - {@link createHostWorkObserver}: builds one `WorkContinuityObservation` from the tracker,
 *   the orchestrator runtime, the Decision Plane and the workspace's Delivery state;
 * - Orchestrator / Decision / Delivery recovery ports, each calling the authority that owns
 *   the mutation (Delivery additionally holds a filesystem mutex and re-validates the
 *   handoff id / HEAD before every remote write).
 *
 * Everything here is I/O and assembly; the decisions themselves stay in
 * `deriveWorkContinuity` / `WorkContinuityCoordinator`.
 */
import fs from "node:fs";
import path from "node:path";

import { recoverDeliveryHandoff } from "@symphony/agent";
import {
  DEFAULT_WORK_CONTINUITY_POLICY,
  decisionSessionId,
  deriveStageExpectation,
  parseDecisionSessionRootFromId,
  type BlockedReasonDetails,
  type DecisionObservation,
  type DeliveryHandoff,
  type ExpectedNextAction,
  type Issue,
  type PersistedDeliveryState,
  type ScheduledRecoveryFacts,
  type WorkContinuityObservation,
  type WorkContinuityPolicy,
  type WorkExternalWaitFacts,
  type WorkKey,
  type WorkLivenessFacts,
  type WorkSourceObservation,
  type WorkOwnerFacts,
  type WorkStageFacts,
} from "@symphony/domain";
import type { DecisionBridgeClient, DecisionService } from "@symphony/decision";
import {
  WorkContinuityCoordinator,
  createDecisionRecoveryAuthority,
  createDeliveryRecoveryAuthority,
  createOrchestratorRecoveryAuthority,
  type DecisionClaimRecoveryPort,
  type DeliveryHandoffRecoveryPort,
  type OrchestratorRecoveryPort,
  type WorkContinuityObservationSource,
  type WorkContinuityScanSource,
  type WorkRecoveryAuthority,
} from "@symphony/orchestrator";

import { FileDeliveryStateStorage } from "./delivery-skill-cli";

// ---------------------------------------------------------------------------
// Tracker work index
// ---------------------------------------------------------------------------

/** Tracker read surface used by reconciliation (structurally a `TrackerAdapter`). */
export interface WorkContinuityTracker {
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;
  fetchIssuesByIds?(issueIds: readonly string[]): Promise<readonly Issue[]>;
}

/** Maps a provider issue onto the canonical `WorkKey`; `null` when identity is unknown. */
export type IssueWorkKeyResolver = (issue: Issue) => WorkKey | null;

/**
 * Resolves a GitHub issue to its work key from `native_ref`, its URL, or the configured
 * repository. Mirrors `resolveIssueSessionId` in `host.ts` but returns the canonical key.
 */
export function issueWorkKey(issue: Issue, fallbackRepo: string | null): WorkKey | null {
  const sessionId = resolveIssueSessionIdLike(issue, fallbackRepo);
  if (sessionId === null) {
    return null;
  }
  try {
    return parseDecisionSessionRootFromId(sessionId);
  } catch {
    return null;
  }
}

function resolveIssueSessionIdLike(issue: Issue, fallbackRepo: string | null): string | null {
  if (
    issue.nativeRef &&
    typeof issue.nativeRef["repo"] === "string" &&
    typeof issue.nativeRef["number"] === "number"
  ) {
    const parts = (issue.nativeRef["repo"] as string).split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return decisionSessionId({
        provider: "github",
        key: `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}#${issue.nativeRef["number"] as number}`,
      });
    }
  }
  if (issue.url) {
    const match = issue.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (match && match[1] && match[2] && match[3]) {
      return decisionSessionId({
        provider: "github",
        key: `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${Number(match[3])}`,
      });
    }
  }
  if (fallbackRepo) {
    const parts = fallbackRepo.split("/");
    const num = Number(issue.id.replace(/^GH-/, "")) || Number(issue.identifier.replace(/^GH-/, ""));
    if (parts.length === 2 && parts[0] && parts[1] && Number.isInteger(num) && num > 0) {
      return decisionSessionId({
        provider: "github",
        key: `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}#${num}`,
      });
    }
  }
  return null;
}

/**
 * Active work index backed by the real tracker.
 *
 * `listWorkKeys()` refreshes the key → issue-id mapping from a live active-state read;
 * `readIssue()` re-reads one issue by id so the observer never derives from the scan's
 * cached snapshot.
 */
export class TrackerWorkIndex implements WorkContinuityScanSource {
  private readonly byKey = new Map<string, string>();

  public constructor(
    private readonly tracker: WorkContinuityTracker,
    private readonly activeStates: () => readonly string[],
    private readonly resolveKey: IssueWorkKeyResolver,
  ) {}

  public async listWorkKeys(): Promise<readonly WorkKey[]> {
    const issues = await this.tracker.fetchIssuesByStates(this.activeStates());
    this.byKey.clear();
    const keys: WorkKey[] = [];
    for (const issue of issues) {
      const key = this.resolveKey(issue);
      if (key === null) {
        continue;
      }
      this.byKey.set(workKeyId(key), issue.id);
      keys.push(key);
    }
    return keys;
  }

  public async readIssue(workKey: WorkKey): Promise<Issue | null> {
    let issueId = this.byKey.get(workKeyId(workKey));
    if (issueId === undefined) {
      // Direct observation before any scan: resolve the identity from a fresh read.
      await this.listWorkKeys();
      issueId = this.byKey.get(workKeyId(workKey));
    }
    if (issueId === undefined || this.tracker.fetchIssuesByIds === undefined) {
      return null;
    }
    const issues = await this.tracker.fetchIssuesByIds([issueId]);
    return issues.find((issue) => issue.id === issueId) ?? null;
  }
}

function workKeyId(workKey: WorkKey): string {
  return `${workKey.provider}:${workKey.key}`;
}

// ---------------------------------------------------------------------------
// Runtime / Decision / Delivery views
// ---------------------------------------------------------------------------

/** Runtime facts needed for liveness (read-only). */
export interface RuntimeWorkView {
  running(
    issue: Issue,
  ): { readonly startedAt: number; readonly lastCodexTimestamp: number | null } | null;
  retry(issue: Issue): { readonly attempt: number } | null;
}

/** Decision facts read surface; `null` = the Decision Plane is not configured. */
export interface DecisionWorkReader {
  read(workKey: WorkKey): Promise<DecisionObservation | null>;
}

/** Delivery facts read surface; `null` = no persisted delivery state for this workspace. */
export interface DeliveryWorkReader {
  read(issue: Issue): Promise<PersistedDeliveryState | null>;
}

export function createLocalDecisionReader(service: DecisionService): DecisionWorkReader {
  return {
    read: async (workKey) => service.observeWork(workKey),
  };
}

/**
 * Bridge-backed Decision reader.
 *
 * The bridge exposes tasks and session state but not bulk verdicts; a missing verdict is
 * reported as absent rather than guessed, so review outcomes degrade to "completed" and
 * never authorize anything by themselves.
 */
export function createBridgeDecisionReader(client: DecisionBridgeClient): DecisionWorkReader {
  return {
    async read(workKey) {
      const sessionId = decisionSessionId(workKey);
      let session;
      try {
        session = (await client.getSession(sessionId)).session;
      } catch {
        return null;
      }
      const tasks = (await client.getTasksForSession(sessionId)).tasks;
      return {
        workKey,
        session: {
          sessionId: session.id,
          status: session.status,
          bindingGeneration: session.bindingGeneration,
          adapter: session.binding?.adapter ?? null,
          updatedAtMs: session.updatedAtMs,
        },
        tasks: tasks.map((task) => ({
          taskId: task.id,
          revision: task.revision,
          status: task.status,
          createdAtMs: task.createdAtMs,
          updatedAtMs: task.updatedAtMs,
          claimGeneration: task.claimGeneration,
          lease:
            task.lease === null
              ? null
              : {
                  owner: task.lease.owner,
                  generation: task.lease.generation,
                  expiresAtMs: task.lease.expiresAtMs,
                },
          ...(task.kind === "review" ? { kind: "review" as const, target: task.target } : { kind: "plan" as const }),
        })),
        results: [],
      };
    },
  };
}

export function createWorkspaceDeliveryReader(options: {
  readonly workspacePath: (issue: Issue) => string;
}): DeliveryWorkReader {
  return {
    async read(issue) {
      const storage = new FileDeliveryStateStorage(
        path.join(options.workspacePath(issue), ".symphony", "delivery-state.json"),
      );
      return await storage.readState();
    },
  };
}

// ---------------------------------------------------------------------------
// Observation source
// ---------------------------------------------------------------------------

export interface HostWorkObserverOptions {
  readonly index: TrackerWorkIndex;
  readonly runtime: RuntimeWorkView;
  readonly decision?: DecisionWorkReader | null | undefined;
  readonly delivery?: DeliveryWorkReader | null | undefined;
  readonly now: () => number;
  readonly stallTimeoutMs: () => number;
  readonly plannedStageTimeoutMs?: number | undefined;
}

const DEFAULT_PLANNED_STAGE_TIMEOUT_MS = 30_000;

export class HostWorkObservationSource implements WorkContinuityObservationSource {
  private readonly index: TrackerWorkIndex;
  private readonly runtime: RuntimeWorkView;
  private readonly decision: DecisionWorkReader | null;
  private readonly delivery: DeliveryWorkReader | null;
  private readonly now: () => number;
  private readonly stallTimeoutMs: () => number;
  private readonly plannedStageTimeoutMs: number;

  public constructor(options: HostWorkObserverOptions) {
    this.index = options.index;
    this.runtime = options.runtime;
    this.decision = options.decision ?? null;
    this.delivery = options.delivery ?? null;
    this.now = options.now;
    this.stallTimeoutMs = options.stallTimeoutMs;
    this.plannedStageTimeoutMs = options.plannedStageTimeoutMs ?? DEFAULT_PLANNED_STAGE_TIMEOUT_MS;
  }

  public async observe(workKey: WorkKey): Promise<WorkContinuityObservation> {
    const observedAt = this.now();
    const issue = await this.index.readIssue(workKey);
    const sources: WorkSourceObservation[] = [
      { source: "tracker", status: "ok", observedAt },
    ];
    const requiredSources: ("tracker" | "decision" | "delivery" | "runtime")[] = ["tracker"];

    if (issue === null) {
      // The tracker read succeeded but the work item is gone: terminal, nothing to recover.
      return {
        workKey,
        observedAt,
        active: false,
        stage: "coding",
        expectedAction: null,
        owner: null,
        liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
        scheduledRecovery: null,
        externalWait: null,
        blocked: null,
        sources,
        requiredSources,
      };
    }

    let decision: DecisionObservation | null = null;
    if (this.decision !== null) {
      requiredSources.push("decision");
      try {
        decision = await this.decision.read(workKey);
        sources.push({ source: "decision", status: "ok", observedAt: this.now() });
      } catch (error) {
        sources.push({
          source: "decision",
          status: "unavailable",
          observedAt: this.now(),
          reason: describeError(error),
        });
      }
    }

    let delivery: PersistedDeliveryState | null = null;
    if (this.delivery !== null) {
      requiredSources.push("delivery");
      try {
        delivery = await this.delivery.read(issue);
        sources.push({ source: "delivery", status: "ok", observedAt: this.now() });
      } catch (error) {
        sources.push({
          source: "delivery",
          status: "unavailable",
          observedAt: this.now(),
          reason: describeError(error),
        });
      }
    }

    const derived = deriveHostStageFacts({
      decision,
      delivery,
      runtime: this.runtime,
      issue,
      observedAt,
      stallTimeoutMs: this.stallTimeoutMs(),
      plannedStageTimeoutMs: this.plannedStageTimeoutMs,
    });

    return {
      workKey,
      observedAt,
      active: true,
      stage: derived.stage,
      expectedAction: derived.expectedAction,
      owner: derived.owner,
      liveness: derived.liveness,
      scheduledRecovery: derived.scheduledRecovery,
      externalWait: derived.externalWait,
      blocked: derived.blocked,
      sources,
      requiredSources,
      ...(derived.fence !== undefined ? { fence: derived.fence } : {}),
    };
  }
}

interface DerivedHostFacts {
  readonly stage: WorkContinuityObservation["stage"];
  readonly expectedAction: ExpectedNextAction | null;
  readonly owner: WorkOwnerFacts | null;
  readonly liveness: WorkLivenessFacts;
  readonly scheduledRecovery: ScheduledRecoveryFacts | null;
  readonly externalWait: WorkExternalWaitFacts | null;
  readonly blocked: BlockedReasonDetails | null;
  readonly fence?: { readonly expectedHeadSha?: string | undefined; readonly hasLeaseToken: boolean };
}

function deriveHostStageFacts(input: {
  readonly decision: DecisionObservation | null;
  readonly delivery: PersistedDeliveryState | null;
  readonly runtime: RuntimeWorkView;
  readonly issue: Issue;
  readonly observedAt: number;
  readonly stallTimeoutMs: number;
  readonly plannedStageTimeoutMs: number;
}): DerivedHostFacts {
  const { decision, delivery, runtime, issue, observedAt } = input;

  // 1. A paused Delivery handoff is only recoverable when it names a concrete handoff.
  if (delivery !== null && delivery.isPaused) {
    const handoff = delivery.handoff ?? null;
    const target = handoffTarget(handoff);
    if (handoff?.handoffId && target !== null) {
      const stageFacts: WorkStageFacts = {
        kind: "delivery",
        handoffId: handoff.handoffId,
        target,
      };
      const expectation = deriveStageExpectation(stageFacts);
      return {
        stage: expectation.stage,
        expectedAction: expectation.expectedAction,
        owner: null,
        liveness: pausedDeliveryLiveness(delivery, observedAt),
        scheduledRecovery: null,
        externalWait: null,
        blocked: null,
        fence: { expectedHeadSha: target.headSha, hasLeaseToken: false },
      };
    }
    return blockedFacts("delivery", delivery.pauseReason ?? "delivery paused without a recoverable handoff");
  }

  // 2. Decision Plane stages: review, then planning, then coding.
  const reviewTask = latestTask(decision, "review");
  const planTask = latestTask(decision, "plan");
  const planVerdict = planTask === null ? null : latestVerdict(decision, planTask.taskId);

  if (reviewTask !== null && reviewTask.kind === "review") {
    const stageFacts: WorkStageFacts = {
      kind: "review",
      task: taskStageFacts(reviewTask),
      target: reviewTask.target,
    };
    const expectation = deriveStageExpectation(stageFacts);
    return taskOwnedFacts(expectation, reviewTask, observedAt, input.plannedStageTimeoutMs, decision);
  }

  if (reviewTask === null && planTask !== null && planTask.kind === "plan") {
    if (planVerdict === "ready") {
      return codingFacts(runtime, issue, observedAt, input.stallTimeoutMs);
    }
    const stageFacts: WorkStageFacts = {
      kind: "planning",
      task: taskStageFacts(planTask),
    };
    const expectation = deriveStageExpectation(stageFacts);
    return taskOwnedFacts(expectation, planTask, observedAt, input.plannedStageTimeoutMs, decision);
  }

  return codingFacts(runtime, issue, observedAt, input.stallTimeoutMs);
}

function codingFacts(
  runtime: RuntimeWorkView,
  issue: Issue,
  observedAt: number,
  stallTimeoutMs: number,
): DerivedHostFacts {
  const running = runtime.running(issue);
  const retry = runtime.retry(issue);
  const expectation = deriveStageExpectation({ kind: "coding", running: running !== null });

  if (retry !== null) {
    return {
      stage: "coding",
      expectedAction: expectation.expectedAction,
      owner: null,
      liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
      scheduledRecovery: {
        kind: "retry",
        authority: "orchestrator",
        scheduledAt: observedAt,
        dueAt: null,
        credential: `retry:${issue.id}:${retry.attempt}`,
      },
      externalWait: null,
      blocked: null,
    };
  }

  if (running !== null) {
    const lastProgressAt = running.lastCodexTimestamp ?? "unknown";
    return {
      stage: "coding",
      expectedAction: expectation.expectedAction,
      owner: {
        authority: "orchestrator",
        executor: "codex-agent",
        presence: "present",
        fence: {
          retryToken: `attempt:${issue.id}`,
          hasLeaseToken: false,
        },
      },
      liveness: {
        startedAt: running.startedAt,
        lastProgressAt,
        ...(stallTimeoutMs > 0
          ? {
              deadlineAt:
                (typeof lastProgressAt === "number" ? lastProgressAt : running.startedAt) +
                stallTimeoutMs,
            }
          : {}),
      },
      scheduledRecovery: null,
      externalWait: null,
      blocked: null,
    };
  }

  // Idle coding: the orchestrator's own poll loop is the owner and is alive. Reconciliation
  // must not become a second dispatcher, and missing progress is not failure.
  return {
    stage: "coding",
    expectedAction: expectation.expectedAction,
    owner: {
      authority: "orchestrator",
      executor: "codex-agent",
      presence: "present",
      fence: { hasLeaseToken: false },
    },
    liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
  };
}

function taskOwnedFacts(
  expectation: ReturnType<typeof deriveStageExpectation>,
  task: NonNullable<ReturnType<typeof latestTask>>,
  observedAt: number,
  plannedStageTimeoutMs: number,
  decision: DecisionObservation | null,
): DerivedHostFacts {
  const lease = task.lease ?? null;
  const bindingGeneration = decision?.session?.bindingGeneration ?? 0;

  // A task that is merely waiting for its executor is owned by the bridge's poll loop and
  // is an armed schedule, not a stranded work item.
  if (task.status === "pending") {
    if (bindingGeneration > 0) {
      return {
        stage: expectation.stage,
        expectedAction: expectation.expectedAction,
        owner: null,
        liveness: { startedAt: task.updatedAtMs, lastProgressAt: "unknown" },
        scheduledRecovery: {
          kind: "recovery",
          authority: "decision",
          scheduledAt: task.updatedAtMs,
          dueAt: null,
          credential: `bridge-poll:${task.taskId}:${task.revision}`,
        },
        externalWait: null,
        blocked: null,
      };
    }
    return {
      stage: expectation.stage,
      expectedAction: expectation.expectedAction,
      owner: null,
      liveness: { startedAt: task.updatedAtMs, lastProgressAt: "unknown" },
      scheduledRecovery: null,
      externalWait: {
        authority: {
          kind: "human",
          role: "operator",
          instruction: "bind an executor to the Decision session",
        },
        since: task.updatedAtMs,
      },
      blocked: null,
    };
  }

  if (lease !== null) {
    // The lease expiry is the only measurable deadline for a Decision-owned task.
    return {
      stage: expectation.stage,
      expectedAction: expectation.expectedAction,
      owner: {
        authority: "decision",
        executor: "chatgpt-web",
        presence: observedAt >= lease.expiresAtMs ? "absent" : "present",
        fence: { leaseGeneration: lease.generation, hasLeaseToken: true },
      },
      liveness: {
        startedAt: task.updatedAtMs,
        lastProgressAt: "unknown",
        deadlineAt: lease.expiresAtMs,
      },
      scheduledRecovery: null,
      externalWait: null,
      blocked: null,
    };
  }

  // Claimed/running without a lease should be impossible; report an unowned deadline instead
  // of inventing ownership.
  return {
    stage: expectation.stage,
    expectedAction: expectation.expectedAction,
    owner: null,
    liveness: {
      startedAt: task.updatedAtMs,
      lastProgressAt: "unknown",
      deadlineAt: task.updatedAtMs + plannedStageTimeoutMs,
    },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
  };
}

function pausedDeliveryLiveness(
  delivery: PersistedDeliveryState,
  observedAt: number,
): WorkLivenessFacts {
  const lastUpdatedMs = Date.parse(delivery.lastUpdated);
  return {
    startedAt: Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : observedAt,
    lastProgressAt: "unknown",
  };
}

function blockedFacts(stage: WorkContinuityObservation["stage"], reason: string): DerivedHostFacts {
  return {
    stage,
    expectedAction: null,
    owner: null,
    liveness: { startedAt: 0, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: {
      reason: "human_required",
      waitingOn: {
        kind: "human",
        role: "operator",
        instruction: "inspect the paused delivery state",
      },
      unblockCondition: reason,
      blockedAt: 0,
    },
  };
}

function latestTask(
  decision: DecisionObservation | null,
  kind: "plan" | "review",
): DecisionObservation["tasks"][number] | null {
  if (decision === null) {
    return null;
  }
  const candidates = decision.tasks
    .filter((task) => task.kind === kind)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.taskId.localeCompare(a.taskId));
  return candidates[0] ?? null;
}

function latestVerdict(
  decision: DecisionObservation | null,
  taskId: string,
): "ready" | "needs_clarification" | "needs_human" | null {
  if (decision === null) {
    return null;
  }
  const result = decision.results
    .filter((entry) => entry.taskId === taskId)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
  if (result === undefined || result.outcome.kind !== "plan") {
    return null;
  }
  return result.outcome.verdict;
}

function taskStageFacts(
  task: NonNullable<ReturnType<typeof latestTask>>,
): {
  taskId: string;
  revision: number;
  status: DecisionObservation["tasks"][number]["status"];
  claimGeneration: number;
} {
  return {
    taskId: task.taskId,
    revision: task.revision,
    status: task.status,
    claimGeneration: task.claimGeneration ?? 0,
  };
}

function handoffTarget(handoff: DeliveryHandoff | null): {
  repository: string;
  prNumber: number;
  headSha: string;
} | null {
  if (handoff === null) {
    return null;
  }
  const headSha = handoff.headSha ?? "";
  if (handoff.prNumber === null || !/^[0-9a-f]{40}$/.test(headSha)) {
    return null;
  }
  return { repository: handoff.repo, prNumber: handoff.prNumber, headSha };
}

// ---------------------------------------------------------------------------
// Recovery ports
// ---------------------------------------------------------------------------

export function createTrackerOrchestratorPort(options: {
  readonly index: TrackerWorkIndex;
  readonly dispatch: (issue: Issue) => { kind: string; error?: string | undefined };
}): OrchestratorRecoveryPort {
  return {
    async dispatchWork(input) {
      const issue = await options.index.readIssue(input.workKey);
      if (issue === null) {
        return { kind: "unavailable", reason: "issue is no longer readable from the tracker" };
      }
      const result = options.dispatch(issue);
      switch (result.kind) {
        case "dispatched":
          return { kind: "applied", detail: "orchestrator dispatched the work item" };
        case "skipped":
          return { kind: "skipped", reason: "orchestrator already owns or is stopping this issue" };
        case "not_eligible":
          return { kind: "skipped", reason: "issue is not dispatch-eligible" };
        default:
          return { kind: "unavailable", reason: result.error ?? "dispatch failed" };
      }
    },
  };
}

export function createServiceDecisionPort(service: DecisionService): DecisionClaimRecoveryPort {
  return {
    async releaseExpiredClaim(input) {
      const result = await service.releaseExpiredClaim(input.taskId, {
        expectedRevision: input.expectedRevision,
        expectedClaimGeneration: input.expectedClaimGeneration,
      });
      switch (result.kind) {
        case "released":
          return { kind: "released" };
        case "not_expired":
          return { kind: "not_expired" };
        case "superseded":
          return { kind: "superseded", reason: result.reason };
        case "not_found":
          return { kind: "not_found" };
      }
    },
  };
}

export function createBridgeDecisionPort(client: DecisionBridgeClient): DecisionClaimRecoveryPort {
  return {
    async releaseExpiredClaim(input) {
      const result = await client.releaseExpiredClaim(input.taskId, {
        expectedRevision: input.expectedRevision,
        expectedClaimGeneration: input.expectedClaimGeneration,
      });
      switch (result.kind) {
        case "released":
          return { kind: "released" };
        case "not_expired":
          return { kind: "not_expired" };
        case "superseded":
          return { kind: "superseded", reason: result.reason };
        case "not_found":
          return { kind: "not_found" };
      }
    },
  };
}

/**
 * Filesystem-mutex Delivery compensation.
 *
 * The mutex is an atomic `mkdir` in the workspace, so two processes cannot compensate the
 * same workspace at once. The lock alone is not the safety argument: `recoverDeliveryHandoff`
 * re-reads the persisted state before every remote mutation and refuses a different handoff
 * id / HEAD, which covers a lock holder whose state changed underneath it.
 */
export function createWorkspaceDeliveryCompensationPort(options: {
  readonly workspacePath: (issue: Issue) => string;
  readonly resolveIssue: (workKey: WorkKey) => Promise<Issue | null>;
  readonly runner: Parameters<typeof recoverDeliveryHandoff>[0]["runner"];
  readonly mkdir?: typeof fs.mkdirSync | undefined;
  readonly rm?: typeof fs.rmSync | undefined;
}): DeliveryHandoffRecoveryPort {
  const mkdir = options.mkdir ?? fs.mkdirSync;
  const rm = options.rm ?? fs.rmSync;

  return {
    async compensateHandoff(input) {
      const issue = await options.resolveIssue(input.workKey);
      if (issue === null) {
        return { kind: "unavailable", reason: "issue is no longer readable from the tracker" };
      }
      const workspace = options.workspacePath(issue);
      const lockDir = path.join(workspace, ".symphony", "delivery-compensation.lock");

      try {
        mkdir(lockDir, { recursive: false });
      } catch (error) {
        if (isAlreadyExists(error)) {
          return {
            kind: "skipped",
            reason: "another process is already compensating this workspace",
          };
        }
        return { kind: "unavailable", reason: `cannot acquire compensation lock: ${describeError(error)}` };
      }

      try {
        const storage = new FileDeliveryStateStorage(
          path.join(workspace, ".symphony", "delivery-state.json"),
        );
        const state = await storage.readState();
        if (state === null) {
          return { kind: "skipped", reason: "delivery state disappeared" };
        }
        if (!state.isPaused) {
          return { kind: "skipped", reason: "delivery pause already resolved" };
        }
        if ((state.handoff?.handoffId ?? null) !== input.handoffId) {
          return {
            kind: "refused",
            reason: `handoff changed from ${input.handoffId} to ${state.handoff?.handoffId ?? "none"}`,
          };
        }
        if (
          input.expectedHeadSha !== undefined &&
          state.handoff?.headSha !== input.expectedHeadSha
        ) {
          return {
            kind: "refused",
            reason: `handoff HEAD changed from ${input.expectedHeadSha} to ${state.handoff?.headSha ?? "none"}`,
          };
        }

        const result = await recoverDeliveryHandoff({
          cwd: workspace,
          repo: state.repo,
          issueNumber: state.issueNumber,
          workspaceKey: state.workspaceKey,
          stateStorage: storage,
          runner: options.runner,
          expectedHandoff: {
            handoffId: input.handoffId,
            ...(input.expectedHeadSha !== undefined
              ? { expectedHeadSha: input.expectedHeadSha }
              : {}),
          },
        });

        if (result.success) {
          return { kind: "applied", detail: "delivery handoff compensation completed" };
        }
        if (result.pendingCompensation) {
          return {
            kind: "unavailable",
            reason: result.error ?? "delivery compensation is still pending",
          };
        }
        return { kind: "skipped", reason: result.message ?? "delivery compensation not required" };
      } finally {
        try {
          rm(lockDir, { recursive: true, force: true });
        } catch {
          /* A stale lock is reclaimed by the next run; never mask the result. */
        }
      }
    },
  };
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface CreateHostWorkContinuityOptions {
  readonly index: TrackerWorkIndex;
  readonly observer: HostWorkObservationSource;
  readonly orchestrator: OrchestratorRecoveryPort | null;
  readonly decision: DecisionClaimRecoveryPort | null;
  readonly delivery: DeliveryHandoffRecoveryPort | null;
  readonly now: () => number;
  readonly policy?: Partial<WorkContinuityPolicy> | undefined;
  readonly onDiagnostic?:
    | ((diagnostic: {
        readonly kind: string;
        readonly workKey: WorkKey | null;
        readonly message: string;
      }) => void)
    | undefined;
}

/**
 * Assembles the coordinator with only the authority ports that are actually backed by a
 * real authority in this process. An unwired port is absent, so the coordinator reports
 * `authority_unavailable` instead of mutating that source directly.
 */
export function createHostWorkContinuity(
  options: CreateHostWorkContinuityOptions,
): WorkContinuityCoordinator {
  const authorities: WorkRecoveryAuthority[] = [];
  if (options.orchestrator !== null) {
    authorities.push(createOrchestratorRecoveryAuthority(options.orchestrator));
  }
  if (options.decision !== null) {
    authorities.push(createDecisionRecoveryAuthority(options.decision));
  }
  if (options.delivery !== null) {
    authorities.push(createDeliveryRecoveryAuthority(options.delivery));
  }

  return new WorkContinuityCoordinator({
    scan: options.index,
    observer: options.observer,
    authorities,
    now: options.now,
    policy: { ...DEFAULT_WORK_CONTINUITY_POLICY, ...options.policy },
    ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
