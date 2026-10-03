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
 * 边界约束（根 `AGENTS.md`）：本包是唯一的 coordination 层 —— tracker /
 * workspace / agent 不得反向持有调度或 retry 策略。orchestration state mutation
 * 只经本包 API；retry 队列 / reconciliation / poll loop 的写路径随后续 M5 子任务
 * 落地（进度见 docs/conformance.md）。
 */

export { createInitialCodexTotals, createOrchestratorRuntimeState } from "./runtime-state";
export type { OrchestratorRuntimeStateInit } from "./runtime-state";

export {
  globalAvailableSlots,
  hasRequiredDispatchFields,
  isActiveState,
  isDispatchEligible,
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

export { OrchestratorAuthority } from "./authority";
export type {
  AgentAttemptRunner,
  AttemptContext,
  AttemptOptionsFactory,
  DispatchResult,
  OrchestratorAuthorityOptions,
} from "./authority";
