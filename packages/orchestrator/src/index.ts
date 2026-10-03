/**
 * @symphony/orchestrator — SPEC §7 Orchestration State Machine、
 * §8 Polling / Scheduling / Reconciliation、§14 Failure Model 的
 * owner 包（§3 的 Orchestrator）。
 *
 * 本文件是包的唯一公共 API 面（下游包与测试都从这里 import）。
 *
 * M5.1 落地 **纯调度内核**（无副作用）：runtime state 初始化、active / terminal
 * state 判断、required-label matching、`issue_routable`、dispatch eligibility、
 * claim / running gating、global / per-state 并发 slot、stable dispatch sort，以及
 * retry / backoff 纯数学 helper。不 fetch tracker、不 spawn worker、不调用
 * workspace cleanup、不解释 agent / Codex 协议。
 *
 * M5.2 落地 **dispatch + worker lifecycle**：{@link OrchestratorAuthority} 是单一
 * 写入者，`dispatchIssue()` 在 `claimed` + `running` 双检查后原子提交，经
 * {@link WorkerControl} 驱动 `runAgentAttempt()`，并把稳定 AgentEvent 归约进
 * `LiveSession` / `codex_totals` / rate limits，最后用统一 outcome 入口做终态分类。
 *
 * M5.3 落地 **retry 队列 / timer 所有权 / backoff 决策**：worker 终态按 `retryKind`
 * 建立完整 `RetryEntry`（normal → attempt 1 / 1s；failure → `min(10000 * 2^(attempt-1),
 * max_retry_backoff_ms)`），同 issue 新 retry 取消 / 替换旧 timer；timer 到期执行
 * SPEC §16.6 `on_retry_timer` 的 refresh → missing / terminal（安全 cleanup）/ inactive /
 * unroutable / slot 不足 / 重新 dispatch 全分支。retry timer 回调只提交带
 * issueId + retry token 的到期事件，迟到 / 已取消回调被 ownership token 隔离。
 *
 * M5.4 落地 **active-run reconciliation / stall detection / terminal cleanup /
 * startup terminal sweep**（SPEC §7.3 / §7.4、§8.5 / §8.6、§14.2 / §14.3、§16.3、
 * §17.4）：{@link OrchestratorAuthority.reconcileRunningIssues} 先按 UTC 时钟域做
 * stall 判定（`stall_timeout_ms <= 0` 禁用、仅 `elapsed > timeout` 触发），再对剩余
 * running 做一次批量 `fetchIssuesByIds`，按 terminal / active+routable / 其余分支
 * 更新 snapshot 或 stop（terminal 在停止后安全 cleanup）；refresh 失败保留 worker。
 * startup sweep（{@link OrchestratorAuthority.runStartupTerminalCleanup}）按 terminal
 * states 拉取并逐 identifier 经真实 workspace 端口清理，fetch / 单项失败都只记诊断。
 * cleanup 端口从 retry 选项提升为 authority 顶层能力，并由 per-issue 收尾屏障与后续
 * refresh / launch 串行化。纯判定见 `reconciliation.ts`。
 *
 * 边界约束（根 `AGENTS.md`）：本包是唯一的 coordination 层 —— tracker /
 * workspace / agent 不得反向持有调度或 retry 策略。orchestration state mutation
 * 只经本包 API。
 *
 * M5.5 落定 **poll loop / startup 编排 / per-tick 失败降级 / live config re-apply /
 * stop lifecycle**（SPEC §8.1、§14.2 / §14.3 / §14.4、§16.1 / §16.2）：
 * {@link OrchestratorLoop} 管理单 timer 链（tick 结束后按最新 interval 安排下一次，
 * 不用 `setInterval`）、严格 tick 顺序（reconcile → preflight → fetch → sort →
 * dispatch until slots exhausted）、per-tick 失败降级（validation / fetch 失败跳过本
 * tick 但服务存活）、startup fail-fast 与 immediate first tick，以及幂等 stop。
 * {@link OrchestratorAuthority.applyEffectiveSchedulingConfig} 提供 live config
 * 原子 apply，{@link OrchestratorAuthority.shutdown} 提供全局关停（使在途 retry
 * ownership 失效、停止 workers、不遗留 timer）。M5.6 以真实 WORKFLOW、tracker registry、本地 fixture、
 * temp filesystem 与 fake app-server subprocess 收口 §17.4 Core Conformance。
 */

