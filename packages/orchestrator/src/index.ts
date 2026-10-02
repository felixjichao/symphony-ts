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
 * 边界约束（根 `AGENTS.md`）：本包是唯一的 coordination 层 —— tracker /
 * workspace / agent 不得反向持有调度或 retry 策略。orchestration state mutation
 * 只经本包 API；M5.1 只提供只读纯函数与 state 初始化，dispatch / retry 队列 /
 * reconciliation 的写路径随后续 M5 子任务落地（进度见 docs/conformance.md）。
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
