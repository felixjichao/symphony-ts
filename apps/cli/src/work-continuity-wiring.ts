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
  type WorkObservationSourceKind,
  type WorkSourceObservation,
  type WorkOwnerFacts,
  type WorkStageFacts,
} from "@symphony/domain";
import {
  DecisionStoreError,
  type DecisionBridgeClient,
  type DecisionService,
} from "@symphony/decision";
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
  /**
   * `lastProgressAt` must be stable progress evidence (lifecycle transition or a positive
   * token delta), never the last arbitrary Codex event.
   */
  running(issue: Issue): {
    readonly startedAt: number;
    readonly lastProgressAt: number | null;
    readonly attemptToken: string;
  } | null;
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
 * Only an explicit "session not found" means the Decision Plane has no work for this key.
 * Every other failure (503, timeout, auth) propagates so the observer records the source as
 * `unavailable`; treating it as "no session" would authorize ownership changes on a blind
 * read.
 */
export function createBridgeDecisionReader(client: DecisionBridgeClient): DecisionWorkReader {
  return {
    async read(workKey) {
      const sessionId = decisionSessionId(workKey);
      let session;
      try {
        session = (await client.getSession(sessionId)).session;
      } catch (error) {
        if (isDecisionNotFound(error)) {
          return null;
        }
        throw error;
      }

      const tasks = (await client.getTasksForSession(sessionId)).tasks;

      // Verdicts are needed to continue completed plan/review work. Fetch them for exactly
      // the tasks the observer can select: the effective plan task plus, per review target
      // (repository + PR + HEAD), the effective review task. A global cap would silently
      // drop the current target when it finished before several unrelated older reviews.
      const effective = new Map<string, (typeof tasks)[number]>();
      for (const task of tasks) {
        if (task.status !== "completed") {
          continue;
        }
        const key =
          task.kind === "review"
            ? `review:${task.target.repository}#${task.target.prNumber}@${task.target.headSha}`
            : "plan";
        const previous = effective.get(key);
        if (
          previous === undefined ||
          task.revision > previous.revision ||
          (task.revision === previous.revision && task.updatedAtMs > previous.updatedAtMs)
        ) {
          effective.set(key, task);
        }
      }

      const results: DecisionObservation["results"][number][] = [];
      for (const task of effective.values()) {
        try {
          const { result } = await client.getTaskResult(task.id);
          results.push({
            taskId: result.taskId,
            revision: result.revision,
            createdAtMs: result.createdAtMs,
            outcome:
              result.kind === "plan"
                ? { kind: "plan", verdict: result.verdict }
                : { kind: "review", verdict: result.verdict, target: result.target },
          });
        } catch (error) {
          if (!isDecisionNotFound(error)) {
            throw error;
          }
        }
      }

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
        results,
      };
    },
  };
}

