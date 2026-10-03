/**
 * Active-run reconciliation 与 stall detection 的纯判定内核（SPEC §7.3 "Poll Tick" /
 * "Reconciliation State Refresh" / "Stall Timeout"、§7.4、§8.5、§14.2、§16.3、
 * §17.4，M5.4 / NEST-77）。
 *
 * 本模块只做**无副作用的判定**：stall 是否触发、刷新回来的 snapshot 该走哪个分支。
 * 真正的 worker stop、issue snapshot 更新、workspace cleanup 全部由
 * {@link OrchestratorAuthority} 串行提交——本模块不 fetch tracker、不 spawn worker、
 * 不碰 filesystem、不 import 任何调度状态。
 *
 * 时钟口径（§8.5 Part A / §13.5）：elapsed 基准是**同一 UTC 墙上时钟域**的
 * "最后一次 agent event 时间戳，否则 worker 启动时间"。单调时钟只用于运行时长与
 * retry `dueAtMs`，不得参与这里的减法。
 */
import type { Issue, RunningEntry, UtcTimestampMs } from "@symphony/domain";

import type { AgentTelemetryState } from "./agent-events";
import { isActiveState, isTerminalState, issueRoutable, type DispatchPolicy } from "./eligibility";

/**
 * 刷新回来的 snapshot 对应的 running 处理分支（SPEC §8.5 Part B / §16.3）：
 *
 * - `refresh_snapshot`：active 且 routable → 只更新 running entry 的 issue snapshot；
 * - `stop`：active 但不再 routable、或既非 active 也非 terminal → 停止 worker，**不清理**
 *   workspace；
 * - `stop_and_cleanup`：terminal → 停止 worker 后安全清理 workspace。
 */
export type ReconciliationDecision = "refresh_snapshot" | "stop" | "stop_and_cleanup";

/**
 * 判定一个刷新回来的 issue 属于哪个 reconciliation 分支。
 *
 * 判定顺序与 SPEC §16.3 一致：**terminal 优先**（terminal 也必然不是 active），
 * 其次 active ∧ routable，其余一律 stop-without-cleanup。
 */
export function decideReconciliationAction(
  issue: Issue,
  policy: DispatchPolicy,
): ReconciliationDecision {
  if (isTerminalState(issue.state, policy)) {
    return "stop_and_cleanup";
  }
  if (isActiveState(issue.state, policy) && issueRoutable(issue, policy)) {
    return "refresh_snapshot";
  }
  return "stop";
}

/** stall 检测是否启用（`stall_timeout_ms <= 0` 或非有限值 → 禁用，§8.5 Part A）。 */
export function isStallDetectionEnabled(stallTimeoutMs: number): boolean {
  return Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0;
}

/**
 * stall elapsed 的基准时刻（UTC）：有 agent event 时取最近一次事件时间戳，否则取
 * worker 启动时间（§8.5 Part A）。
 *
 * 身份未齐时 `entry.session` 可能尚未物化，因此必须回退到 per-attempt 遥测里暂存的
 * `pendingLastTimestamp`——只读 `entry.session` 会漏掉握手期事件，把活跃 worker 误判
 * 为 stall。`RunAttempt.startedAt` 与事件时间戳同属 UTC 墙上时钟域。
 */
export function stallActivityBaselineMs(
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
): UtcTimestampMs {
  const sessionTimestamp = entry.session?.lastCodexTimestamp ?? null;
  return sessionTimestamp ?? telemetry.pendingLastTimestamp ?? entry.attempt.startedAt;
}

/** 当前 stall elapsed（毫秒）：`max(now - baseline, 0)`（负差值按 0 处理）。 */
export function stallElapsedMs(
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  nowUtc: UtcTimestampMs,
): number {
  return Math.max(0, nowUtc - stallActivityBaselineMs(entry, telemetry));
}

/**
 * 该 running worker 是否已 stall：仅在**严格大于**阈值时触发（`elapsed == timeout`
 * 不触发），且 `stallTimeoutMs <= 0` / 非有限值时整个检测禁用。
 */
export function isWorkerStalled(
  entry: RunningEntry,
  telemetry: AgentTelemetryState,
  nowUtc: UtcTimestampMs,
  stallTimeoutMs: number,
): boolean {
  if (!isStallDetectionEnabled(stallTimeoutMs)) {
    return false;
  }
  return stallElapsedMs(entry, telemetry, nowUtc) > stallTimeoutMs;
}

/** {@link OrchestratorAuthority.reconcileRunningIssues} 的世界结果。 */
export interface ReconciliationResult {
  /** 本次参与刷新判定的 running issue id 快照（stall 已移除的不含在内）。 */
  readonly scannedIssueIds: readonly string[];
  /** 触发 stall 并被终止的 issue id。 */
  readonly stalledIssueIds: readonly string[];
  /** 因刷新结果被终止（stop）的 issue id（含 terminal / inactive / missing）。 */
  readonly stoppedIssueIds: readonly string[];
  /** 因 terminal 而被安全清理 workspace 的 issue id。 */
  readonly cleanedIssueIds: readonly string[];
  /** 因 active + routable 而更新了 issue snapshot 的 issue id。 */
  readonly updatedIssueIds: readonly string[];
  /** tracker 批量 refresh 失败（保留 worker，下一 tick 重试）。 */
  readonly refreshFailed: boolean;
}

/**
 * tracker 的 startup terminal sweep 读取能力（SPEC §8.6 / §11.1.1
 * `fetch_issues_by_states`）。
 *
 * 与 ID refresh 分开表达：startup sweep 需要按 terminal states 拉取，而 retry /
 * reconciliation 用 ID refresh。组合根（M5.5）用同一个 tracker 同时提供两者。
 */
export interface TerminalIssueSource {
  fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]>;
}

/** {@link OrchestratorAuthority.runStartupTerminalCleanup} 的世界结果。 */
export interface StartupCleanupResult {
  /** 因 tracker 未提供 `fetchIssuesByStates` 而未执行。 */
  readonly unavailable: boolean;
  /** terminal issues fetch 失败（不阻止服务启动）。 */
  readonly fetchFailed: boolean;
  /** 成功删除的 identifier。 */
  readonly removed: readonly string[];
  /** 目录本就不存在（幂等成功）的 identifier。 */
  readonly missing: readonly string[];
  /** 安全边界拒绝删除的 identifier。 */
  readonly refused: readonly string[];
  /** filesystem 删除失败的 identifier。 */
  readonly failed: readonly string[];
}
