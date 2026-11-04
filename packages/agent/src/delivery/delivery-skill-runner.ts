import { SOURCE_PATHS, stageSourceChanges } from "./source-staging";
import { isTransientReadError } from "./transient-read";
import { assertRepairWorkspace, executeMergeConflictRepair, prepareRepairTarget } from "./merge-conflict-repair";
import { recoverDeliveryHandoff } from "./recover-handoff";
import { randomUUID } from "node:crypto";
import {
  decisionSessionId,
  evaluateChecksAutoMergePolicy,
  formatDeliveryHandoffMarkdown,
  formatPrBody,
  githubDecisionRoot,
  completeDeliveryBudgetPhase,
  enterDeliveryBudgetPhase,
  evaluateDeliveryBudget,
  isDeliveryBudgetState,
  migrateLegacyDeliveryBudget,
  validatePrOwnership,
  validateExternalDeliveryState,
  type CheckConclusion,
  type CheckState,
  type DecisionMaterializedContext,
  type DecisionMaterializedPlan,
  type DecisionReviewFinding,
  type DecisionReviewResult,
  type DecisionReviewTarget,
  type DecisionTask,
  type DeliveryContext,
  type DeliveryRemoteBranchReader,
  type DeliveryConflictRecoveryAuthorization,
  type DeliveryBudgetPhase,
  type DeliveryBudgetState,
  type DeliveryBudgetExhaustion,
  type DeliveryContinuation,
  type DeliveryHandoff,
  type DeliveryReviewStatusResult,
  type DeliverySkillConfig,
  type DeliverySkillResult,
  type PersistedDeliveryState,
  type PrCheck,
} from "@symphony/domain";

import type { DeliveryGitGhRunner } from "./git-gh-runner";

export interface DeliveryStateStorage {
  withExclusive?<T>(action: (storage: DeliveryStateStorage) => Promise<T>): Promise<T>;
  readState(): Promise<PersistedDeliveryState | null> | PersistedDeliveryState | null;
  writeState(state: PersistedDeliveryState): Promise<void> | void;
}

export interface RunDeliverySkillOptions extends DeliverySkillConfig {
  readonly readRemoteBranch?: DeliveryRemoteBranchReader | undefined;
  readonly conflictRecoveryAuthorization?: DeliveryConflictRecoveryAuthorization | undefined;
  readonly canCommit?: (() => boolean) | undefined;
  readonly resumeStageOnly?: boolean;
  readonly yieldOnWait?: boolean;
  readonly cwd: string;
  readonly runner: DeliveryGitGhRunner;
  readonly stateStorage?: DeliveryStateStorage | undefined;
  /** @deprecated In-process repairs cannot be terminated safely; use repairCommand. */
  readonly repairFn?: (failureContext: string) => Promise<boolean> | boolean;
  readonly sleepFn?: (seconds: number) => Promise<void>;
  readonly nowFn?: (() => number) | undefined;
  readonly log?: (msg: string) => void;
  readonly signal?: AbortSignal | undefined;
  /** Read-only eligibility check, run after the total deadline is durable. */
  readonly preflight?: ((remainingMs: number, signal: AbortSignal) => Promise<DecisionMaterializedPlan | null | undefined>) | undefined;
}

const DEFAULT_READY_LABEL = "symphony-ready";
const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_MAX_WAIT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export function parseGitHubRepoFromRemote(remoteUrl: string): { host: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  // 1. SSH format: git@github.com:owner/repo.git
  const scpMatch = trimmed.match(/^(?:[\w.-]+@)?([^:/]+):([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (scpMatch) {
    return {
      host: scpMatch[1]!.toLowerCase(),
      repo: scpMatch[2]!,
    };
  }

  // 2. URL format: https://github.com/owner/repo.git
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    // 严格限制合法网络传输协议，拒绝 file:、javascript: 等本地或非标准协议
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:" && protocol !== "git:") {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const cleanPath = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length === 2) {
      return {
        host,
        repo: `${parts[0]}/${parts[1]}`,
      };
    }
  } catch {
    // invalid URL or local directory
  }

  return null;
}

function repoOriginMatches(remoteUrl: string, expectedRepo: string): boolean {
  const parsed = parseGitHubRepoFromRemote(remoteUrl);
  if (!parsed) return false;
  if (parsed.host !== "github.com") return false;
  return parsed.repo.toLowerCase() === expectedRepo.trim().toLowerCase();
}

export type CiDiagnosticStatus = "success" | "permission_or_infra_failure" | "unavailable";

export interface CiDiagnosticsResult {
  readonly status: CiDiagnosticStatus;
  readonly diagnostics: string;
  readonly failureReason?: string | undefined;
}

export async function fetchCiFailureDiagnostics(
  runner: DeliveryGitGhRunner,
  repo: string,
  headSha: string,
  failedChecks: readonly PrCheck[],
  cwd: string,
): Promise<CiDiagnosticsResult> {
  const isPermissionOrInfraText = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      lower.includes("resource not accessible by integration") ||
      lower.includes("permission denied") ||
      lower.includes("bad credentials") ||
      lower.includes("http 403") ||
      lower.includes("http 401") ||
      lower.includes("must have admin rights") ||
      lower.includes("runner system failure") ||
      lower.includes("no space left on device") ||
      lower.includes("billing")
    );
  };

  try {
    const runListRes = await runner.gh(
      ["run", "list", "--repo", repo, "--commit", headSha, "--json", "databaseId,name,status,conclusion,url"],
      cwd,
    );

    if (runListRes.exitCode !== 0) {
      const err = runListRes.stderr || runListRes.stdout;
      if (isPermissionOrInfraText(err)) {
        return {
          status: "permission_or_infra_failure",
          diagnostics: err,
          failureReason: `Permission/infrastructure failure listing CI workflow runs: ${err.trim()}`,
        };
      }
      return {
        status: "unavailable",
        diagnostics: "",
        failureReason: `Failed to list CI workflow runs (${runListRes.exitCode}): ${err.trim()}`,
      };
    }

    let runs: Array<{ databaseId?: number; name?: string; status?: string; conclusion?: string; url?: string }> = [];
    try {
      runs = JSON.parse(runListRes.stdout || "[]");
      if (!Array.isArray(runs)) runs = [];
    } catch (parseErr) {
      return {
        status: "unavailable",
        diagnostics: "",
        failureReason: `Failed to parse workflow runs JSON: ${String(parseErr)}`,
      };
    }

    if (runs.length === 0) {
      return {
        status: "unavailable",
        diagnostics: "",
        failureReason: `No CI workflow runs found for commit ${headSha}`,
      };
    }

    // CheckRun names are job names, not workflow names. Bind every failed check
    // to its Actions run URL rather than guessing from a substring or first run.
    const runsToDiagnose = new Map<number, typeof runs[number]>();
    for (const check of failedChecks) {
      let runId: number | undefined;
      try {
        const url = new URL(check.detailsUrl ?? "");
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/);
        if (url.hostname === "github.com" && match?.[1]?.toLowerCase() === repo.toLowerCase()) {
          runId = Number(match[2]);
        }
      } catch {
        // External checks without accessible Actions logs require operator handoff.
      }
      const run = runs.find((r) => r.databaseId === runId && runId !== undefined);
      if (!run || !["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(String(run.conclusion).toUpperCase())) {
        return {
          status: "unavailable",
          diagnostics: "",
          failureReason: `Cannot identify failed Actions run for check '${check.name}' (${check.detailsUrl ?? "no URL"}) on commit ${headSha}`,
        };
      }
      runsToDiagnose.set(runId!, run);
    }

    const collectedLogs: string[] = [];

    for (const failedRun of runsToDiagnose.values()) {
      if (!failedRun.databaseId) continue;
      const runLogRes = await runner.gh(
        ["run", "view", String(failedRun.databaseId), "--repo", repo, "--log-failed"],
        cwd,
      );

      const err = runLogRes.stderr || runLogRes.stdout;
      if (runLogRes.exitCode !== 0) {
        if (isPermissionOrInfraText(err)) {
          return {
            status: "permission_or_infra_failure",
            diagnostics: err,
            failureReason: `Permission/infrastructure failure fetching log for run ${failedRun.databaseId} (${failedRun.name ?? "unnamed"}): ${err.trim()}`,
          };
        }
        return {
          status: "unavailable",
          diagnostics: "",
          failureReason: `Failed to fetch log for run ${failedRun.databaseId} (${failedRun.url ?? "no URL"}), exit ${runLogRes.exitCode}: ${err.trim()}`,
        };
      }

      const out = runLogRes.stdout.trim();
      if (!out) {
        return { status: "unavailable", diagnostics: "", failureReason: `Empty failure log for run ${failedRun.databaseId} (${failedRun.url ?? "no URL"})` };
      }
      if (out) {
        if (isPermissionOrInfraText(out)) {
          return {
            status: "permission_or_infra_failure",
            diagnostics: out,
            failureReason: `Infrastructure/permission failure detected in run ${failedRun.databaseId} log: ${out.slice(-1000)}`,
          };
        }
        const lines = out.split("\n");
        collectedLogs.push(`=== Run ${failedRun.databaseId} (${failedRun.name ?? "unnamed"}) ===\n` + lines.slice(-100).join("\n"));
      }
    }

    if (collectedLogs.length > 0) {
      return {
        status: "success",
        diagnostics: collectedLogs.join("\n\n"),
      };
    }

    return {
      status: "unavailable",
      diagnostics: "",
      failureReason: `No log content retrieved for failed CI runs [${[...runsToDiagnose.keys()].join(", ")}]`,
    };
  } catch (err) {
    const msg = String(err);
    if (isPermissionOrInfraText(msg)) {
      return {
        status: "permission_or_infra_failure",
        diagnostics: msg,
        failureReason: `Exception during CI failure diagnostics (permission/infra): ${msg}`,
      };
    }
    return {
      status: "unavailable",
      diagnostics: "",
      failureReason: `Exception during CI failure diagnostics: ${msg}`,
    };
  }
}

export function parsePrCheckRollup(
  rawRollup: readonly unknown[],
  effectiveRequiredChecks: readonly string[] | null,
): PrCheck[] {
  return rawRollup.map((raw) => {
    const rc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(rc["name"] || rc["context"] || "unnamed");
    const typename = String(rc["__typename"] || "");
    const detailsUrl = (rc["detailsUrl"] || rc["targetUrl"] || null) as string | null;

    let state: CheckState = "PENDING";
    let conclusion: CheckConclusion | null = null;

    if (typename === "StatusContext" || (!rc["status"] && rc["state"])) {
      const stateStr = String(rc["state"] || "").toUpperCase();
      if (stateStr === "SUCCESS") {
        state = "COMPLETED";
        conclusion = "SUCCESS";
      } else if (stateStr === "FAILURE" || stateStr === "ERROR") {
        state = "COMPLETED";
        conclusion = "FAILURE";
      } else if (stateStr === "PENDING") {
        state = "PENDING";
        conclusion = null;
      }
    } else {
      const rawStatus = String(rc["status"] || "").toUpperCase();
      const rawConclusion = String(rc["conclusion"] || "").toUpperCase();

      if (rawStatus === "COMPLETED") {
        state = "COMPLETED";
        if (rawConclusion === "SUCCESS") {
          conclusion = "SUCCESS";
        } else if (
          rawConclusion === "FAILURE" ||
          rawConclusion === "TIMED_OUT" ||
          rawConclusion === "ACTION_REQUIRED"
        ) {
          conclusion = "FAILURE";
        } else if (rawConclusion === "CANCELLED") {
          conclusion = "CANCELLED";
        } else if (rawConclusion === "SKIPPED") {
          conclusion = "SKIPPED";
        } else if (rawConclusion === "NEUTRAL") {
          conclusion = "NEUTRAL";
        } else {
          conclusion = "UNKNOWN";
        }
      } else {
        state = "PENDING";
        conclusion = null;
      }
    }

    const isRequired =
      Boolean(rc["isRequired"]) ||
      Boolean(effectiveRequiredChecks && effectiveRequiredChecks.includes(name));

    return {
      name,
      workflowName: (rc["workflowName"] as string | null | undefined) ?? null,
      state,
      conclusion,
      isRequired,
      detailsUrl,
    };
  });
}

/**
 * 执行 Codex Delivery + Land Workflow Skill 主链路。
 *
 * 核心阶段：
 * 1. Pre-mutation Inspection: 核对当前分支、origin 仓库、Issue 状态以及现有 PR（--state all 覆盖终态与 foreign PR）。
 * 2. Run Project Validation: 真实执行项目验证命令，失败时禁止 commit/push/merge。
 * 3. Commit: 检查工作区脏状态，提交改动。
 * 4. Push: 推送到远端。
 * 5. Ensure PR: 创建新 PR 或复用合法 PR。
 * 6. CI Inspection & Repair Loop:
 *    - 通过 `gh pr view --json statusCheckRollup,headRefOid,mergeable,state` 兼容各版本 gh 并关联推送 SHA。
 *    - 严格检查所有 observed 与 required checks（均为 success）。
 *    - CI 失败时，读取诊断，执行 repairCommand，重新运行验证，确认生成新 commit 与新 SHA 后再重新推测 CI。
 *    - 维护跨尝试持久化预算与实际墙上时钟 deadline。
 * 7. Land when policy satisfied:
 *    - 仅在明确 optInLand 时执行 squash merge。
 *    - 校验 mergeability，校验 merge 退出码与 MERGED 终态，校验关联 Issue 关闭状态。
 * 8. Blocker/Budget Exhausted:
 *    - 尝试移除 ready 标签，重新核对标签状态，诚实记录移除与评论结果。
 *    - 持久化 paused 状态，阻止未显式 --resume 的重入。
 */