function isDecisionNotFound(error: unknown): boolean {
  return (
    error instanceof DecisionStoreError &&
    (error.status === 404 || error.code === "not_found" || error.code === "task_not_found")
  );
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

/**
 * Authoritative GitHub PR facts for one work item (read-only).
 *
 * `checks` is a coarse projection of `statusCheckRollup`; `none` means the PR has no checks
 * yet (nothing to wait for), which is different from `pending`.
 */
export interface GitHubPullRequestFacts {
  readonly repository: string;
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly checks: "none" | "pending" | "passing" | "failing";
  /** When these facts were actually read from GitHub (cached reads keep their original). */
  readonly readAt: number;
}

/** `null` = the read succeeded and there is no PR; throwing means the facts are unavailable. */
export interface GitHubPrReader {
  /** `fresh` bypasses the cache; the coordinator uses it immediately around a recovery. */
  read(
    issue: Issue,
    options?: { readonly fresh?: boolean | undefined },
  ): Promise<GitHubPullRequestFacts | null>;
}

interface RawCheck {
  /** CheckRun field. */
  readonly status?: unknown;
  readonly conclusion?: unknown;
  /** Legacy StatusContext field. */
  readonly state?: unknown;
}

/**
 * Maps `statusCheckRollup` to a stage-relevant CI state.
 *
 * The rollup mixes two shapes: check runs (`status` + `conclusion`) and legacy commit
 * statuses (`state` = `EXPECTED` / `PENDING` / `SUCCESS` / `FAILURE` / `ERROR`). Both must
 * be interpreted, otherwise a pending or failing status reads as "passing".
 */
export function projectCheckRollup(checks: readonly RawCheck[]): GitHubPullRequestFacts["checks"] {
  if (checks.length === 0) {
    return "none";
  }
  const failingConclusions = new Set([
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ]);
  const failingStates = new Set(["FAILURE", "ERROR"]);
  const pendingStates = new Set(["EXPECTED", "PENDING"]);
  let pending = false;
  let failed = false;
  for (const check of checks) {
    const state = typeof check.state === "string" ? check.state : null;
    if (state !== null) {
      if (failingStates.has(state)) {
        failed = true;
      } else if (pendingStates.has(state)) {
        pending = true;
      }
      continue;
    }
    const conclusion = typeof check.conclusion === "string" ? check.conclusion : null;
    const status = typeof check.status === "string" ? check.status : null;
    if (conclusion !== null && failingConclusions.has(conclusion)) {
      failed = true;
    }
    if (status !== null && status !== "COMPLETED") {
      pending = true;
    }
  }
  if (failed) {
    return "failing";
  }
  return pending ? "pending" : "passing";
}

/**
 * `gh`-backed PR reader with a short TTL cache.
 *
 * Every read is a real `gh pr list` call for the issue's branch; a failure propagates so the
 * observation can mark the GitHub source unavailable instead of pretending there is no PR.
 */
export function createGitHubPrReader(options: {
  readonly runner: { gh(args: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  readonly cwd?: string | undefined;
  readonly repository: (issue: Issue) => string | null;
  readonly branch: (issue: Issue) => string | null;
  readonly ttlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}): GitHubPrReader {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly value: GitHubPullRequestFacts | null }>();

  return {
    async read(issue, readOptions) {
      const repository = options.repository(issue);
      const branch = options.branch(issue);
      if (repository === null || branch === null) {
        return null;
      }
      const key = `${repository}#${branch}`;
      const cached = cache.get(key);
      if (readOptions?.fresh !== true && cached !== undefined && now() - cached.at < ttlMs) {
        return cached.value;
      }

      const result = await options.runner.gh(
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          branch,
          "--state",
          "all",
          "--limit",
          "10",
          "--json",
          "number,state,headRefOid,isDraft,mergeable,statusCheckRollup",
        ],
        options.cwd ?? process.cwd(),
      );
      if (result.exitCode !== 0) {
        throw new Error(`gh pr list failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout || "[]");
      } catch (error) {
        throw new Error(`gh pr list returned invalid JSON: ${String(error)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error("gh pr list returned a non-array payload");
      }

      const candidates = parsed
        .map((entry) => entry as Record<string, unknown>)
        .filter(
          (entry) =>
            typeof entry["number"] === "number" &&
            typeof entry["state"] === "string" &&
            typeof entry["headRefOid"] === "string",
        )
        .sort((a, b) => (b["number"] as number) - (a["number"] as number));

      const latest = candidates[0];
      const readAt = now();
      const value: GitHubPullRequestFacts | null =
        latest === undefined
          ? null
          : {
              readAt,
              repository,
              number: latest["number"] as number,
              state: latest["state"] as "OPEN" | "CLOSED" | "MERGED",
              headSha: latest["headRefOid"] as string,
              isDraft: latest["isDraft"] === true,
              mergeable:
                latest["mergeable"] === "MERGEABLE" || latest["mergeable"] === "CONFLICTING"
                  ? (latest["mergeable"] as "MERGEABLE" | "CONFLICTING")
                  : "UNKNOWN",
              checks: projectCheckRollup(
                Array.isArray(latest["statusCheckRollup"])
                  ? (latest["statusCheckRollup"] as RawCheck[])
                  : [],
              ),
            };

      cache.set(key, { at: now(), value });
      return value;
    },
  };
}

export interface HostWorkObserverOptions {
  readonly index: TrackerWorkIndex;
  readonly runtime: RuntimeWorkView;
  readonly decision?: DecisionWorkReader | null | undefined;
  readonly delivery?: DeliveryWorkReader | null | undefined;
  /** Authoritative PR / CI / merge facts; absent means the stage is not observable. */
  readonly github?: GitHubPrReader | null | undefined;
  readonly now: () => number;
  readonly stallTimeoutMs: () => number;
  readonly plannedStageTimeoutMs?: number | undefined;
  /** Activity predicate applied to the **refreshed** issue, using current config. */
  readonly isActive: (issue: Issue) => boolean;
}

const DEFAULT_PLANNED_STAGE_TIMEOUT_MS = 30_000;

export class HostWorkObservationSource implements WorkContinuityObservationSource {
  private readonly index: TrackerWorkIndex;
  private readonly runtime: RuntimeWorkView;
  private readonly decision: DecisionWorkReader | null;
  private readonly delivery: DeliveryWorkReader | null;
  private readonly github: GitHubPrReader | null;
  private readonly now: () => number;
  private readonly stallTimeoutMs: () => number;
  private readonly plannedStageTimeoutMs: number;
  private readonly isActiveIssue: (issue: Issue) => boolean;

  public constructor(options: HostWorkObserverOptions) {
    this.index = options.index;
    this.runtime = options.runtime;
    this.decision = options.decision ?? null;
    this.delivery = options.delivery ?? null;
    this.github = options.github ?? null;
    this.now = options.now;
    this.stallTimeoutMs = options.stallTimeoutMs;
    this.plannedStageTimeoutMs = options.plannedStageTimeoutMs ?? DEFAULT_PLANNED_STAGE_TIMEOUT_MS;
    this.isActiveIssue = options.isActive;
  }

  public async observe(workKey: WorkKey): Promise<WorkContinuityObservation> {
    return await this.observeInternal(workKey, false);
  }

  /**
   * Cache-bypassing read used by the coordinator immediately before and after a recovery.
   * GitHub facts are re-read from `gh` and stamped with their real read time.
   */
  public async reobserve(workKey: WorkKey): Promise<WorkContinuityObservation> {
    return await this.observeInternal(workKey, true);
  }

  private async observeInternal(
    workKey: WorkKey,
    fresh: boolean,
  ): Promise<WorkContinuityObservation> {
    const observedAt = this.now();
    const issue = await this.index.readIssue(workKey);
    const sources: WorkSourceObservation[] = [
      { source: "tracker", status: "ok", observedAt },
    ];
    const requiredSources: WorkObservationSourceKind[] = ["tracker"];

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

    // PRs only exist after the Delivery skill has run, which always persists its state
    // before any remote action. Reading GitHub only when there is review or delivery
    // evidence keeps the tick free of external calls for planning/coding work, while still
    // covering every work item that can legitimately be waiting on CI or a merge.
    const hasReviewEvidence = decision?.tasks.some((task) => task.kind === "review") ?? false;
    const hasDeliveryEvidence = delivery !== null;
    let pr: GitHubPullRequestFacts | null = null;
    if (this.github !== null && (hasReviewEvidence || hasDeliveryEvidence)) {
      requiredSources.push("github");
      try {
        pr = await this.github.read(issue, { fresh });
        sources.push({
          source: "github",
          status: "ok",
          // The real read time, not the time the observation was assembled: a cached read
          // must not look fresher than it is.
          observedAt: pr?.readAt ?? this.now(),
        });
      } catch (error) {
        sources.push({
          source: "github",
          status: "unavailable",
          observedAt: this.now(),
          reason: describeError(error),
        });
      }
    }

    const derived = deriveHostStageFacts({
      decision,
      delivery,
      pr,
      runtime: this.runtime,
      issue,
      observedAt,
      stallTimeoutMs: this.stallTimeoutMs(),
      plannedStageTimeoutMs: this.plannedStageTimeoutMs,
    });

    return {
      workKey,
      observedAt,
      // Activity is judged from the refreshed issue against the current configuration, not
      // from the fact that the scan saw it a moment ago.
      active: this.isActiveIssue(issue),
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
  readonly pr: GitHubPullRequestFacts | null;
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
    return blockedFacts(
      "delivery",
      "inspect the paused delivery state",
      delivery.pauseReason ?? "delivery paused without a recoverable handoff",
      Date.parse(delivery.lastUpdated) || observedAt,
    );
  }

  // 2. GitHub-owned stages: merge, CI and exact-HEAD review gating.
  const pr = input.pr;
  if (pr !== null) {
    const target = {
      repository: pr.repository,
      prNumber: pr.number,
      headSha: pr.headSha,
    };

    if (pr.state === "MERGED") {
      // The merge is authoritative; all that remains is for the tracker to reflect it.
      const expectation = deriveStageExpectation({ kind: "merge", target });
      return {
        stage: expectation.stage,
        expectedAction: expectation.expectedAction,
        owner: null,
        liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
        scheduledRecovery: null,
        externalWait: {
          authority: {
            kind: "external",
            system: "github",
            condition: "merge_reflected_in_tracker",
          },
          since: observedAt,
        },
        blocked: null,
        fence: { expectedHeadSha: pr.headSha, hasLeaseToken: false },
      };
    }

    if (pr.state === "CLOSED") {
      return blockedFacts(
        "merge",
        "decide how to continue a closed, unmerged PR",
        `PR #${pr.number} was closed without merging`,
        observedAt,
      );
    }

    if (pr.checks === "pending") {
      // A legitimate CI wait: the work is owned by GitHub Actions, not by a coding owner.
      const expectation = deriveStageExpectation({
        kind: "ci",
        prNumber: pr.number,
        headSha: pr.headSha,
      });
      return {
        stage: expectation.stage,
        expectedAction: expectation.expectedAction,
        owner: null,
        liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
        scheduledRecovery: null,
        externalWait: null,
        blocked: null,
        fence: { expectedHeadSha: pr.headSha, hasLeaseToken: false },
      };
    }

    if (pr.checks === "failing") {
      return repairFacts(target, observedAt);
    }

    // CI is green (or there are no checks to wait for): only a review task recorded against
    // the **exact current target** (same repository, same PR, same HEAD) may own this stage.
    // A task for an older HEAD — or for a different PR that happens to share a commit SHA —
    // is stale and must never be continued or reused.
    const currentReview = reviewTaskForTarget(decision, target);

    if (currentReview !== null && currentReview.kind === "review") {
      if (isLiveTaskStatus(currentReview.status)) {
        return taskOwnedFacts(
          deriveStageExpectation({
            kind: "review",
            task: taskStageFacts(currentReview),
            target: currentReview.target,
          }),
          currentReview,
          observedAt,
          input.plannedStageTimeoutMs,
          decision,
        );
      }
      if (currentReview.status === "completed") {
        const verdict = verdictForTask(decision, currentReview);
        if (verdict?.kind === "review" && verdict.verdict === "approve") {
          return deliveryResumeFacts(currentReview.target, observedAt);
        }
        if (verdict?.kind === "review" && verdict.verdict === "changes_requested") {
          return repairFacts(currentReview.target, observedAt);
        }
        return blockedFacts(
          "review",
          "confirm the completed review result",
          `review task ${currentReview.taskId} completed without a usable verdict (${verdict?.verdict ?? "no result observed"})`,
          currentReview.updatedAtMs,
        );
      }
    }

    // Green CI with no review task for this exact HEAD: the review task must be created or
    // claimed by the Decision authority. No task reference exists yet, so the recovery
    // adapter reports `unavailable` rather than guessing one.
    return {
      stage: "review",
      expectedAction: {
        action: "dispatch",
        description: `create and claim the review task for PR #${pr.number} at ${pr.headSha.slice(0, 10)}`,
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        target,
        requiredEvidence: ["ci_green", "exact_head", "review_task_created"],
      },
      owner: null,
      liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
      scheduledRecovery: null,
      externalWait: null,
      blocked: null,
      fence: { expectedHeadSha: pr.headSha, hasLeaseToken: false },
    };
  }

  // 3. Decision Plane stages: review, then planning, then coding.
  // Task status and the recorded verdict decide the next stage; a completed task is never
  // treated as if it were still running.
  const reviewTask = latestTask(decision, "review");
  const reviewVerdict = reviewTask === null ? null : verdictForTask(decision, reviewTask);
  const planTask = latestTask(decision, "plan");
  const planVerdict = planTask === null ? null : verdictForTask(decision, planTask);

  if (reviewTask !== null && reviewTask.kind === "review" && isLiveTaskStatus(reviewTask.status)) {
    return taskOwnedFacts(
      deriveStageExpectation({
        kind: "review",
        task: taskStageFacts(reviewTask),
        target: reviewTask.target,
      }),
      reviewTask,
      observedAt,
      input.plannedStageTimeoutMs,
      decision,
    );
  }

  if (reviewTask !== null && reviewTask.kind === "review" && reviewTask.status === "completed") {
    if (reviewVerdict?.kind === "review" && reviewVerdict.verdict === "approve") {
      return deliveryResumeFacts(reviewTask.target, observedAt);
    }
    if (reviewVerdict?.kind === "review" && reviewVerdict.verdict === "changes_requested") {
      return repairFacts(reviewTask.target, observedAt);
    }
    return blockedFacts(
      "review",
      "confirm the completed review result",
      `review task ${reviewTask.taskId} completed without a usable verdict (${reviewVerdict?.verdict ?? "no result observed"})`,
      reviewTask.updatedAtMs,
    );
  }

  if (planTask !== null && planTask.kind === "plan" && isLiveTaskStatus(planTask.status)) {
    return taskOwnedFacts(
      deriveStageExpectation({ kind: "planning", task: taskStageFacts(planTask) }),
      planTask,
      observedAt,
      input.plannedStageTimeoutMs,
      decision,
    );
  }

  if (planTask !== null && planTask.kind === "plan" && planTask.status === "completed") {
    if (planVerdict?.kind === "plan" && planVerdict.verdict === "ready") {
      return codingFacts(runtime, issue, observedAt, input.stallTimeoutMs);
    }
    return blockedFacts(
      "planning",
      "resolve the planning verdict before coding continues",
      `plan task ${planTask.taskId} completed with verdict "${planVerdict?.verdict ?? "unknown"}"`,
      planTask.updatedAtMs,
    );
  }

  return codingFacts(runtime, issue, observedAt, input.stallTimeoutMs);
}

function isLiveTaskStatus(status: string): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

function deliveryResumeFacts(
  target: { repository: string; prNumber: number; headSha: string },
  observedAt: number,
): DerivedHostFacts {
  const expectation = deriveStageExpectation({ kind: "delivery", handoffId: null, target });
  return {
    stage: expectation.stage,
    expectedAction: expectation.expectedAction,
    owner: null,
    liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    fence: { expectedHeadSha: target.headSha, hasLeaseToken: false },
  };
}

function repairFacts(
  target: { repository: string; prNumber: number; headSha: string },
  observedAt: number,
): DerivedHostFacts {
  const expectation = deriveStageExpectation({ kind: "repair", target });
  return {
    stage: expectation.stage,
    expectedAction: expectation.expectedAction,
    owner: null,
    liveness: { startedAt: observedAt, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    fence: { expectedHeadSha: target.headSha, hasLeaseToken: false },
  };
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
    // `lastProgressAt` is stable progress evidence (lifecycle transition / positive token
    // delta). Notifications and repeated usage snapshots never advance it.
    const lastProgressAt = running.lastProgressAt ?? "unknown";
    return {
      stage: "coding",
      expectedAction: expectation.expectedAction,
      owner: {
        authority: "orchestrator",
        executor: "codex-agent",
        presence: "present",
        fence: {
          // Real attempt identity: a reclaim must present this token and is rejected when a
          // newer attempt has taken over.
          retryToken: running.attemptToken,
          hasLeaseToken: false,
        },
      },
      liveness: {
        startedAt: running.startedAt,
        lastProgressAt,
        ...(lastProgressAt !== "unknown" ? { progressSource: "agent_lifecycle_or_usage_delta" } : {}),
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
  // A binding generation is fencing history, not proof that an executor is alive. Only the
  // presence of an actual bound adapter supports "waiting for the executor to claim"; no
  // scheduled-recovery credential is invented because no scheduler entry can be observed.
  const boundAdapter = decision?.session?.adapter ?? null;

  if (task.status === "pending") {
    if (boundAdapter !== null) {
      return {
        stage: expectation.stage,
        expectedAction: expectation.expectedAction,
        owner: null,
        liveness: { startedAt: task.updatedAtMs, lastProgressAt: "unknown" },
        scheduledRecovery: null,
        externalWait: {
          authority: {
            kind: "external",
            system: boundAdapter,
            condition: "executor_claim",
          },
          since: task.updatedAtMs,
        },
        blocked: null,
      };
    }
    return blockedFacts(
      expectation.stage,
      "bind an executor to the Decision session",
      `task ${task.taskId} is pending and the session has no bound executor`,
      task.updatedAtMs,
    );
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

function blockedFacts(
  stage: WorkContinuityObservation["stage"],
  instruction: string,
  reason: string,
  since: number,
): DerivedHostFacts {
  return {
    stage,
    expectedAction: null,
    owner: null,
    liveness: { startedAt: since, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: {
      reason: "human_required",
      waitingOn: { kind: "human", role: "operator", instruction },
      unblockCondition: reason,
      blockedAt: since,
    },
  };
}

type DecisionTaskSnapshot = DecisionObservation["tasks"][number];

/**
 * Picks the effective task among candidates: highest numeric revision first, then the most
 * recently updated, then task id.
 *
 * `updatedAtMs` alone is not a reliable ordering: a superseded revision and its replacement
 * can share the same timestamp, and an old task can be touched later than the current one.
 * String task-id comparison is also wrong ("9" > "10"), so revision is compared numerically.
 */
function pickEffectiveTask(candidates: readonly DecisionTaskSnapshot[]): DecisionTaskSnapshot | null {
  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort(
    (a, b) =>
      b.revision - a.revision ||
      b.updatedAtMs - a.updatedAtMs ||
      b.taskId.localeCompare(a.taskId),
  )[0]!;
}

function latestTask(
  decision: DecisionObservation | null,
  kind: "plan" | "review",
): DecisionTaskSnapshot | null {
  if (decision === null) {
    return null;
  }
  return pickEffectiveTask(decision.tasks.filter((task) => task.kind === kind));
}

/**
 * The effective review task for one exact target.
 *
 * The target filter runs **before** the ordering: selecting the newest review first and
 * discarding it when it belongs to another PR would lose a valid current task.
 */
function reviewTaskForTarget(
  decision: DecisionObservation | null,
  target: { readonly repository: string; readonly prNumber: number; readonly headSha: string },
): DecisionTaskSnapshot | null {
  if (decision === null) {
    return null;
  }
  return pickEffectiveTask(
    decision.tasks.filter(
      (task) =>
        task.kind === "review" &&
        task.target.repository === target.repository &&
        task.target.prNumber === target.prNumber &&
        task.target.headSha === target.headSha,
    ),
  );
}

/**
 * The verdict recorded for this exact task revision.
 *
 * No cross-revision fallback: a snapshot whose result does not match the task revision is
 * untrustworthy, and the store already enforces revision matching. Returning `null` makes
 * the caller report "no usable verdict" instead of acting on an older decision.
 */
function verdictForTask(
  decision: DecisionObservation | null,
  task: DecisionTaskSnapshot,
): DecisionObservation["results"][number]["outcome"] | null {
  if (decision === null) {
    return null;
  }
  return (
    decision.results
      .filter((entry) => entry.taskId === task.taskId && entry.revision === task.revision)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]?.outcome ?? null
  );
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
  /**
   * Bounded takeover of a stalled attempt owned by the orchestrator authority. Receives the
   * attempt token observed in the fence; the authority rejects a stale token.
   */
  readonly reclaim?: (input: {
    readonly issueId: string;
    readonly expectedAttemptToken: string;
  }) => Promise<"stopped" | "skipped" | "stale" | "stopping">;
}): OrchestratorRecoveryPort {
  return {
    async dispatchWork(input) {
      const issue = await options.index.readIssue(input.workKey);
      if (issue === null) {
        return { kind: "unavailable", reason: "issue is no longer readable from the tracker" };
      }

      // A dead owner is reclaimed through the authority's bounded stop path, never by
      // dispatching on top of a still-running attempt.
      if (options.reclaim !== undefined && input.recoveryClass === "reclaim") {
        const attemptToken = input.expectedFence.retryToken;
        if (attemptToken === undefined) {
          return {
            kind: "unavailable",
            reason: "reclaim requires the observed attempt token; none was available",
          };
        }
        const outcome = await options.reclaim({
          issueId: issue.id,
          expectedAttemptToken: attemptToken,
        });
        switch (outcome) {
          case "stopped":
            return { kind: "applied", detail: "orchestrator stopped the stalled attempt" };
          case "stale":
            return { kind: "refused", reason: "a newer attempt owns this issue" };
          case "stopping":
            return { kind: "skipped", reason: "orchestrator is shutting down" };
          case "skipped":
            break;
        }
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
  readonly isActive: (issue: Issue) => boolean;
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
      // Admission re-check at commit time: a refreshed issue that left the active states no
      // longer needs compensation, and acting would touch a closed work item.
      if (!options.isActive(issue)) {
        return { kind: "skipped", reason: "work item is no longer active" };
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

        let result;
        try {
          result = await recoverDeliveryHandoff({
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
        } catch (error) {
          return {
            kind: "unavailable",
            reason: `delivery compensation failed: ${describeError(error)}`,
          };
        }

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
