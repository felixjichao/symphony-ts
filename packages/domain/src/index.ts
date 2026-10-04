/**
 * @symphony/domain — SPEC §4 Core Domain Model 的 owner 包（领域类型唯一权威）。
 *
 * 本文件是包的唯一公共 API 面（下游包与测试都从这里 import）。M1.1 落地内容：
 *
 * - Issue 及子结构：{@link Issue} / {@link IssueNativeRef} / {@link IssueBlockerRef}（§4.1.1）
 * - Workflow：{@link WorkflowDefinition}（§4.1.2）
 * - Service Config typed view：{@link ServiceConfig} 及 {@link TrackerConfig} /
 *   {@link PollingConfig} / {@link WorkspaceConfig} / {@link HooksConfig} /
 *   {@link AgentConfig} / {@link CodexConfig}（§4.1.3，字段对应 §5.3 / §6.4）；
 *   Codex-owned pass-through 值的 JSON-safe 形状是 {@link CodexPassThroughValue}（M4.1）
 * - Workspace：{@link Workspace} + {@link deriveWorkspaceKey}（§4.1.4 / §4.2）
 * - Run attempt：{@link RunAttempt} / {@link RunAttemptStatus} / {@link RUN_ATTEMPT_STATUSES}（§4.1.5 / §7.2）
 * - Live session：{@link LiveSession} / {@link CodexEventName} + {@link composeSessionId}（§4.1.6 / §4.2）
 * - Retry：{@link RetryEntry} / {@link TimerHandle}（§4.1.7）
 * - Orchestrator state：{@link OrchestratorRuntimeState} / {@link RunningEntry} /
 *   {@link CodexTotals} / {@link CodexRateLimits}（§4.1.8）
 * - 时间戳时钟域：{@link UtcTimestampMs} / {@link MonotonicTimestampMs}（§11.3 / §13.5）
 * - §4.2 归一化纯函数：{@link normalizeIssueState} / {@link deriveWorkspaceKey} /
 *   {@link composeSessionId}
 *
 * 建模约定（camelCase ↔ SPEC snake_case 映射、nullable vs optional、readonly 策略、
 * 不透明句柄）见包 `README.md` 与
 * `notes/accepted/architecture/2026-09-27-domain-contracts.md`。
 * 本包不含业务行为：解析 / 校验归 config，归一化动作归 tracker，provisioning 归
 * workspace，状态机与调度归 orchestrator。
 */

export type { MonotonicTimestampMs, UtcTimestampMs } from "./time";

export type { Issue, IssueBlockerRef, IssueNativeRef } from "./issue";
export { normalizeIssueState } from "./issue";

export type { WorkflowDefinition } from "./workflow";

export type {
  AgentConfig,
  CodexConfig,
  CodexPassThroughValue,
  HooksConfig,
  PollingConfig,
  ServiceConfig,
  TrackerConfig,
  WorkspaceConfig,
} from "./config";

export type { Workspace } from "./workspace";
export { deriveWorkspaceKey } from "./workspace";

export type { RunAttempt, RunAttemptStatus } from "./run";
export { RUN_ATTEMPT_STATUSES } from "./run";

export type { CodexEventName, LiveSession } from "./session";
export { composeSessionId } from "./session";

export type { RetryEntry, TimerHandle } from "./retry";

export type {
  CodexRateLimits,
  CodexTotals,
  OrchestratorRuntimeState,
  RunningEntry,
} from "./orchestrator";

export type {
  ObservabilityRuntimeView, ObservabilitySnapshot, ObservabilityRunningRow,
  ObservabilityRetryRow, SnapshotClock, SnapshotTokens, SnapshotValue, SnapshotResult,
} from "./observability";
export type { StructuredLogEvent } from "./logging";

export type {
  CiCheckItem,
  CiCheckStatus,
  CiPolicyEvaluation,
  DeliveryContext,
  DeliveryHandoff,
  DeliveryHandoffReason,
  DeliverySkillConfig,
  DeliverySkillResult,
  DeliverySkillStatus,
  FormatPrBodyOptions,
  PrOwnershipMarker,
} from "./delivery";
export {
  evaluateCiChecksPolicy,
  formatDeliveryHandoffMarkdown,
  formatPrBody,
  parsePrOwnershipMarker,
  serializePrOwnershipMarker,
  validatePrOwnership,
} from "./delivery";