export async function runDeliverySkill(options: RunDeliverySkillOptions): Promise<DeliverySkillResult> {
  if (options.repairFn) throw new Error("repairFn is unsupported: in-process repairs cannot be terminated; use repairCommand");
  const validationTimeoutMs = options.validationTimeoutMs ?? 600_000;
  if (!Number.isSafeInteger(validationTimeoutMs) || validationTimeoutMs <= 0 || validationTimeoutMs > 2_147_483_647) {
    throw new Error("validationTimeoutMs must be a positive integer no greater than 2147483647");
  }
  if (options.maxWaitSeconds !== undefined && (!Number.isSafeInteger(options.maxWaitSeconds)
    || options.maxWaitSeconds < 0 || !Number.isSafeInteger(options.maxWaitSeconds * 1_000))) {
    throw new Error("maxWaitSeconds must be a non-negative integer within the safe millisecond range");
  }
  if (options.budgetPhaseLimitsMs && Object.values(options.budgetPhaseLimitsMs).some(limit => !Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("Delivery phase limits must be positive safe integer milliseconds");
  }
  const storage = options.stateStorage;
  if (storage?.withExclusive) return storage.withExclusive(locked => runDeliverySkillLocked({ ...options, stateStorage: locked }));
  return runDeliverySkillLocked(options);
}

async function runDeliverySkillLocked(
  options: RunDeliverySkillOptions,
): Promise<DeliverySkillResult> {
  const validationTimeoutMs = options.validationTimeoutMs ?? 600_000;
  const native = options.runner;
  const guard = () => {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Delivery canceled");
    if (options.canCommit && !options.canCommit()) throw new Error("Delivery stopped before effect");
  };
  const runner: DeliveryGitGhRunner = {
    git: (args, cwd, timeout) => { guard(); return native.git(args, cwd, timeout); },
    gh: (args, cwd, timeout) => { guard(); return native.gh(args, cwd, timeout); },
    exec: (command, cwd, timeout, env, excludeEnvNames) => { guard(); return native.exec(command, cwd, timeout, env, excludeEnvNames); },
  };
  const readRemoteBranch: DeliveryRemoteBranchReader | undefined = options.readRemoteBranch
    ? async (repository, branch) => {
      guard();
      const observedAtMs = now();
      const phase = budget?.activePhase;
      const remaining = Math.min(deadlineTimestampMs! - observedAtMs,
        phase && (phase.phase === "repair" || phase.phase === "validation") ? phase.deadlineAtMs - observedAtMs : Infinity);
      if (remaining <= 0) throw new Error("merge_conflict_deadline_exhausted");
      return options.readRemoteBranch!(repository, branch, Math.max(1, Math.min(remaining, 2_147_483_647)));
    }
    : undefined;
  const sleep = options.sleepFn ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000)));
  const log = options.log ?? (() => {});

  const readyLabel = options.readyLabel ?? DEFAULT_READY_LABEL;
  let maxRepairs = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIRS;
  const maxWaitSeconds = options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const pollInterval = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;

  const context: DeliveryContext = {
    repo: options.repo,
    issueNumber: options.issueNumber,
    workspaceKey: options.workspaceKey,
    headBranch: options.headBranch,
    baseBranch: options.baseBranch,
  };

  const stateStorage = options.stateStorage;
  let persisted: PersistedDeliveryState | null = null;
  if (stateStorage) {
    try {
      persisted = await stateStorage.readState();
    } catch (err) {
      log(`[delivery-skill] Error reading state storage: ${String(err)}`);
      return {
        status: "blocked",
        prNumber: null,
        prUrl: null,
        headSha: null,
        spentRepairs: 0,
        spentWaitSeconds: 0,
        reason: "manual_intervention_required",
        handoffMarkdown: `Failed to read persisted delivery state: ${String(err)}`,
      };
    }
  }

  if (persisted && (persisted.repo.toLowerCase() !== context.repo.toLowerCase()
    || persisted.issueNumber !== context.issueNumber || persisted.workspaceKey !== context.workspaceKey)) {
    return { status: "blocked", prNumber: null, prUrl: null, headSha: null,
      spentRepairs: persisted.spentRepairs, spentWaitSeconds: persisted.spentWaitSeconds,
      reason: "manual_intervention_required", handoffMarkdown: "Delivery state belongs to a different work identity" };
  }
  if (persisted?.externalSettlement) {
    validateExternalDeliveryState(persisted);
    return { status: "blocked", prNumber: persisted.externalSettlement.target.prNumber, prUrl: null,
      headSha: persisted.externalSettlement.target.headSha, spentRepairs: persisted.spentRepairs,
      spentWaitSeconds: persisted.spentWaitSeconds, reason: "manual_intervention_required",
      handoffMarkdown: "Work was explicitly settled as external completion; Delivery will not replay" };
  }
  if (persisted?.budget !== undefined) {
    if (!isDeliveryBudgetState(persisted.budget) || persisted.budget.totalDeadlineAtMs !== persisted.deadlineTimestampMs
      || persisted.budget.spentRepairs !== persisted.spentRepairs) {
      return { status: "blocked", prNumber: null, prUrl: null, headSha: null,
        spentRepairs: persisted.spentRepairs, spentWaitSeconds: persisted.spentWaitSeconds,
        reason: "manual_intervention_required", handoffMarkdown: "Invalid persisted delivery budget authority" };
    }
    maxRepairs = persisted.budget.repairLimit;
  }
  if (persisted && (persisted.deadlineTimestampMs === undefined
    || !Number.isSafeInteger(persisted.deadlineTimestampMs) || persisted.deadlineTimestampMs < 0
    || persisted.deadlineTimestampMs > 8_640_000_000_000_000)) {
    return { status: "blocked", prNumber: persisted.continuation?.prNumber ?? null, prUrl: null,
      headSha: persisted.continuation?.headSha ?? null, spentRepairs: persisted.spentRepairs,
      spentWaitSeconds: persisted.spentWaitSeconds, reason: "manual_intervention_required",
      handoffMarkdown: "Persisted delivery has no valid absolute deadline; refusing to infer or renew its budget." };
  }
  // Establish legacy authority before compensation or any other side effect. An
  // absolute deadline alone does not establish the original repair limit.
  let migratedBudget: DeliveryBudgetState | undefined;
  if (persisted && !persisted.budget) {
    try { migratedBudget = migrateLegacyDeliveryBudget(persisted); }
    catch (error) {
      return { status: "blocked", prNumber: persisted.continuation?.prNumber ?? null, prUrl: null,
        headSha: persisted.continuation?.headSha ?? null, spentRepairs: persisted.spentRepairs,
        spentWaitSeconds: persisted.spentWaitSeconds, reason: "manual_intervention_required",
        handoffMarkdown: `Cannot migrate persisted delivery budget: ${String(error)}` };
    }
    maxRepairs = migratedBudget.repairLimit;
  }
  const recordedBudget = persisted?.budget ?? migratedBudget;
  if (recordedBudget && (options.nowFn ?? Date.now)() < recordedBudget.totalStartedAtMs) {
    return { status: "blocked", prNumber: persisted?.continuation?.prNumber ?? null, prUrl: null,
      headSha: persisted?.continuation?.headSha ?? null, spentRepairs: persisted?.spentRepairs ?? 0,
      spentWaitSeconds: persisted?.spentWaitSeconds ?? 0, reason: "manual_intervention_required",
      handoffMarkdown: "Delivery clock precedes the recorded budget start; refusing to run or compensate until the clock is corrected." };
  }
  if (options.conflictRecoveryAuthorization) {
    const auth = options.conflictRecoveryAuthorization;
    const operation = persisted?.mergeConflictRepair;
    if (!operation || !["reserved", "merging"].includes(operation.phase) || operation.commitSha
      || auth.operationId !== operation.operationId || auth.attempt !== operation.attempt
      || auth.expectedHeadSha !== operation.expectedHeadSha || auth.executorStopped !== true) {
      return { status: "blocked", prNumber: operation?.prNumber ?? null, prUrl: null, headSha: null,
        spentRepairs: persisted?.spentRepairs ?? 0, spentWaitSeconds: persisted?.spentWaitSeconds ?? 0,
        reason: "manual_intervention_required", handoffMarkdown: "merge_conflict_stale_native_authorization: no replay" };
    }
  }
  if (persisted?.isPaused && persisted.pendingCompensation && options.resume && stateStorage) {
    const compensation = await recoverDeliveryHandoff({ ...context, cwd: options.cwd, stateStorage, runner });
    if (!compensation.success) return { status: "blocked", prNumber: null, prUrl: null, headSha: null,
      spentRepairs: persisted.spentRepairs, spentWaitSeconds: persisted.spentWaitSeconds,
      reason: "manual_intervention_required", handoffMarkdown: "Complete pending compensation before resuming Delivery" };
    persisted = await stateStorage.readState();
  }

  let spentRepairs = 0;
  let initialSpentWaitSeconds = 0;
  let deadlineTimestampMs: number | undefined;
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let currentHeadSha: string | null = null;

  if (persisted && persisted.repo.toLowerCase() === context.repo.toLowerCase() && persisted.issueNumber === context.issueNumber) {
    if (persisted.isPaused && !options.resume) {
      log(`[delivery-skill] Previous delivery paused (${persisted.pauseReason ?? "unknown"}). Refusing to dispatch without resume.`);
      return {
        status: "blocked",
        prNumber: null,
        prUrl: null,
        headSha: null,
        spentRepairs: persisted.spentRepairs,
        spentWaitSeconds: persisted.spentWaitSeconds,
        reason: "manual_intervention_required",
        handoffMarkdown: `Delivery is paused from previous run (${persisted.pauseReason}). Pass --resume to restart.`,
      };
    }
    spentRepairs = persisted.spentRepairs;
    initialSpentWaitSeconds = persisted.spentWaitSeconds;
    deadlineTimestampMs = persisted.deadlineTimestampMs;
  }

  let continuation = persisted?.continuation;
  let landing = persisted?.landing;
  let mergeConflictRepair = persisted?.mergeConflictRepair;
  let budget = persisted?.budget ?? migratedBudget;
  if (persisted && budget && options.budgetPhaseLimitsMs
    && (["ci", "review", "repair", "validation"] as const).some(phase => options.budgetPhaseLimitsMs![phase] !== budget!.phaseLimitsMs[phase])) {
    return { status: "blocked", prNumber: continuation?.prNumber ?? null, prUrl: null, headSha: continuation?.headSha ?? null,
      spentRepairs, spentWaitSeconds: initialSpentWaitSeconds, reason: "manual_intervention_required",
      handoffMarkdown: "Requested phase limits differ from persisted delivery budget authority." };
  }
  const now = options.nowFn ?? Date.now;
  const startTimeMs = now();
  if (deadlineTimestampMs === undefined) {
    deadlineTimestampMs = startTimeMs + Math.max(0, maxWaitSeconds - initialSpentWaitSeconds) * 1000;
  }
  if (!Number.isSafeInteger(startTimeMs) || startTimeMs < 0 || !Number.isSafeInteger(deadlineTimestampMs)
    || deadlineTimestampMs > 8_640_000_000_000_000) throw new Error("Invalid or overflowing delivery deadline");
  if (!persisted) {
    const defaultLimit = Math.max(1, maxWaitSeconds * 1_000);
    budget = { schemaVersion: 1, deliveryRoundId: randomUUID(), totalStartedAtMs: startTimeMs,
      totalDeadlineAtMs: deadlineTimestampMs, phaseLimitsMs: options.budgetPhaseLimitsMs ?? {
        ci: defaultLimit, review: defaultLimit, repair: defaultLimit, validation: defaultLimit,
      }, activePhase: null, phaseHistory: [], spentRepairs: 0, repairLimit: maxRepairs,
      authorizationGeneration: 0, authorizations: [] };
    if (!isDeliveryBudgetState(budget)) throw new Error("Invalid initial delivery budget");
  }

  const getElapsedWaitSeconds = (): number => {
    if (budget) return Math.max(initialSpentWaitSeconds, Math.floor((now() - budget.totalStartedAtMs) / 1000));
    if (deadlineTimestampMs !== undefined) {
      const originalStartTimeMs = deadlineTimestampMs - maxWaitSeconds * 1000;
      const elapsed = Math.floor((now() - originalStartTimeMs) / 1000);
      return Math.max(initialSpentWaitSeconds, elapsed);
    }
    return initialSpentWaitSeconds + Math.floor((now() - startTimeMs) / 1000);
  };

  // Real Codex repair can exceed the subprocess runner's default 60 seconds.
  // Bound it by the existing persisted delivery deadline instead.
  const getRepairTimeoutMs = (): number => {
    const active = budget?.activePhase;
    return Math.max(1, Math.min(deadlineTimestampMs - now(), active?.phase === "repair" ? active.deadlineAtMs - now() : Number.POSITIVE_INFINITY));
  };

  const persistCurrentState = async (overrides?: Partial<PersistedDeliveryState>): Promise<void> => {
    if (!stateStorage) return;
    try {
      if (budget) budget = { ...budget, spentRepairs };
      await stateStorage.writeState({
        ...persisted,
        budget,
        continuation,
        landing,
        mergeConflictRepair,
        repo: context.repo,
        issueNumber: context.issueNumber,
        workspaceKey: context.workspaceKey,
        spentRepairs,
        spentWaitSeconds: getElapsedWaitSeconds(),
        deadlineTimestampMs,
        isPaused: false,
        lastUpdated: new Date(now()).toISOString(),
        ...overrides,
      });
    } catch (err) {
      log(`[delivery-skill] Error persisting delivery state: ${String(err)}`);
      throw err;
    }
  };

  const checkpoint = async (phase: DeliveryContinuation["phase"], extra: Partial<DeliveryContinuation> = {}) => {
    if (prNumber === null || !currentHeadSha) return;
    const same = continuation?.headSha === currentHeadSha && continuation.prNumber === prNumber;
    continuation = { intentId: same ? continuation!.intentId : randomUUID(),
      headBranch: context.headBranch, baseBranch: context.baseBranch, headSha: currentHeadSha, prNumber,
      ...(same ? continuation : {}),
      optInLand: options.optInLand === true, readyLabel, maxRepairAttempts: maxRepairs,
      // Continuation metadata must describe persisted authority, not a new CLI
      // value supplied on resume. The durable deadline remains authoritative.
      maxWaitSeconds: budget ? Math.ceil((budget.totalDeadlineAtMs - budget.totalStartedAtMs) / 1_000) : maxWaitSeconds,
      requiredChecks: options.requiredChecks, repairCommand: options.repairCommand,
      validationCommand: options.validationCommand, validationTimeoutMs, phase, ...extra };
    await persistCurrentState();
  };
  const waiting = (): DeliverySkillResult => ({ status: "waiting", prNumber, prUrl, headSha: currentHeadSha,
    spentRepairs, spentWaitSeconds: getElapsedWaitSeconds(), reason: "awaiting_native_stage" });

  // 辅助函数：触发 Blocker / 预算耗尽处理并移除 ready 标签停止派发
  const haltDispatch = async (
    reason: DeliveryHandoff["reason"],
    details: string,
    budgetExhaustion?: DeliveryBudgetExhaustion,
  ): Promise<DeliverySkillResult> => {
    log(`[delivery-skill] Blocker/budget reached: ${reason}. Halting dispatch...`);
    const spentWaitSeconds = getElapsedWaitSeconds();

    // 构造初始交接报告（发给 GitHub 前作为本地基准，远端状态初始为未确认）
    let readyLabelRemoved = false;
    let commentPosted = false;
    const handoffId = `handoff-${context.repo.replace("/", "-")}-${context.issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    const inspectedExhaustion = budgetExhaustion ? { ...budgetExhaustion,
      recoveryInstructions: `Run symphony delivery-skill budget-inspect --repo ${quote(context.repo)} --issue ${context.issueNumber} --workspace-key ${quote(context.workspaceKey)} --cwd ${quote(options.cwd)}; use the displayed state generation with budget-authorize, then resume after resolving safety gates.` } : undefined;
    const handoffForRemote: DeliveryHandoff = {
      reason,
      details,
      repo: context.repo,
      issueNumber: context.issueNumber,
      headBranch: context.headBranch,
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      maxRepairs,
      spentWaitSeconds,
      maxWaitSeconds: budget ? Math.floor((budget.totalDeadlineAtMs - budget.totalStartedAtMs) / 1_000) : maxWaitSeconds,
      readyLabel,
      readyLabelRemoved: false,
      commentPosted: false,
      handoffId,
      reportDestination: prNumber !== null ? "pr" : "issue",
      budgetExhaustion: inspectedExhaustion,
    };

    // 关键设计决策（先写持久化状态）：在发起任何远端操作之前，必须先将 paused、原因、实际预算/deadline 和待补偿 handoff 落盘。
    // 即使随后的标签移除立刻导致 Reconciliation 触发并终止 worker，本地磁盘依然持有完备的事实与 handoff，绝不丢弃收尾状态。
    await persistCurrentState({
      isPaused: true,
      pauseReason: reason,
      spentWaitSeconds,
      handoff: handoffForRemote,
      readyLabelRemoved: false,
      commentPosted: false,
      commentVerifyStatus: "pending",
      pendingCompensation: true,
    });

    // 关键动作：从 GitHub Issue 尝试移除 symphony-ready 标签
    let labelVerifyError: string | null = null;
    try {
      const removeRes = await runner.gh(
        ["issue", "edit", String(context.issueNumber), "--repo", context.repo, "--remove-label", readyLabel],
        options.cwd,
      );
      if (removeRes.exitCode !== 0) {
        labelVerifyError = `gh issue edit failed: ${removeRes.stderr}`;
      } else {
        // 重读 Issue 标签事实以确认移除成功
        const checkRes = await runner.gh(
          ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "labels"],
          options.cwd,
        );
        if (checkRes.exitCode !== 0) {
          labelVerifyError = `gh issue view failed: ${checkRes.stderr}`;
        } else {
          try {
            const parsed = JSON.parse(checkRes.stdout || "{}");
            if (!Array.isArray(parsed.labels)) {
              labelVerifyError = "Corrupted labels payload from gh issue view";
            } else {
              const labels: Array<{ name: string } | string> = parsed.labels;
              const hasLabel = labels.some((l) => (typeof l === "string" ? l : l.name) === readyLabel);
              if (hasLabel) {
                labelVerifyError = `Label '${readyLabel}' still present on issue #${context.issueNumber}`;
              } else {
                readyLabelRemoved = true;
              }
            }
          } catch (e) {
            labelVerifyError = `Failed to parse issue labels: ${String(e)}`;
          }
        }
      }
      if (readyLabelRemoved) {
        log(`[delivery-skill] Successfully verified removal of label '${readyLabel}' from issue #${context.issueNumber}`);
      } else {
        log(`[delivery-skill] Warning: Label '${readyLabel}' could not be verified as removed (${labelVerifyError ?? "unverified"})`);
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes("canceled_by_reconciliation") || err.name === "AbortError")) {
        throw err;
      }
      log(`[delivery-skill] Warning: Exception while removing label '${readyLabel}': ${String(err)}`);
      readyLabelRemoved = false;
    }

    // 标签移除结果立即可持久化
    const handoffAfterLabel: DeliveryHandoff = { ...handoffForRemote, readyLabelRemoved };
    await persistCurrentState({
      isPaused: true,
      pauseReason: reason,
      spentWaitSeconds,
      handoff: handoffAfterLabel,
      readyLabelRemoved,
      commentPosted: false,
      commentVerifyStatus: "pending",
      pendingCompensation: true,
    });

    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("worker_finished: canceled_by_reconciliation");
    }

    // 发表交接评论
    let commentVerifyStatus: "posted" | "failed" | "unverified" = "unverified";
    const commentBody = formatDeliveryHandoffMarkdown(handoffAfterLabel);

    try {
      const commentTarget = prNumber !== null ? ["pr", "comment", String(prNumber)] : ["issue", "comment", String(context.issueNumber)];
      const commentRes = await runner.gh(
        [...commentTarget, "--repo", context.repo, "--body", commentBody],
        options.cwd,
      );
      if (commentRes.exitCode === 0) {
        commentPosted = true;
        commentVerifyStatus = "posted";
      } else {
        commentPosted = false;
        commentVerifyStatus = "failed";
        log(`[delivery-skill] Warning: Failed to post handoff comment (exit ${commentRes.exitCode}): ${commentRes.stderr}`);
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes("canceled_by_reconciliation") || err.name === "AbortError")) {
        throw err;
      }
      log(`[delivery-skill] Warning: Failed to post handoff comment: ${String(err)}`);
      commentPosted = false;
      commentVerifyStatus = "failed";
    }

    // 更新包含真实 commentPosted 的 markdown 供本地返回
    const handoffFinal: DeliveryHandoff = { ...handoffAfterLabel, commentPosted };
    const handoffMarkdown = formatDeliveryHandoffMarkdown(handoffFinal);
    const pendingCompensation = !(readyLabelRemoved && commentPosted);

    // 持久化最终交接状态
    await persistCurrentState({
      isPaused: true,
      pauseReason: reason,
      spentWaitSeconds,
      handoff: handoffFinal,
      readyLabelRemoved,
      commentPosted,
      commentVerifyStatus,
      pendingCompensation,
    });

    return {
      status: "blocked",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      spentWaitSeconds,
      reason,
      handoffMarkdown,
    };
  };

  const enterBudgetPhase = async (phase: DeliveryBudgetPhase, identity: string): Promise<void> => {
    if (!budget) return;
    const observedAtMs = now();
    if (observedAtMs >= deadlineTimestampMs) return;
    budget = enterDeliveryBudgetPhase({ ...budget, spentRepairs }, phase, identity, observedAtMs);
    await persistCurrentState();
  };
  const totalTimeout = async (stage: string): Promise<DeliverySkillResult | null> => {
    if (now() < deadlineTimestampMs) return null;
    const exhaustion = budget ? evaluateDeliveryBudget(budget, now(), currentHeadSha) ?? undefined : undefined;
    return haltDispatch("budget_exhausted", `Delivery total wall-clock budget exhausted during ${stage} (deadline ${new Date(deadlineTimestampMs).toISOString()}).`, exhaustion);
  };
  const phaseTimeout = async (phase: DeliveryBudgetPhase, identity: string): Promise<DeliverySkillResult | null> => {
    if (!budget || budget.activePhase?.phase !== phase || budget.activePhase.identity !== identity) return null;
    const exhausted = evaluateDeliveryBudget(budget, now(), currentHeadSha);
    if (!exhausted) return null;
    const reasons: Record<DeliveryBudgetPhase, DeliveryHandoff["reason"]> = {
      ci: "ci_wait_timeout", review: "review_wait_timeout", repair: "repair_timeout", validation: "validation_timeout",
    };
    return haltDispatch(exhausted.budgetKind === "total" ? "budget_exhausted" : reasons[phase],
      `${exhausted.budgetKind} budget exhausted during ${phase}; start ${new Date(exhausted.startedAtMs).toISOString()}, deadline ${new Date(exhausted.deadlineAtMs).toISOString()}, observed ${new Date(exhausted.observedAtMs).toISOString()}. ${exhausted.recoveryInstructions}`,
      exhausted);
  };
  const phaseRemainingMs = (phase: DeliveryBudgetPhase, identity: string): number => {
    const active = budget?.activePhase;
    return Math.max(0, Math.min(deadlineTimestampMs - now(), active?.phase === phase && active.identity === identity
      ? active.deadlineAtMs - now() : Number.POSITIVE_INFINITY));
  };
  const completeBudgetPhase = async (phase: DeliveryBudgetPhase, identity: string): Promise<DeliverySkillResult | null> => {
    if (!budget) return null;
    const observedAtMs = now();
    const exhausted = evaluateDeliveryBudget(budget, observedAtMs, currentHeadSha);
    if (exhausted) {
      const reasons: Record<DeliveryBudgetPhase, DeliveryHandoff["reason"]> = {
        ci: "ci_wait_timeout", review: "review_wait_timeout", repair: "repair_timeout", validation: "validation_timeout",
      };
      return haltDispatch(exhausted.budgetKind === "total" ? "budget_exhausted" : reasons[phase],
        `${exhausted.budgetKind} budget exhausted during ${phase}. ${exhausted.recoveryInstructions}`, exhausted);
    }
    budget = completeDeliveryBudgetPhase(budget, phase, identity, observedAtMs);
    await persistCurrentState();
    return null;
  };

  // The bridge transport must cancel its actual request; racing an uncancelled
  // mutation would allow effects after Delivery has reported a timeout.
  const reviewSignal = (deadline: number): AbortSignal => {
    const remaining = Math.max(1, Math.min(4_294_967_295, Math.ceil(deadline - now())));
    const timeout = AbortSignal.timeout(remaining);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  };

  // 必须在开始任何 delivery 动作或前置检查前立即持久化初始状态与绝对 deadline
  await persistCurrentState();
  const inspectionTimeout = await totalTimeout("inspection");
  if (inspectionTimeout) return inspectionTimeout;
  let plan = options.plan;
  if (options.preflight) {
    try {
      plan = await options.preflight(Math.max(1, deadlineTimestampMs - now()), reviewSignal(deadlineTimestampMs));
    } catch (error) {
      const expired = await totalTimeout("planning eligibility");
      if (expired) return expired;
      return { status: "blocked", prNumber, prUrl, headSha: currentHeadSha, spentRepairs,
        spentWaitSeconds: getElapsedWaitSeconds(), reason: "manual_intervention_required",
        handoffMarkdown: `Planning eligibility check failed: ${String(error)}` };
    }
    const expired = await totalTimeout("planning eligibility");
    if (expired) return expired;
  }

  // ==========================================
  // Phase 1: Pre-mutation Inspection
  // ==========================================
  log("[delivery-skill] Phase 1: Pre-mutation inspection (branch, remote origin, issue, PRs)...");

  // 1a. 校验 cwd 当前分支
  const branchRes = await runner.git(["branch", "--show-current"], options.cwd);
  if (branchRes.exitCode !== 0 || branchRes.stdout.trim() !== context.headBranch) {
    return haltDispatch(
      "manual_intervention_required",
      `Working directory current branch '${branchRes.stdout.trim()}' does not match target head branch '${context.headBranch}'.`,
    );
  }

  // 1b. 校验 remote origin（严格要求 host 为 github.com 且目标仓库完全一致）
  const remoteRes = await runner.git(["remote", "get-url", "origin"], options.cwd);
  if (remoteRes.exitCode !== 0 || !repoOriginMatches(remoteRes.stdout, context.repo)) {
    return haltDispatch(
      "manual_intervention_required",
      `Working directory origin URL '${remoteRes.stdout.trim()}' does not match expected GitHub repo '${context.repo}'.`,
    );
  }

  // 1c. 校验 Issue 状态
  const issueRes = await runner.gh(
    ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "state,labels,title"],
    options.cwd,
  );
  if (issueRes.exitCode !== 0) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to query GitHub issue #${context.issueNumber}: ${issueRes.stderr}`,
    );
  }

  let issueState = "OPEN";
  try {
    const issueData = JSON.parse(issueRes.stdout || "{}");
    issueState = String(issueData.state || "OPEN").toUpperCase();
  } catch (err) {
    return haltDispatch(
      "manual_intervention_required",
      `Corrupted issue JSON response from gh: ${String(err)}`,
    );
  }

  // 1d. 检查既有 PRs（覆盖 --state all，严格识别已合入、已关闭、冲突与外来 PR）
  const prListRes = await runner.gh(
    [
      "pr",
      "list",
      "--repo",
      context.repo,
      "--head",
      context.headBranch,
      "--base",
      context.baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,title,body,state,headRefOid",
    ],
    options.cwd,
  );

  if (prListRes.exitCode !== 0) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to query pull requests for branch '${context.headBranch}': ${prListRes.stderr}`,
    );
  }

  let existingPrs: Array<{
    number: number;
    url: string;
    title: string;
    body: string;
    state: string;
    headRefOid?: string;
  }> = [];

  try {
    existingPrs = JSON.parse(prListRes.stdout || "[]");
  } catch (err) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to parse PR list response: ${String(err)}`,
    );
  }

  if (existingPrs.length > 1) {
    return haltDispatch(
      "manual_intervention_required",
      `Ambiguous PR state: found multiple PR candidates (${existingPrs.map((p) => `#${p.number}`).join(", ")}) for branch '${context.headBranch}'.`,
    );
  }

  if (existingPrs.length === 1) {
    const candidate = existingPrs[0]!;
    // 严格所有权校验：绝不以普通 body 包含 issue 引用绕过 marker！
    const ownership = validatePrOwnership(candidate.body, context);
    if (!ownership.valid) {
      return haltDispatch(
        "foreign_pr_conflict",
        `Existing PR #${candidate.number} failed ownership validation for issue #${context.issueNumber} and workspace '${context.workspaceKey}' (${ownership.reason}). Foreign PR rejected.`,
      );
    }

    prNumber = candidate.number;
    prUrl = candidate.url;
    currentHeadSha = candidate.headRefOid ?? null;

    if (candidate.state === "MERGED") {
      // 重新从 PR 查询真实 merge commit SHA
      const viewMerged = await runner.gh(
        ["pr", "view", String(candidate.number), "--repo", context.repo, "--json", "state,mergeCommit"],
        options.cwd,
      );
      let realMergeSha: string | null = null;
      if (viewMerged.exitCode === 0) {
        try {
          const v = JSON.parse(viewMerged.stdout || "{}");
          realMergeSha = (v.mergeCommit?.oid as string) ?? null;
        } catch {
          // ignore
        }
      }

      if (landing && landing.prNumber === candidate.number && landing.headSha === candidate.headRefOid && realMergeSha) {
        landing = { ...landing, phase: "observed", mergeCommitSha: realMergeSha };
        await persistCurrentState();
      }
      if (issueState === "CLOSED") {
        log(`[delivery-skill] PR #${candidate.number} is MERGED and issue #${context.issueNumber} is CLOSED. Completed.`);
        return {
          status: "completed",
          prNumber: candidate.number,
          prUrl: candidate.url,
          headSha: candidate.headRefOid ?? null,
          mergeSha: realMergeSha,
          spentRepairs,
          spentWaitSeconds: getElapsedWaitSeconds(),
          reason: "already_merged_and_closed",
        };
      }

      // PR 已合入但 Issue 仍为 OPEN 或未知状态：输出明确 reconciliation 并停止派发
      return haltDispatch(
        "reconciliation_needed",
        `PR #${candidate.number} is already MERGED (merge commit: ${realMergeSha ?? "unknown"}), but issue #${context.issueNumber} remains open. Requires reconciliation or manual closure.`,
      );
    }

    if (candidate.state === "CLOSED") {
      return haltDispatch(
        "manual_intervention_required",
        `Existing PR #${candidate.number} is closed without merge. Cannot reuse closed PR.`,
      );
    }

    prNumber = candidate.number;
    prUrl = candidate.url;
    log(`[delivery-skill] Reusing verified existing open PR #${prNumber} (${prUrl})`);
  }

  // 若未曾被本分支合法合入，Issue 必须处于 OPEN 状态
  if (issueState === "CLOSED") {
    return haltDispatch(
      "manual_intervention_required",
      `Issue #${context.issueNumber} is already CLOSED on GitHub without merged PR. Delivery aborted.`,
    );
  }

  const conflictTimeout = () => {
    if (now() >= deadlineTimestampMs) throw new Error("merge_conflict_deadline_exhausted");
    const remaining = budget?.activePhase && ["repair", "validation"].includes(budget.activePhase.phase)
      ? Math.min(deadlineTimestampMs - now(), budget.activePhase.deadlineAtMs - now()) : deadlineTimestampMs - now();
    if (remaining <= 0) throw new Error("merge_conflict_phase_deadline_exhausted");
    return Math.min(remaining, 2_147_483_647);
  };
  const conflictRepairOptions = () => ({ context, cwd: options.cwd, runner,
    readRemoteBranch, recoveryAuthorization: options.conflictRecoveryAuthorization,
    operation: mergeConflictRepair!,
    sleep: () => sleep(Math.min(pollInterval, Math.max(0, Math.min(deadlineTimestampMs! - now(),
      budget?.activePhase && ["repair", "validation"].includes(budget.activePhase.phase) ? budget.activePhase.deadlineAtMs - now() : Number.POSITIVE_INFINITY) / 1000))),
    save: async (operation: NonNullable<PersistedDeliveryState["mergeConflictRepair"]>) => {
      mergeConflictRepair = operation;
      if (operation.phase === "validating") await enterBudgetPhase("validation", `repair:${operation.attempt}`);
      if (operation.phase === "committing") await enterBudgetPhase("repair", `repair:${operation.attempt}`);
      await persistCurrentState();
    },
    timeout: conflictTimeout,
    assertIdentity: async () => {
      const branch = await runner.git(["branch", "--show-current"], options.cwd, conflictTimeout());
      const origin = await runner.git(["remote", "get-url", "origin"], options.cwd, conflictTimeout());
      if (branch.exitCode !== 0 || branch.stdout.trim() !== context.headBranch
        || origin.exitCode !== 0 || !repoOriginMatches(origin.stdout, context.repo)) {
        throw new Error("merge_conflict_workspace_identity_changed");
      }
    },
    validationCommand: options.validationCommand!, validationTimeoutMs,
  });
  if (mergeConflictRepair && mergeConflictRepair.phase !== "reconciled" && (mergeConflictRepair.phase !== "pushed"
    || !continuation || continuation.headSha === mergeConflictRepair.expectedHeadSha)) {
    try {
      if (mergeConflictRepair.prNumber !== prNumber || landing?.phase === "intent") {
        throw new Error("merge_conflict_recovery_target_or_landing_unverified");
      }
      currentHeadSha = await executeMergeConflictRepair(conflictRepairOptions(), true);
      await checkpoint("ci");
    } catch (error) {
      const phase = budget?.activePhase;
      if (phase && ["repair", "validation"].includes(phase.phase)) { const exhausted = await phaseTimeout(phase.phase, phase.identity); if (exhausted) return exhausted; }
      const exhausted = await totalTimeout("merge-conflict recovery");
      if (exhausted) return exhausted;
      return haltDispatch("manual_intervention_required", String(error));
    }
  }
  if (mergeConflictRepair?.phase === "reconciled" && continuation?.phase === "repair_pending") {
    // Crash after the read-only recovery receipt but before the CI checkpoint.
    if (currentHeadSha !== mergeConflictRepair.expectedHeadSha) {
      return haltDispatch("manual_intervention_required", "merge_conflict_reconciled_remote_head_changed");
    }
    try { await assertRepairWorkspace(runner, options.cwd, mergeConflictRepair.expectedHeadSha, conflictRepairOptions().timeout); }
    catch (error) { return haltDispatch("manual_intervention_required", String(error)); }
    currentHeadSha = mergeConflictRepair.expectedHeadSha;
    await checkpoint("ci");
  }
  if (continuation?.phase === "repair_pending") {
    return haltDispatch("manual_intervention_required", "repair_outcome_unverified: inspect local/remote HEAD and old executor before resuming");
  }
  if (options.resumeStageOnly && (prNumber === null || !currentHeadSha)) {
    return haltDispatch("manual_intervention_required", "Stage continuation requires an existing owned PR and exact HEAD");
  }
  // A durable stage checkpoint already includes the pushed HEAD and owned PR.
  // Do not replay initial validation, commit or push when resuming it. Refuse
  // local or remote drift rather than treating changed work as that checkpoint.
  const resumeRecordedStage = continuation !== undefined && !options.resumeStageOnly;
  if (resumeRecordedStage && continuation) {
    if (prNumber !== continuation.prNumber || currentHeadSha !== continuation.headSha
      || continuation.headBranch !== context.headBranch || continuation.baseBranch !== context.baseBranch) {
      return haltDispatch("manual_intervention_required", "Recorded delivery stage no longer matches the owned PR and exact HEAD.");
    }
    const localHead = await runner.git(["rev-parse", "HEAD"], options.cwd);
    const localStatus = await runner.git(["status", "--porcelain", "--", ...SOURCE_PATHS], options.cwd);
    if (localHead.exitCode !== 0 || localHead.stdout.trim() !== continuation.headSha
      || localStatus.exitCode !== 0 || localStatus.stdout.trim()) {
      return haltDispatch("manual_intervention_required", "Recorded delivery stage requires the same local HEAD and a clean source workspace.");
    }
  }
  if (!options.resumeStageOnly && !resumeRecordedStage) {
  // ==========================================
  // Phase 2: Run Project Validation
  // ==========================================
  log("[delivery-skill] Phase 2: Running project validation...");
  if (options.validationCommand) {
    log(`[delivery-skill] Executing validation command: ${options.validationCommand}`);
    const validationPreflightTimeout = await totalTimeout("validation");
    if (validationPreflightTimeout) return validationPreflightTimeout;
    await enterBudgetPhase("validation", "initial");
    const validationTotalTimeout = await totalTimeout("validation");
    if (validationTotalTimeout) return validationTotalTimeout;
    const validationEntryTimeout = await phaseTimeout("validation", "initial");
    if (validationEntryTimeout) return validationEntryTimeout;
    const valRes = await runner.exec(options.validationCommand, options.cwd, Math.max(1, Math.min(validationTimeoutMs, phaseRemainingMs("validation", "initial"))));
    const validationObservationTimeout = await phaseTimeout("validation", "initial");
    if (validationObservationTimeout) return validationObservationTimeout;
    const validationCompletionTimeout = await totalTimeout("validation");
    if (validationCompletionTimeout) return validationCompletionTimeout;
    if (valRes.exitCode !== 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Project validation command '${options.validationCommand}' failed with exit code ${valRes.exitCode}: ${valRes.stderr || valRes.stdout}`,
      );
    }
    const completedValidation = await completeBudgetPhase("validation", "initial");
    if (completedValidation) return completedValidation;
    log("[delivery-skill] Project validation succeeded.");
  }

  // ==========================================
  // Phase 3: Commit Changes
  // ==========================================
  const commitTimeout = await totalTimeout("commit");
  if (commitTimeout) return commitTimeout;
  log("[delivery-skill] Phase 3: Committing changes...");
  const statusRes = await runner.git(["status", "--porcelain", "--", ...SOURCE_PATHS], options.cwd);
  if (statusRes.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source status failed: ${statusRes.stderr}`);
  if (statusRes.stdout.trim().length > 0) {
    const staged = await stageSourceChanges(runner, options.cwd);
    if (staged.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source staging failed: ${staged.stderr || staged.stdout}`);
    const commitType = options.commitType ?? "feat";
    const commitMsg =
      options.commitMessage ?? `${commitType}: implement delivery for issue #${context.issueNumber} (${context.workspaceKey})`;
    const commitRes = await runner.git(["commit", "--only", "-m", commitMsg, "--", ...SOURCE_PATHS], options.cwd);
    if (commitRes.exitCode !== 0 && !commitRes.stdout.includes("nothing to commit")) {
      return haltDispatch("manual_intervention_required", `Git commit failed: ${commitRes.stderr}`);
    }
  }

  // ==========================================
  // Phase 4: Push to Remote
  // ==========================================
  const pushTimeout = await totalTimeout("push");
  if (pushTimeout) return pushTimeout;
  log("[delivery-skill] Phase 4: Pushing branch to remote...");
  const pushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
  if (pushRes.exitCode !== 0) {
    const pushUpstream = await runner.git(["push", "-u", "origin", context.headBranch], options.cwd);
    if (pushUpstream.exitCode !== 0) {
      return haltDispatch("manual_intervention_required", `Git push failed: ${pushUpstream.stderr}`);
    }
  }

  const revParse = await runner.git(["rev-parse", "HEAD"], options.cwd);
  currentHeadSha = revParse.stdout.trim();
  log(`[delivery-skill] Pushed HEAD commit: ${currentHeadSha}`);

  // ==========================================
  // Phase 5: Ensure PR (Create if not exists)
  // ==========================================
  if (prNumber === null) {
    const prCreationTimeout = await totalTimeout("pull request creation");
    if (prCreationTimeout) return prCreationTimeout;
    log("[delivery-skill] Phase 5: Creating Pull Request...");
    const prTitle = options.prTitle ?? `feat: delivery for #${context.issueNumber} (${context.workspaceKey})`;
    const prBody = formatPrBody({
      body: `Automated delivery for issue #${context.issueNumber}`,
      context,
    });

    const createRes = await runner.gh(
      [
        "pr",
        "create",
        "--repo",
        context.repo,
        "--head",
        context.headBranch,
        "--base",
        context.baseBranch,
        "--title",
        prTitle,
        "--body",
        prBody,
      ],
      options.cwd,
    );

    if (createRes.exitCode !== 0) {
      return haltDispatch("manual_intervention_required", `Failed to create PR: ${createRes.stderr}`);
    }

    const urlMatch = createRes.stdout.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      prUrl = urlMatch[0];
      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      if (numMatch && numMatch[1]) {
        prNumber = parseInt(numMatch[1], 10);
      }
    }

    if (!prNumber) {
      const recheck = await runner.gh(
        ["pr", "list", "--repo", context.repo, "--head", context.headBranch, "--json", "number,url"],
        options.cwd,
      );
      try {
        const list = JSON.parse(recheck.stdout || "[]");
        if (list[0]) {
          prNumber = list[0].number;
          prUrl = list[0].url;
        }
      } catch {
        // ignore
      }
    }

    if (!prNumber) {
      return haltDispatch("manual_intervention_required", "PR creation succeeded but failed to parse PR number");
    }
    log(`[delivery-skill] Created PR #${prNumber} (${prUrl})`);
  }

  }
  const resumedReviewIdentity = continuation?.headSha === currentHeadSha
    && ["review_intent", "review_wait", "result_observed"].includes(continuation.phase)
    ? continuation.reviewOperationKey : undefined;
  if (resumedReviewIdentity && budget && (budget.activePhase?.phase === "review" && budget.activePhase.identity === resumedReviewIdentity
    || budget.phaseHistory.some(phase => phase.phase === "review" && phase.identity === resumedReviewIdentity))) {
    await enterBudgetPhase("review", resumedReviewIdentity);
  }
  if (!(continuation?.headSha === currentHeadSha && (continuation.phase === "ci_passed"
    || budget?.activePhase?.phase === "review" && ["review_intent", "review_wait", "result_observed"].includes(continuation.phase)))) {
    await checkpoint("ci");
  }

  // ==========================================
  // Phase 6: Inspect CI checks & Repair Loop
  // ==========================================
  log("[delivery-skill] Phase 6: Monitoring CI checks and executing repair loop...");

  // 权威确定 requiredChecks（若调用方未显式提供，向 GitHub rulesets 和 classic protection API 权威查询）
  let effectiveRequiredChecks = options.requiredChecks ? [...options.requiredChecks] : undefined;
  if (effectiveRequiredChecks === undefined) {
    const rulesetChecks: string[] = [];
    let rulesetsDetermined = false;
    let rulesetError: string | null = null;

    const rulesRes = await runner.gh(
      ["api", `repos/${context.repo}/rules/branches/${encodeURIComponent(context.baseBranch)}?per_page=100`, "--paginate", "--jq", "@json"],
      options.cwd,
    );

    if (rulesRes.exitCode === 0) {
      try {
        // gh 2.45 supports --jq but not --slurp. @json emits one compact
        // JSON array per page, so strings containing brackets/newlines remain safe.
        const pages: unknown = rulesRes.stdout.trim()
          ? rulesRes.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
          : [];
        if (Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray)) {
          const parsedRules = pages.flat();
          for (const rule of parsedRules) {
            if (!rule || typeof rule.type !== "string") throw new Error("Invalid rule structure");
            if (rule.type === "required_status_checks") {
              const checks = rule.parameters?.required_status_checks;
              if (!Array.isArray(checks)) throw new Error("Missing ruleset required_status_checks array");
              for (const c of checks) {
                if (!c || typeof c.context !== "string" || !c.context.trim()) throw new Error("Invalid ruleset check context");
                rulesetChecks.push(c.context);
              }
            }
          }
          rulesetsDetermined = true;
        } else {
          rulesetError = "Invalid rulesets API response: expected array";
        }
      } catch (err) {
        rulesetError = `Failed to parse rulesets JSON: ${String(err)}`;
      }
    } else {
      rulesetError = (rulesRes.stderr || rulesRes.stdout).trim();
    }

    const classicChecks: string[] = [];
    let classicDetermined = false;
    let classicError: string | null = null;

    const checksRes = await runner.gh(
      ["api", `repos/${context.repo}/branches/${encodeURIComponent(context.baseBranch)}/protection/required_status_checks`],
      options.cwd,
    );

    if (checksRes.exitCode === 0) {
      try {
        const parsedChecks = JSON.parse(checksRes.stdout || "{}");
        const hasContexts = Array.isArray(parsedChecks.contexts);
        const hasChecks = Array.isArray(parsedChecks.checks);
        if (hasContexts || hasChecks) {
          if ((parsedChecks.contexts !== undefined && !hasContexts) || (parsedChecks.checks !== undefined && !hasChecks)) throw new Error("Invalid classic protection arrays");
          if (hasContexts) {
            if (!parsedChecks.contexts.every((c: unknown) => typeof c === "string" && c.trim())) throw new Error("Invalid classic check context");
            classicChecks.push(...parsedChecks.contexts);
          }
          if (hasChecks) {
            for (const c of parsedChecks.checks) {
              if (!c || typeof c.context !== "string" || !c.context.trim()) throw new Error("Invalid classic check context");
              classicChecks.push(c.context);
            }
          }
          classicDetermined = true;
        } else {
          classicError = "Invalid classic protection response structure: missing contexts/checks array";
        }
      } catch (err) {
        classicError = `Failed to parse classic protection JSON: ${String(err)}`;
      }
    } else {
      const errOut = (checksRes.stderr + " " + checksRes.stdout).toLowerCase();
      // 只有明确包含 "branch not protected" 才证明经典分支保护未开启
      if (errOut.includes("branch not protected")) {
        classicDetermined = true;
      } else {
        classicError = (checksRes.stderr || checksRes.stdout).trim();
      }
    }

    if (rulesetsDetermined && classicDetermined) {
      effectiveRequiredChecks = Array.from(new Set([...rulesetChecks, ...classicChecks]));
    } else {
      return haltDispatch(
        "manual_intervention_required",
        `Unable to authoritatively determine required status checks for base branch '${context.baseBranch}' (rulesets: ${rulesetError ?? (rulesetsDetermined ? "none" : "unknown")}, classic: ${classicError ?? (classicDetermined ? "none" : "unknown")}). Configuration is unknown or credentials lack branch rules permissions. Specify requiredChecks explicitly to proceed.`,
      );
    }
  }

  const repoParts = context.repo.split("/");
  const resolvedSessionId =
    options.sessionId ??
    (repoParts.length === 2 && repoParts[0] && repoParts[1]
      ? decisionSessionId(githubDecisionRoot(repoParts[0], repoParts[1], context.issueNumber))
      : `github:${context.repo}#${context.issueNumber}`);
  let lastReviewTaskId: string | null = null;
  const previousReviews: DecisionReviewResult[] = [];
  let unresolvedFindings: readonly DecisionReviewFinding[] = [];

  landing_loop: while (true) {
  delivery_loop: while (true) {
    let ciPassedChecks: PrCheck[] = [];
    let ciReason = "";
    const ciIdentity = currentHeadSha!;
    const reobservingForReview = budget?.activePhase?.phase === "review" && continuation?.headSha === ciIdentity
      && ["review_intent", "review_wait", "result_observed"].includes(continuation.phase);
    const reobservingPassedCi = continuation?.headSha === ciIdentity && continuation.phase === "ci_passed";
    const ciBudgetPhase = reobservingForReview ? "review" : "ci";
    const ciBudgetIdentity = reobservingForReview ? budget!.activePhase!.identity : ciIdentity;
    const ciEntryTimeout = await totalTimeout("CI");
    if (ciEntryTimeout) return ciEntryTimeout;
    if (!reobservingForReview) await enterBudgetPhase("ci", ciIdentity);

    while (true) {
      const elapsedWait = getElapsedWaitSeconds();
      const ciTimeout = reobservingPassedCi ? null : await phaseTimeout(ciBudgetPhase, ciBudgetIdentity);
      if (ciTimeout) return ciTimeout;
      const totalCiTimeout = await totalTimeout("CI");
      if (totalCiTimeout) return totalCiTimeout;

      // 在进入等待/轮询检查前立即持久化当前等待状态与绝对截止时间
      await persistCurrentState();

      // 采用 gh pr view --json statusCheckRollup,headRefOid,mergeable,state
      // 兼容所有 gh 版本并绑定 headRefOid 与当前 head SHA
      const prViewRes = await runner.gh(
        ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "headRefOid,statusCheckRollup,mergeable,state"],
        options.cwd,
        Math.max(1, reobservingPassedCi ? deadlineTimestampMs - now() : phaseRemainingMs(ciBudgetPhase, ciBudgetIdentity)),
      );
      const ciObservationTimeout = reobservingPassedCi ? null : await phaseTimeout(ciBudgetPhase, ciBudgetIdentity);
      if (ciObservationTimeout) return ciObservationTimeout;
      const totalCiObservationTimeout = await totalTimeout("CI observation");
      if (totalCiObservationTimeout) return totalCiObservationTimeout;

      if (prViewRes.exitCode !== 0) {
        if (reobservingPassedCi) { const expired = await phaseTimeout("ci", ciIdentity); if (expired) return expired; }
        log(`[delivery-skill] Warning: Failed to fetch PR view for checks: ${prViewRes.stderr}. Retrying in ${pollInterval}s...`);
        await persistCurrentState();
        await sleep(Math.min(pollInterval, phaseRemainingMs(ciBudgetPhase, ciBudgetIdentity) / 1000));
        continue;
      }

      let prViewData: {
        headRefOid?: string;
        mergeable?: string;
        state?: string;
        statusCheckRollup?: Array<Record<string, unknown>>;
      } = {};

      try {
        prViewData = JSON.parse(prViewRes.stdout || "{}");
      } catch (err) {
        if (reobservingPassedCi) { const expired = await phaseTimeout("ci", ciIdentity); if (expired) return expired; }
        log(`[delivery-skill] Warning: Failed to parse PR view response: ${String(err)}`);
        await persistCurrentState();
        await sleep(Math.min(pollInterval, phaseRemainingMs(ciBudgetPhase, ciBudgetIdentity) / 1000));
        continue;
      }

      // 严格核对 PR 上的 headRefOid 必须存在且与当前已推送 head SHA 完全一致
      if (!prViewData.headRefOid || prViewData.headRefOid !== currentHeadSha) {
        if (reobservingPassedCi) { const expired = await phaseTimeout("ci", ciIdentity); if (expired) return expired; }
        log(
          `[delivery-skill] CI checks pending: PR headRefOid (${prViewData.headRefOid ?? "missing"}) does not match current HEAD (${currentHeadSha}) yet. Waiting ${pollInterval}s...`,
        );
        await persistCurrentState();
        await sleep(Math.min(pollInterval, phaseRemainingMs(ciBudgetPhase, ciBudgetIdentity) / 1000));
        continue;
      }

      const rawRollup = Array.isArray(prViewData.statusCheckRollup) ? prViewData.statusCheckRollup : [];
      const parsedChecks: PrCheck[] = parsePrCheckRollup(rawRollup, effectiveRequiredChecks);

      // 使用 canonical MVP.3 策略（required + observed checks 均须严格全 green）。
      // 已配置但尚未出现在 rollup 的 required check 以 PENDING 合成，确保 fail-closed 等待。
      const requiredPrChecks: PrCheck[] = (effectiveRequiredChecks ?? []).map((requiredName) => {
        const observed = parsedChecks.find((c) => c.name === requiredName);
        return (
          observed ?? {
            name: requiredName,
            state: "PENDING",
            conclusion: null,
            isRequired: true,
            detailsUrl: null,
          }
        );
      });

      const evaluation = evaluateChecksAutoMergePolicy(requiredPrChecks, parsedChecks);

      // 6a. Checks Green -> 进入 Review Gate
      if (evaluation.canAutoMerge) {
        log(`[delivery-skill] CI checks green! (${evaluation.reason})`);
        if (!reobservingForReview) await checkpoint("ci_passed");
        ciPassedChecks = parsedChecks;
        ciReason = evaluation.reason;
        break;
      }

      if (reobservingPassedCi) {
        const expired = await phaseTimeout("ci", ciIdentity);
        if (expired) return expired;
      }

      // 6b. Checks Failed -> 进入 Repair Loop
      if (evaluation.status === "failing") {
        const failedChecks = evaluation.failedOrPendingChecks.filter(
          (c) =>
            c.state === "COMPLETED" &&
            (c.conclusion === "FAILURE" || c.conclusion === "CANCELLED" || c.conclusion === "UNKNOWN"),
        );
        if (failedChecks.length === 0) {
          return haltDispatch(
            "manual_intervention_required",
            `CI checks block landing but no actionable failure is present: ${evaluation.reason}. Manual intervention required.`,
          );
        }
        log(`[delivery-skill] CI checks failed: ${failedChecks.map((c) => c.name).join(", ")}`);
        if (spentRepairs >= maxRepairs) {
          return haltDispatch(
            "ci_failed_max_repairs",
            `CI failed on checks [${failedChecks.map((c) => c.name).join(", ")}] and reached max repair attempts (${spentRepairs}/${maxRepairs}).`,
          );
        }

        // 提取真实失败日志诊断
        const diagResult = await fetchCiFailureDiagnostics(
          runner,
          context.repo,
          currentHeadSha ?? "",
          failedChecks,
          options.cwd,
        );

        // 区分 infra/permission 失败，避免无效消耗代码修复预算
        if (diagResult.status === "permission_or_infra_failure") {
          return haltDispatch(
            "manual_intervention_required",
            `CI failed or diagnostics retrieval blocked by permission/infrastructure error: ${diagResult.failureReason ?? diagResult.diagnostics.slice(0, 300)}. Check URLs: ${failedChecks.map((c) => c.detailsUrl).filter(Boolean).join(", ")}`,
          );
        }

        // 诊断不可获取时，带真实原因与 check URLs 安全交接，避免无日志盲修
        if (diagResult.status === "unavailable") {
          return haltDispatch(
            "manual_intervention_required",
            `CI checks failed on [${failedChecks.map((c) => c.name).join(", ")}], but failure diagnostics could not be retrieved (${diagResult.failureReason ?? "unknown"}). Check URLs: ${failedChecks.map((c) => c.detailsUrl).filter(Boolean).join(", ")}. Halting for operator intervention.`,
          );
        }

        if (!options.repairCommand) {
          return haltDispatch(
            "ci_failed_max_repairs",
            `CI checks failed on [${failedChecks.map((c) => c.name).join(", ")}], but no repairCommand was provided to execute repair. Diagnostic: ${diagResult.diagnostics.slice(0, 300)}. Halting dispatch.`,
          );
        }

        const reservationTimeout = await totalTimeout("repair reservation");
        if (reservationTimeout) return reservationTimeout;
        spentRepairs++;
        log(`[delivery-skill] Entering repair attempt ${spentRepairs}/${maxRepairs}...`);

        // 在修复副作用执行前立即持久化预算消耗
        await checkpoint("repair_pending");
        const repairPreflightTimeout = await totalTimeout("repair");
        if (repairPreflightTimeout) return repairPreflightTimeout;
        const repairIdentity = `repair:${spentRepairs}`;
        await enterBudgetPhase("repair", repairIdentity);
        const repairTotalTimeout = await totalTimeout("repair");
        if (repairTotalTimeout) return repairTotalTimeout;
        const repairEntryTimeout = await phaseTimeout("repair", repairIdentity);
        if (repairEntryTimeout) return repairEntryTimeout;

        let repairSuccess = false;
        try {
          if (options.repairCommand) {
            log(`[delivery-skill] Executing repair command: ${options.repairCommand}`);
            const repairRes = await runner.exec(
              options.repairCommand,
              options.cwd,
              getRepairTimeoutMs(),
              { SYMPHONY_CI_FAILURE_DIAGNOSTICS: diagResult.diagnostics },
            );
            repairSuccess = repairRes.exitCode === 0;
            if (!repairSuccess) {
              log(`[delivery-skill] Repair command failed (${repairRes.exitCode}): ${repairRes.stderr || repairRes.stdout}`);
            }
          }
        } catch (err) {
          const exhausted = await phaseTimeout("repair", repairIdentity);
          if (exhausted) return exhausted;
          return haltDispatch(
            "ci_failed_max_repairs",
            `Repair attempt ${spentRepairs} failed with exception: ${String(err)}`,
          );
        }

        const repairObservationTimeout = await phaseTimeout("repair", repairIdentity);
        if (repairObservationTimeout) return repairObservationTimeout;

        if (!repairSuccess) {
          return haltDispatch(
            "ci_failed_max_repairs",
            `Repair attempt ${spentRepairs} failed to fix CI failure: ${diagResult.diagnostics.slice(0, 300)}`,
          );
        }
        const completedRepair = await completeBudgetPhase("repair", repairIdentity);
        if (completedRepair) return completedRepair;

        // 修复完成后重新执行项目验证
        if (options.validationCommand) {
          log(`[delivery-skill] Re-running validation command after repair: ${options.validationCommand}`);
          const validationPreflightTimeout = await totalTimeout("repair validation");
          if (validationPreflightTimeout) return validationPreflightTimeout;
          const validationIdentity = `repair:${spentRepairs}`;
          await enterBudgetPhase("validation", validationIdentity);
          const validationTotalTimeout = await totalTimeout("repair validation");
          if (validationTotalTimeout) return validationTotalTimeout;
          const validationEntryTimeout = await phaseTimeout("validation", validationIdentity);
          if (validationEntryTimeout) return validationEntryTimeout;
          const valRes = await runner.exec(options.validationCommand, options.cwd, Math.max(1, Math.min(validationTimeoutMs, phaseRemainingMs("validation", validationIdentity))));
          const validationObservationTimeout = await phaseTimeout("validation", validationIdentity);
          if (validationObservationTimeout) return validationObservationTimeout;
          const validationCompletionTimeout = await totalTimeout("repair validation");
          if (validationCompletionTimeout) return validationCompletionTimeout;
          if (valRes.exitCode !== 0) {
            return haltDispatch(
              "ci_failed_max_repairs",
              `Project validation failed after repair attempt ${spentRepairs}: ${valRes.stderr || valRes.stdout}`,
            );
          }
          const completedValidation = await completeBudgetPhase("validation", validationIdentity);
          if (completedValidation) return completedValidation;
        }

        const postRepairTimeout = await totalTimeout("repair completion");
        if (postRepairTimeout) return postRepairTimeout;
        // 核对是否有代码改动
        const diffCheck = await runner.git(["status", "--porcelain", "--", ...SOURCE_PATHS], options.cwd);
        if (diffCheck.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source status failed: ${diffCheck.stderr}`);
        if (diffCheck.stdout.trim().length === 0) {
          return haltDispatch(
            "ci_failed_max_repairs",
            `Repair attempt ${spentRepairs} produced no new working tree changes. Aborting empty repair loop.`,
          );
        }

        const staged = await stageSourceChanges(runner, options.cwd);
        if (staged.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source staging failed: ${staged.stderr || staged.stdout}`);
        const repairCommitTimeout = await totalTimeout("repair commit");
        if (repairCommitTimeout) return repairCommitTimeout;
        const fixCommitRes = await runner.git(
          ["commit", "--only", "-m", `fix(ci): repair failed checks (attempt ${spentRepairs})`, "--", ...SOURCE_PATHS],
          options.cwd,
        );
        if (fixCommitRes.exitCode !== 0) {
          return haltDispatch("manual_intervention_required", `Failed to commit repair changes: ${fixCommitRes.stderr}`);
        }

        const repairPushTimeout = await totalTimeout("repair push");
        if (repairPushTimeout) return repairPushTimeout;
        const fixPushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
        if (fixPushRes.exitCode !== 0) {
          return haltDispatch("manual_intervention_required", `Failed to push repair commit: ${fixPushRes.stderr}`);
        }

        const newHead = await runner.git(["rev-parse", "HEAD"], options.cwd);
        const newHeadSha = newHead.stdout.trim();
        if (newHeadSha === currentHeadSha) {
          return haltDispatch("ci_failed_max_repairs", "Repair push did not produce a new HEAD SHA.");
        }
        currentHeadSha = newHeadSha;
        log(`[delivery-skill] Pushed repaired commit ${currentHeadSha}. Waiting for new CI run to start...`);

        // New exact HEAD acknowledges the complete repair/commit/push sequence.
        await checkpoint("ci");

        await sleep(Math.min(pollInterval, Math.max(0, (deadlineTimestampMs - now()) / 1000)));
        continue delivery_loop;
      }

      // 6c. Checks Pending -> 等待下一次轮询
      log(`[delivery-skill] CI checks pending (${evaluation.reason}). Waiting ${pollInterval}s... (${elapsedWait}/${maxWaitSeconds}s)`);
      await persistCurrentState();
      if (options.yieldOnWait) return waiting();
      await sleep(Math.min(pollInterval, phaseRemainingMs(ciBudgetPhase, ciBudgetIdentity) / 1000));
    }

    // ----------------------------------------------------
    // Sub-phase 6.2: Independent Review Gate
    // ----------------------------------------------------
    if (!options.reviewGate) {
      if (options.optInLand === true) {
        log("[delivery-skill] Auto-merge requires review gate verification, but no review gate is configured. Refusing auto-merge fail-closed.");
        return haltDispatch(
          "manual_intervention_required",
          "Auto-merge requires review gate verification, but no review gate is configured. Refusing auto-merge fail-closed.",
        );
      }
      log("[delivery-skill] No review gate configured and optInLand is not true. Proceeding to land phase.");
      break delivery_loop;
    }

    const reviewContextTimeout = await totalTimeout("review context");
    if (reviewContextTimeout) return reviewContextTimeout;
    log(`[delivery-skill] Entering Review Gate for PR #${prNumber} @ ${currentHeadSha}...`);

    const reviewTarget: DecisionReviewTarget = {
      repository: context.repo.toLowerCase(),
      prNumber: prNumber!,
      headSha: currentHeadSha!,
    };

    let issueTitle = "";
    let issueBody = "";
    const iv = await runner.gh(
      ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "title,body"],
      options.cwd,
    );
    if (iv.exitCode !== 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to fetch Issue view for #${context.issueNumber}: ${iv.stderr || "exit code " + iv.exitCode}`,
      );
    }
    try {
      const p = JSON.parse(iv.stdout || "{}");
      issueTitle = p.title ?? "";
      issueBody = p.body ?? "";
    } catch (err) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to parse Issue view JSON for #${context.issueNumber}: ${String(err)}`,
      );
    }

    let prTitle = "";
    let prBody = "";
    let baseRefName = "";
    const pv = await runner.gh(
      ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "title,body,headRefOid,baseRefName"],
      options.cwd,
    );
    if (pv.exitCode !== 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to fetch PR view for #${prNumber}: ${pv.stderr || "exit code " + pv.exitCode}`,
      );
    }
    try {
      const p = JSON.parse(pv.stdout || "{}");
      if (p.headRefOid && p.headRefOid !== currentHeadSha) {
        log(`[delivery-skill] PR HEAD (${p.headRefOid}) moved from expected ${currentHeadSha}. Re-entering CI...`);
        currentHeadSha = p.headRefOid;
        continue delivery_loop;
      }
      prTitle = p.title ?? "";
      prBody = p.body ?? "";
      baseRefName = p.baseRefName ?? "";
    } catch (err) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to parse PR view JSON for #${prNumber}: ${String(err)}`,
      );
    }

    // Query verified server base and head SHA via GitHub Pulls API
    let baseSha = "";
    const pullRes = await runner.gh(
      ["api", `repos/${context.repo}/pulls/${prNumber}`],
      options.cwd,
    );
    if (pullRes.exitCode !== 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to fetch PR details via GitHub API for #${prNumber}: ${pullRes.stderr || "exit code " + pullRes.exitCode}`,
      );
    }
    try {
      const pullData = JSON.parse(pullRes.stdout || "{}");
      baseSha = pullData.base?.sha ?? "";
      const apiHeadSha = pullData.head?.sha ?? "";
      if (apiHeadSha && apiHeadSha !== currentHeadSha) {
        log(`[delivery-skill] PR API HEAD (${apiHeadSha}) moved from expected ${currentHeadSha}. Re-entering CI...`);
        currentHeadSha = apiHeadSha;
        continue delivery_loop;
      }
      if (!prTitle) prTitle = pullData.title ?? "";
      if (!prBody) prBody = pullData.body ?? "";
      if (!baseRefName) baseRefName = pullData.base?.ref ?? "";
    } catch (err) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to parse PR API response for #${prNumber}: ${String(err)}`,
      );
    }

    if (!baseSha) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to resolve server base SHA for PR #${prNumber}.`,
      );
    }

    let patch = "";
    const patchFiles: string[] = [];

    // Strictly obtain diff pinned to verified fixed base SHA and head SHA (never query floating branches or floating PR HEAD)
    let diffRes = await runner.git(
      ["diff", `${baseSha}...${currentHeadSha}`],
      options.cwd,
    );
    if (diffRes.exitCode !== 0 || !diffRes.stdout || diffRes.stdout.trim().length === 0) {
      // If local git is missing objects (e.g. shallow clone), attempt fetch of baseSha
      await runner.git(["fetch", "origin", baseSha], options.cwd);
      diffRes = await runner.git(
        ["diff", `${baseSha}...${currentHeadSha}`],
        options.cwd,
      );
    }
    if (diffRes.exitCode !== 0 || !diffRes.stdout || diffRes.stdout.trim().length === 0) {
      // Fallback to GitHub commit compare API pinned strictly to verified baseSha and currentHeadSha
      diffRes = await runner.gh(
        [
          "api",
          `repos/${context.repo}/compare/${baseSha}...${currentHeadSha}`,
          "--header",
          "Accept: application/vnd.github.v3.diff",
        ],
        options.cwd,
      );
    }

    if (diffRes.exitCode !== 0 || !diffRes.stdout || diffRes.stdout.trim().length === 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Failed to obtain commit-pinned diff between base (${baseSha}) and head (${currentHeadSha}) for PR #${prNumber}: ${diffRes.stderr || (diffRes.exitCode !== 0 ? "exit code " + diffRes.exitCode : "commit-pinned diff is empty")}`,
      );
    }

    patch = diffRes.stdout || "";
    const m = patch.match(/^diff --git a\/(.+?) b\//gm);
    if (m) {
      for (const line of m) {
        const f = line.replace(/^diff --git a\//, "").replace(/ b\/.*$/, "");
        if (!patchFiles.includes(f)) patchFiles.push(f);
      }
    }

    // Verify diff integrity: ensure touched files belong to the target commit (or base commit if deleted)
    if (patchFiles.length > 0) {
      for (const f of patchFiles) {
        const inHead = await runner.git(["cat-file", "-e", `${currentHeadSha}:${f}`], options.cwd);
        if (inHead.exitCode !== 0) {
          const inBase = await runner.git(["cat-file", "-e", `${baseSha}:${f}`], options.cwd);
          if (inBase.exitCode !== 0) {
            return haltDispatch(
              "manual_intervention_required",
              `PR diff integrity verification failed: touched file "${f}" does not exist in target commit ${currentHeadSha} or base commit ${baseSha}. Possible floating HEAD or foreign diff detected.`,
            );
          }
        }
      }
    }

    let repositoryInstructions: string | null = null;
    try {
      const agentsRes = await runner.git(["show", `${currentHeadSha}:AGENTS.md`], options.cwd);
      if (agentsRes.exitCode === 0 && agentsRes.stdout) {
        repositoryInstructions = agentsRes.stdout;
      }
    } catch {
      // no AGENTS.md
    }

    const reviewContext: DecisionMaterializedContext = {
      strategy: "materialized",
      workItem: { provider: "github", key: `${context.repo.toLowerCase()}#${context.issueNumber}` },
      repository: context.repo.toLowerCase(),
      issue: {
        repository: context.repo.toLowerCase(),
        number: context.issueNumber,
        title: issueTitle,
        body: issueBody,
      },
      plan: plan ?? null,
      pullRequest: {
        repository: context.repo.toLowerCase(),
        prNumber: prNumber!,
        headSha: currentHeadSha!,
        baseRef: context.baseBranch,
        headRef: context.headBranch,
        title: prTitle,
        body: prBody,
      },
      diff: {
        patch,
        files: patchFiles,
        truncated: false,
      },
      ci: {
        state: "SUCCESS",
        summary: ciReason || "CI checks passed",
        checks: ciPassedChecks.map((c) => ({
          name: c.name,
          status: c.state,
          conclusion: c.conclusion,
          url: c.detailsUrl ?? null,
        })),
      },
      repositoryInstructions,
      previousReviews: [...previousReviews],
      unresolvedFindings: [...unresolvedFindings],
    };

    const sameReviewTarget = continuation?.headSha === currentHeadSha && continuation.prNumber === prNumber;
    const operationKey = (sameReviewTarget ? continuation?.reviewOperationKey : undefined) ?? `delivery-review:${sameReviewTarget ? continuation!.intentId : randomUUID()}:${plan?.taskId ?? "none"}:${plan?.revision ?? 0}`;
    await checkpoint("review_intent", { reviewOperationKey: operationKey });
    const reviewPreflightTimeout = await totalTimeout("review");
    if (reviewPreflightTimeout) return reviewPreflightTimeout;
    await enterBudgetPhase("review", operationKey);
    const reviewTotalTimeout = await totalTimeout("review");
    if (reviewTotalTimeout) return reviewTotalTimeout;
    const reviewEntryTimeout = await phaseTimeout("review", operationKey);
    if (reviewEntryTimeout) return reviewEntryTimeout;
    let reviewTask: DecisionTask;
    try {
      guard();
      reviewTask = await options.reviewGate.ensureReviewTask(
        resolvedSessionId,
        reviewTarget,
        reviewContext,
        { operationKey, reuseCompleted: true, signal: reviewSignal(Math.min(deadlineTimestampMs, budget!.activePhase!.deadlineAtMs)) },
      );
      if (reviewTask.kind !== "review" || reviewTask.sessionId !== resolvedSessionId
        || reviewTask.target.headSha !== currentHeadSha || reviewTask.target.prNumber !== prNumber
        || reviewTask.target.repository.toLowerCase() !== context.repo.toLowerCase()
        || (continuation?.reviewTaskId !== undefined && (continuation.reviewTaskId !== reviewTask.id
          || continuation.reviewRevision !== reviewTask.revision))) {
        return haltDispatch("manual_intervention_required", "Review task identity/revision changed during continuation");
      }
      lastReviewTaskId = reviewTask.id;
      await checkpoint("review_wait", { reviewTaskId: reviewTask.id, reviewRevision: reviewTask.revision });
      log(`[delivery-skill] Ensured ReviewTask: ${reviewTask.id} (status: ${reviewTask.status})`);
    } catch (err) {
      const exhausted = await phaseTimeout("review", operationKey);
      if (exhausted) return exhausted;
      const totalExhausted = await totalTimeout("review task creation");
      if (totalExhausted) return totalExhausted;
      return haltDispatch(
        "manual_intervention_required",
        `Failed to ensure review task for PR #${prNumber} @ ${currentHeadSha}: ${String(err)}`,
      );
    }
    const ensuredReviewTimeout = await phaseTimeout("review", operationKey);
    if (ensuredReviewTimeout) return ensuredReviewTimeout;
    const ensuredTotalTimeout = await totalTimeout("review task creation");
    if (ensuredTotalTimeout) return ensuredTotalTimeout;

    const reviewPollInterval = options.reviewPollIntervalSeconds ?? pollInterval;

    // Review status polling loop
    while (true) {
      const elapsedWait = getElapsedWaitSeconds();
      const reviewTimeout = await phaseTimeout("review", operationKey);
      if (reviewTimeout) return reviewTimeout;
      const totalReviewTimeout = await totalTimeout("review");
      if (totalReviewTimeout) return totalReviewTimeout;

      await persistCurrentState();

      // Invariant check: re-read GitHub's current PR HEAD on each poll
      const headCheckRes = await runner.gh(
        ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "headRefOid"],
        options.cwd,
        Math.max(1, phaseRemainingMs("review", operationKey)),
      );
      const headObservationTimeout = await phaseTimeout("review", operationKey);
      if (headObservationTimeout) return headObservationTimeout;
      const headTotalTimeout = await totalTimeout("review HEAD observation");
      if (headTotalTimeout) return headTotalTimeout;
      if (headCheckRes.exitCode === 0) {
        try {
          const headCheckObj = JSON.parse(headCheckRes.stdout || "{}");
          if (headCheckObj.headRefOid && headCheckObj.headRefOid !== currentHeadSha) {
            log(
              `[delivery-skill] PR HEAD moved from ${currentHeadSha} to ${headCheckObj.headRefOid}. Superseding old review task ${reviewTask.id} and re-entering CI...`,
            );
            if (options.reviewGate.supersedeReviewTask) {
              guard();
              await options.reviewGate.supersedeReviewTask(reviewTask.id, reviewSignal(deadlineTimestampMs));
            }
            currentHeadSha = headCheckObj.headRefOid;
            continue delivery_loop;
          }
        } catch {
          // ignore
        }
      }

      let statusResult: DeliveryReviewStatusResult;
      try {
        statusResult = await options.reviewGate.getReviewStatus(reviewTask.id, reviewSignal(Math.min(deadlineTimestampMs, budget!.activePhase!.deadlineAtMs)));
      } catch (err) {
        guard();
        const exhausted = await phaseTimeout("review", operationKey);
        if (exhausted) return exhausted;
        const totalExhausted = await totalTimeout("review observation");
        if (totalExhausted) return totalExhausted;
        const failures = (continuation?.reviewReadFailures ?? 0) + 1;
        await checkpoint("review_wait", { reviewReadFailures: failures });
        if (!isTransientReadError(err) || failures >= 3) {
          return haltDispatch("manual_intervention_required",
            `Failed to get review status for task ${reviewTask.id}; observations ${failures}/3: ${String(err)}`);
        }
        log(`[delivery-skill] Review read unavailable (${failures}/3): ${String(err)}`);
        if (options.yieldOnWait) return waiting();
        await sleep(Math.min(reviewPollInterval, phaseRemainingMs("review", operationKey) / 1000));
        continue;
      }
      guard();
      const observedReviewTimeout = await phaseTimeout("review", operationKey);
      if (observedReviewTimeout) return observedReviewTimeout;
      const totalReviewObservationTimeout = await totalTimeout("review observation");
      if (totalReviewObservationTimeout) return totalReviewObservationTimeout;
      if (continuation?.reviewReadFailures) await checkpoint("review_wait", { reviewReadFailures: 0 });
      if (statusResult.taskId !== reviewTask.id) {
        return haltDispatch("manual_intervention_required", "Review status identity changed during continuation");
      }

      if (statusResult.status === "completed") {
        const reviewResult = statusResult.result;
        if (!reviewResult || reviewResult.kind !== "review") {
          return haltDispatch(
            "manual_intervention_required",
            `Review task ${reviewTask.id} completed with missing or malformed review result.`,
          );
        }

        if (reviewResult.sessionId !== resolvedSessionId || reviewResult.taskId !== reviewTask.id || reviewResult.revision !== reviewTask.revision
          || reviewResult.target.headSha !== currentHeadSha || reviewResult.target.prNumber !== prNumber
          || reviewResult.target.repository.toLowerCase() !== context.repo.toLowerCase()) {
          return haltDispatch("manual_intervention_required", "Review result identity/target changed during continuation");
        }
        await checkpoint("result_observed", { verdict: reviewResult.verdict });

        // Case A: Approved
        if (reviewResult.verdict === "approve") {
          if (reviewResult.target.headSha !== currentHeadSha) {
            return haltDispatch(
              "manual_intervention_required",
              `Review approved SHA (${reviewResult.target.headSha}) does not match current PR HEAD SHA (${currentHeadSha}). Re-review required.`,
            );
          }

          const approvalVerify = await options.reviewGate.verifyReviewApproval({
            ...reviewTarget,
            sessionId: resolvedSessionId,
            requirements: {
              title: issueTitle,
              body: issueBody,
            },
          }, reviewSignal(Math.min(deadlineTimestampMs, budget!.activePhase!.deadlineAtMs)));
          const approvalTimeout = await phaseTimeout("review", operationKey);
          if (approvalTimeout) return approvalTimeout;
          const approvalTotalTimeout = await totalTimeout("review approval verification");
          if (approvalTotalTimeout) return approvalTotalTimeout;
          if (!approvalVerify.approved) {
            return haltDispatch(
              "manual_intervention_required",
              `Review approval verification failed: ${approvalVerify.reason}`,
            );
          }

          log(`[delivery-skill] Review approved for HEAD ${currentHeadSha}! Proceeding to land.`);
          break delivery_loop;
        }

        // Case B: Changes requested
        if (reviewResult.verdict === "changes_requested") {
          previousReviews.push(reviewResult);
          unresolvedFindings = [...(reviewResult.findings ?? [])];
          const findings = reviewResult.findings ?? [];
          const findingSummary = findings
            .map((f) => `[${f.severity.toUpperCase()}] ${f.location ? f.location + ": " : ""}${f.message}`)
            .join("\n");
          log(`[delivery-skill] Review requested changes:\n${findingSummary}`);

          if (spentRepairs >= maxRepairs) {
            return haltDispatch(
              "review_changes_requested_max_repairs",
              `Review requested changes:\n${findingSummary}\nReached max repair attempts (${spentRepairs}/${maxRepairs}).`,
            );
          }

          if (!options.repairCommand) {
            return haltDispatch(
              "review_changes_requested_max_repairs",
              `Review requested changes:\n${findingSummary}\nNo repairCommand provided to execute repair. Halting dispatch.`,
            );
          }

          const reservationTimeout = await totalTimeout("review repair reservation");
          if (reservationTimeout) return reservationTimeout;
          spentRepairs++;
          log(`[delivery-skill] Entering repair attempt ${spentRepairs}/${maxRepairs} for review feedback...`);
          await checkpoint("repair_pending");
          const repairPreflightTimeout = await totalTimeout("review repair");
          if (repairPreflightTimeout) return repairPreflightTimeout;
          const repairIdentity = `repair:${spentRepairs}`;
          await enterBudgetPhase("repair", repairIdentity);
          const repairTotalTimeout = await totalTimeout("review repair");
          if (repairTotalTimeout) return repairTotalTimeout;
          const repairEntryTimeout = await phaseTimeout("repair", repairIdentity);
          if (repairEntryTimeout) return repairEntryTimeout;

          let repairSuccess = false;
          try {
            if (options.repairCommand) {
              log(`[delivery-skill] Executing repair command for review: ${options.repairCommand}`);
              const repRes = await runner.exec(
                options.repairCommand,
                options.cwd,
                getRepairTimeoutMs(),
                { SYMPHONY_REVIEW_FINDINGS: findingSummary },
              );
              repairSuccess = repRes.exitCode === 0;
              if (!repairSuccess) {
                log(`[delivery-skill] Repair command failed (${repRes.exitCode}): ${repRes.stderr || repRes.stdout}`);
              }
            }
          } catch (err) {
            const exhausted = await phaseTimeout("repair", repairIdentity);
            if (exhausted) return exhausted;
            return haltDispatch(
              "review_changes_requested_max_repairs",
              `Repair attempt ${spentRepairs} failed with exception: ${String(err)}`,
            );
          }

          const repairObservationTimeout = await phaseTimeout("repair", repairIdentity);
          if (repairObservationTimeout) return repairObservationTimeout;

          if (!repairSuccess) {
            return haltDispatch(
              "review_changes_requested_max_repairs",
              `Repair attempt ${spentRepairs} failed to address review findings:\n${findingSummary}`,
            );
          }
          const completedRepair = await completeBudgetPhase("repair", repairIdentity);
          if (completedRepair) return completedRepair;

          if (options.validationCommand) {
            log(`[delivery-skill] Re-running validation command after review repair: ${options.validationCommand}`);
            const validationPreflightTimeout = await totalTimeout("review repair validation");
            if (validationPreflightTimeout) return validationPreflightTimeout;
            const validationIdentity = `repair:${spentRepairs}`;
            await enterBudgetPhase("validation", validationIdentity);
            const validationTotalTimeout = await totalTimeout("review repair validation");
            if (validationTotalTimeout) return validationTotalTimeout;
            const validationEntryTimeout = await phaseTimeout("validation", validationIdentity);
            if (validationEntryTimeout) return validationEntryTimeout;
            const valRes = await runner.exec(options.validationCommand, options.cwd, Math.max(1, Math.min(validationTimeoutMs, phaseRemainingMs("validation", validationIdentity))));
            const validationObservationTimeout = await phaseTimeout("validation", validationIdentity);
            if (validationObservationTimeout) return validationObservationTimeout;
            const validationCompletionTimeout = await totalTimeout("review repair validation");
            if (validationCompletionTimeout) return validationCompletionTimeout;
            if (valRes.exitCode !== 0) {
              return haltDispatch(
                "review_changes_requested_max_repairs",
                `Project validation failed after review repair attempt ${spentRepairs}: ${valRes.stderr || valRes.stdout}`,
              );
            }
            const completedValidation = await completeBudgetPhase("validation", validationIdentity);
            if (completedValidation) return completedValidation;
          }

          const postRepairTimeout = await totalTimeout("review repair completion");
          if (postRepairTimeout) return postRepairTimeout;
          const diffCheck = await runner.git(["status", "--porcelain", "--", ...SOURCE_PATHS], options.cwd);
          if (diffCheck.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source status failed: ${diffCheck.stderr}`);
          if (diffCheck.stdout.trim().length === 0) {
            return haltDispatch(
              "review_changes_requested_max_repairs",
              `Repair attempt ${spentRepairs} produced no new working tree changes. Aborting empty repair loop.`,
            );
          }

          const staged = await stageSourceChanges(runner, options.cwd);
          if (staged.exitCode !== 0) return haltDispatch("manual_intervention_required", `Git source staging failed: ${staged.stderr || staged.stdout}`);
          const repairCommitTimeout = await totalTimeout("review repair commit");
          if (repairCommitTimeout) return repairCommitTimeout;
          const fixCommitRes = await runner.git(
            ["commit", "--only", "-m", `fix(review): address review findings (attempt ${spentRepairs})`, "--", ...SOURCE_PATHS],
            options.cwd,
          );
          if (fixCommitRes.exitCode !== 0) {
            return haltDispatch("manual_intervention_required", `Failed to commit repair changes: ${fixCommitRes.stderr}`);
          }

          const repairPushTimeout = await totalTimeout("review repair push");
          if (repairPushTimeout) return repairPushTimeout;
          const fixPushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
          if (fixPushRes.exitCode !== 0) {
            return haltDispatch("manual_intervention_required", `Failed to push repair commit: ${fixPushRes.stderr}`);
          }

          const newHead = await runner.git(["rev-parse", "HEAD"], options.cwd);
          const newHeadSha = newHead.stdout.trim();
          if (newHeadSha === currentHeadSha) {
            return haltDispatch("review_changes_requested_max_repairs", "Repair push did not produce a new HEAD SHA.");
          }

          if (options.reviewGate.supersedeReviewTask) {
            guard();
              await options.reviewGate.supersedeReviewTask(reviewTask.id, reviewSignal(deadlineTimestampMs));
          }

          currentHeadSha = newHeadSha;
          log(`[delivery-skill] Pushed repaired commit ${currentHeadSha}. Re-entering CI and review loop...`);

          await checkpoint("ci");
          if (options.yieldOnWait) return waiting();
          await sleep(Math.min(pollInterval, Math.max(0, (deadlineTimestampMs - now()) / 1000)));
          continue delivery_loop;
        }

        // Case C: Needs human
        if (reviewResult.verdict === "needs_human") {
          const findingSummary = reviewResult.findings?.map((f) => f.message).join("; ") || "Reviewer requested human intervention.";
          return haltDispatch(
            "review_needs_human",
            `Review determined human intervention is required: ${findingSummary}`,
          );
        }

        return haltDispatch(
          "manual_intervention_required",
          `Unexpected review verdict: ${String((reviewResult as { verdict?: string }).verdict)}`,
        );
      }

      if (statusResult.status === "failed" || statusResult.status === "cancelled" || statusResult.status === "superseded") {
        return haltDispatch(
          "manual_intervention_required",
          `Review task ${reviewTask.id} entered ${statusResult.status} state: ${statusResult.error ?? "no error details"}. Halting dispatch.`,
        );
      }

      log(`[delivery-skill] Review status: ${statusResult.status}. Waiting ${reviewPollInterval}s... (${elapsedWait}/${maxWaitSeconds}s)`);
      await persistCurrentState();
      if (options.yieldOnWait) return waiting();
      await sleep(Math.min(reviewPollInterval, phaseRemainingMs("review", operationKey) / 1000));
    }
  }

  // ==========================================
  // Phase 7: Land Evaluation & Squash Merge
  // ==========================================
  log("[delivery-skill] Phase 7: Land evaluation & squash merge...");
  const landEvaluationTimeout = await totalTimeout("land evaluation");
  if (landEvaluationTimeout) return landEvaluationTimeout;

  // 默认绝不自动 land，必须显式 optInLand
  if (options.optInLand !== true) {
    log("[delivery-skill] optInLand is not true. PR is green and ready to land. Skipping merge.");
    await checkpoint("ready");
    return {
      status: "ready_to_land",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      reviewTaskId: lastReviewTaskId,
      spentRepairs,
      spentWaitSeconds: getElapsedWaitSeconds(),
      reason: "ci_green_opt_in_disabled",
    };
  }

  if (prNumber === null) {
    return haltDispatch("manual_intervention_required", "Cannot land without PR number.");
  }

  if (!options.reviewGate) {
    return haltDispatch(
      "manual_intervention_required",
      "Auto-merge requires review gate verification, but no review gate is configured. Refusing auto-merge fail-closed.",
    );
  }

  // Pre-merge verification: re-read full PR state immediately before merge
  const preMergePrRes = await runner.gh(
    ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "headRefOid,mergeable,state,isDraft,body,statusCheckRollup"],
    options.cwd,
  );
  if (preMergePrRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to query PR #${prNumber} state before merge: ${preMergePrRes.stderr}`);
  }
  let preMergePr: {
    headRefOid?: string;
    mergeable?: string;
    state?: string;
    isDraft?: boolean;
    body?: string;
    statusCheckRollup?: unknown[];
  };
  try {
    preMergePr = JSON.parse(preMergePrRes.stdout || "{}");
  } catch (err) {
    return haltDispatch("unmergeable", `Failed to parse PR #${prNumber} state response: ${String(err)}`);
  }

  // 1. Verify PR state and draft status
  if (preMergePr.state !== "OPEN") {
    return haltDispatch("unmergeable", `PR state changed to '${preMergePr.state}' before merge.`);
  }
  if (preMergePr.isDraft) {
    return haltDispatch("unmergeable", "PR was switched to draft mode before merge.");
  }

  // 2. Verify PR HEAD unchanged
  if (preMergePr.headRefOid !== currentHeadSha) {
    return haltDispatch(
      "manual_intervention_required",
      `PR head commit changed before merge: expected ${currentHeadSha}, current is ${preMergePr.headRefOid}.`,
    );
  }

  // 3. Verify PR delivery ownership marker intact
  const ownershipCheck = validatePrOwnership(preMergePr.body ?? "", context);
  if (!ownershipCheck.valid) {
    return haltDispatch(
      "foreign_pr_conflict",
      `PR ownership validation failed before merge: ${ownershipCheck.reason}`,
    );
  }

  // 4. Re-evaluate CI check policy on fresh statusCheckRollup
  const freshRollup = Array.isArray(preMergePr.statusCheckRollup) ? preMergePr.statusCheckRollup : [];
  const freshParsedChecks = parsePrCheckRollup(freshRollup, effectiveRequiredChecks);
  const freshRequiredPrChecks: PrCheck[] = (effectiveRequiredChecks ?? []).map((requiredName) => {
    const observed = freshParsedChecks.find((c) => c.name === requiredName);
    return (
      observed ?? {
        name: requiredName,
        state: "PENDING",
        conclusion: null,
        isRequired: true,
        detailsUrl: null,
      }
    );
  });
  const freshCiEvaluation = evaluateChecksAutoMergePolicy(freshRequiredPrChecks, freshParsedChecks);
  if (!freshCiEvaluation.canAutoMerge) {
    return haltDispatch(
      "manual_intervention_required",
      `Pre-merge CI check policy re-evaluation failed: ${freshCiEvaluation.reason}`,
    );
  }

  // Only confirmed conflicts qualify; all other unmergeable facts retain their refusal.
  if (preMergePr.mergeable !== "MERGEABLE" && preMergePr.mergeable !== "CONFLICTING") {
    return haltDispatch("unmergeable", `PR #${prNumber} mergeable state is '${preMergePr.mergeable}', expected 'MERGEABLE'.`);
  }

  // 6. Pre-merge verification of review approval. The current Issue facts are
  // required for drift verification: an unreadable or malformed Issue must block
  // the merge rather than silently reuse a stale approval.
  const preMergeIv = await runner.gh(
    ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "title,body"],
    options.cwd,
  );
  if (preMergeIv.exitCode !== 0) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to fetch Issue view for #${context.issueNumber} before merge: ${preMergeIv.stderr || "exit code " + preMergeIv.exitCode}`,
    );
  }
  let latestTitle = "";
  let latestBody = "";
  try {
    const p = JSON.parse(preMergeIv.stdout || "{}");
    latestTitle = p.title ?? "";
    latestBody = p.body ?? "";
  } catch (err) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to parse Issue view JSON for #${context.issueNumber} before merge: ${String(err)}`,
    );
  }
  if (latestTitle === "") {
    return haltDispatch(
      "manual_intervention_required",
      `Issue #${context.issueNumber} returned an empty title before merge; cannot verify requirements drift.`,
    );
  }

  const preMergeApproval = await options.reviewGate.verifyReviewApproval({
    repository: context.repo.toLowerCase(),
    prNumber: prNumber,
    headSha: currentHeadSha ?? "",
    sessionId: resolvedSessionId,
    requirements: { title: latestTitle, body: latestBody },
  }, reviewSignal(deadlineTimestampMs));
  const preMergeBudgetTimeout = await totalTimeout("pre-merge approval");
  if (preMergeBudgetTimeout) return preMergeBudgetTimeout;
  if (!preMergeApproval.approved) {
    return haltDispatch(
      "manual_intervention_required",
      `Pre-merge review gate verification failed: ${preMergeApproval.reason}`,
    );
  }

  if (preMergePr.mergeable === "CONFLICTING") {
    try {
      if (!stateStorage || !options.validationCommand) {
        throw new Error("merge_conflict_executor_or_durable_validation_unavailable");
      }
      if (spentRepairs >= maxRepairs) throw new Error(`merge_conflict_budget_exhausted (${spentRepairs}/${maxRepairs})`);
      if (now() >= deadlineTimestampMs!) throw new Error("merge_conflict_deadline_exhausted");
      const observed = await prepareRepairTarget(runner, options.cwd, context, prNumber, currentHeadSha!, readRemoteBranch, conflictRepairOptions().timeout);
      if (landing) {
        if (landing.phase !== "intent" || landing.prNumber !== prNumber || landing.headSha !== currentHeadSha) {
          throw new Error("merge_conflict_landing_outcome_unverified");
        }
        // Authoritative owned OPEN + null mergeCommit proves the legacy intent
        // did not land. Do not clear it on a failed or ambiguous observation.
        landing = undefined;
      }
      await assertRepairWorkspace(runner, options.cwd, currentHeadSha!, conflictRepairOptions().timeout);
      spentRepairs++;
      mergeConflictRepair = { cause: "merge_conflict", operationId: randomUUID(), attempt: spentRepairs,
        prNumber, expectedHeadSha: currentHeadSha!, baseSha: observed.remoteBaseSha, phase: "reserved" };
      await checkpoint("repair_pending");
      await enterBudgetPhase("repair", `repair:${spentRepairs}`);
      const conflictTotalTimeout = await totalTimeout("merge-conflict repair");
      if (conflictTotalTimeout) return conflictTotalTimeout;
      const conflictPhaseTimeout = await phaseTimeout("repair", `repair:${spentRepairs}`);
      if (conflictPhaseTimeout) return conflictPhaseTimeout;
      log(`[delivery-skill] merge_conflict repair ${spentRepairs}/${maxRepairs}: HEAD=${currentHeadSha}, base=${observed.remoteBaseSha}`);
      currentHeadSha = await executeMergeConflictRepair(conflictRepairOptions());
      if (lastReviewTaskId && options.reviewGate.supersedeReviewTask) {
        guard();
        await options.reviewGate.supersedeReviewTask(lastReviewTaskId, reviewSignal(deadlineTimestampMs));
      }
      await checkpoint("ci");
      log(`[delivery-skill] Conflict repair pushed ${currentHeadSha}; requiring new CI and exact-HEAD review.`);
      if (options.yieldOnWait) return waiting();
      continue landing_loop;
    } catch (error) {
      if (mergeConflictRepair) mergeConflictRepair = { ...mergeConflictRepair, outcome: String(error) };
      const phase = budget?.activePhase;
      if (phase && ["repair", "validation"].includes(phase.phase)) { const exhausted = await phaseTimeout(phase.phase, phase.identity); if (exhausted) return exhausted; }
      const exhausted = await totalTimeout("merge-conflict repair");
      if (exhausted) return exhausted;
      return haltDispatch("manual_intervention_required", String(error));
    }
  }

  const landingTimeout = await totalTimeout("landing");
  if (landingTimeout) return landingTimeout;
  if (!landing || landing.headSha !== currentHeadSha || landing.prNumber !== prNumber) {
    landing = { intentId: randomUUID(), context, prNumber, headSha: currentHeadSha ?? "", optIn: true, phase: "intent" };
  }
  await persistCurrentState();

  const mergeTimeout = await totalTimeout("merge");
  if (mergeTimeout) return mergeTimeout;

  // 执行 squash merge
  const mergeArgs = ["pr", "merge", String(prNumber), "--repo", context.repo, "--squash"];
  if (currentHeadSha) {
    mergeArgs.push("--match-head-commit", currentHeadSha);
  }

  // A timeout may follow a successful merge: always observe before deciding.
  try { await runner.gh(mergeArgs, options.cwd); } catch { /* preserve intent; read below */ }

  // 严格验证 PR 终态是否确实为 MERGED
  const verifyRes = await runner.gh(
    ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "state,mergeCommit"],
    options.cwd,
  );
  if (verifyRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to query PR #${prNumber} state after merge: ${verifyRes.stderr}`);
  }

  let mergeSha: string | null = null;
  try {
    const verified = JSON.parse(verifyRes.stdout || "{}");
    if (verified.state !== "MERGED") {
      return haltDispatch("unmergeable", `PR #${prNumber} state after merge is '${verified.state}', expected 'MERGED'.`);
    }
    mergeSha = (verified.mergeCommit?.oid as string | undefined) ?? null;
  } catch (err) {
    return haltDispatch("unmergeable", `Failed to parse post-merge verification response: ${String(err)}`);
  }

  if (!mergeSha) return haltDispatch("reconciliation_needed", "Merged state lacks a verified merge commit; preserve landing intent");
  landing = { ...landing, phase: "observed", mergeCommitSha: mergeSha };
  await persistCurrentState();

  // 核对关联 Issue 是否已自动关闭
  const issueVerifyRes = await runner.gh(
    ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "state"],
    options.cwd,
  );
  let issueClosed = false;
  if (issueVerifyRes.exitCode === 0) {
    try {
      const issueObj = JSON.parse(issueVerifyRes.stdout || "{}");
      issueClosed = issueObj.state === "CLOSED";
    } catch {
      // ignore
    }
  }

  // 记录完成状态
  await persistCurrentState({ isPaused: false });

  if (!issueClosed) {
    log(`[delivery-skill] Warning: PR #${prNumber} is merged, but issue #${context.issueNumber} remains open. Halting dispatch for reconciliation...`);
    return haltDispatch(
      "reconciliation_needed",
      `PR #${prNumber} was successfully squash merged (merge commit: ${mergeSha ?? "unknown"}), but issue #${context.issueNumber} remains open or could not be verified as closed. Requires reconciliation or manual closure.`,
    );
  }

  log(`[delivery-skill] Successfully landed PR #${prNumber}! Merge commit: ${mergeSha ?? "verified"}. Issue #${context.issueNumber} closed.`);
  return {
    status: "completed",
    prNumber,
    prUrl,
    headSha: currentHeadSha,
    mergeSha,
    reviewTaskId: lastReviewTaskId,
    spentRepairs,
    spentWaitSeconds: getElapsedWaitSeconds(),
    reason: "successfully_merged",
  };
  }
}