export { createInitialCodexTotals, createOrchestratorRuntimeState } from "./runtime-state";
export type { OrchestratorRuntimeStateInit } from "./runtime-state";

export {
  globalAvailableSlots,
  hasRequiredDispatchFields,
  isActiveState,
  isDispatchEligible,
  isRetryDispatchAllowed,
  isTerminalState,
  issueRoutable,
  matchesRequiredLabels,
  normalizeLabel,
  perStateAvailableSlots,
  runningCountForState,
} from "./eligibility";
export type { DispatchPolicy } from "./eligibility";

export { compareForDispatch, sortForDispatch } from "./sort";

export {
  CONTINUATION_RETRY_DELAY_MS,
  FAILURE_RETRY_BASE_DELAY_MS,
  continuationRetryDelayMs,
  failureRetryDelayMs,
} from "./backoff";

// --- M5.3：retry 队列 / timer 所有权 / backoff 决策（SPEC §8.4、§14.2、§16.6）---

export { RETRY_MAX_TIMER_DELAY_MS, createRetryScheduler } from "./retry";
export type {
  RetryDelayKind,
  RetryDiagnostic,
  RetryOptions,
  RetryScheduler,
  RetryWorkspaceCleanup,
  RetryWorkspaceCleanupResult,
} from "./retry";

// --- M5.2：dispatch + worker lifecycle（SPEC §7.3 / §7.4、§16.4 / §16.5）---

export { WorkerControl } from "./worker";
export type {
  WorkerHandle,
  WorkerStopReason,
  WorkerStopReasonKind,
  WorkerTerminalOutcome,
} from "./worker";

export { applyAgentEvent, createAgentTelemetryState } from "./agent-events";
export type { AgentTelemetryState } from "./agent-events";

export { classifyError, classifyStop, classifySuccess } from "./outcome";
export type { TerminalClassification } from "./outcome";

export { createTrackerRefreshContinuationDecider } from "./continuation-policy";
export type {
  TrackerRefreshContinuationOptions,
  TrackerRefreshSource,
} from "./continuation-policy";

// --- M5.4：reconciliation / stall / terminal cleanup / startup sweep
//     （SPEC §7.3 / §7.4、§8.5 / §8.6、§14.2 / §14.3、§16.3、§17.4）---

export {
  decideReconciliationAction,
  isStallDetectionEnabled,
  isWorkerStalled,
  stallActivityBaselineMs,
  stallElapsedMs,
} from "./reconciliation";
export type {
  ReconciliationDecision,
  ReconciliationResult,
  StartupCleanupResult,
  TerminalIssueSource,
} from "./reconciliation";

export { OrchestratorAuthority } from "./authority";
export type {
  AgentAttemptRunner,
  AttemptContext,
  AttemptOptionsFactory,
  DispatchResult,
  OrchestratorAuthorityOptions,
  RetryScheduleRequest,
} from "./authority";

// --- M5.5：poll loop / startup / per-tick 降级 / live config re-apply / stop
//     （SPEC §8.1、§14.2 / §14.3 / §14.4、§16.1 / §16.2）---

export { OrchestratorLoop, OrchestratorStartupError } from "./loop";
export type {
  CandidateIssueSource,
  DispatchPreflightResult,
  DispatchPreflightSource,
  EffectiveSchedulingConfig,
  LoopDiagnostic,
  OrchestratorLoopOptions,
  PollScheduler,
} from "./loop";

export type { OrchestratorEvent, RetryEventReason } from "./events";
