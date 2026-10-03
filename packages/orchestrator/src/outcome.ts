/**
 * Worker outcome → terminal `RunAttempt.status` 分类（SPEC §7.2 / §7.3、§14.1，
 * M5.2 / #51）。
 *
 * 判定优先级：**主动 stop reason 优先于底层错误码**。这样 reconciliation / stall /
 * shutdown 停止不会因为底层 session cancel 抛出的 `port_exit` 被误分类为普通失败。
 *
 * 终态映射（§7.2 的 5 个终态）：
 * - 正常完成且未被 stop → `succeeded`；
 * - 稳定 timeout 类错误（`turn_timeout` / `response_timeout` / `continuation_timeout`）
 *   → `timed_out`；
 * - stall stop → `stalled`；
 * - reconciliation / terminal stop → `canceled_by_reconciliation`；
 * - shutdown stop / 其余异常 → `failed`（保留错误描述）；
 * - shutdown 通过 {@link TerminalClassification.suppressRetry} 表达"不安排 retry"，
 *   不新增 domain 状态。
 */
import { AgentError } from "@symphony/agent";
import type { RunAttemptStatus } from "@symphony/domain";

import type { WorkerStopReason } from "./worker";

/** 终态分类结果。 */
export interface TerminalClassification {
  readonly status: RunAttemptStatus;
  /** 终态错误描述；成功为 `null`。 */
  readonly error: string | null;
  /** 是否必须抑制后续 retry（reconciliation / terminal / shutdown）。 */
  readonly suppressRetry: boolean;
  /** retry 语义提示，供 M5.3 消费。 */
  readonly retryKind: "none" | "continuation" | "failure";
}

/** 稳定 timeout 类 agent 错误码（→ `timed_out`）。 */
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  "turn_timeout",
  "response_timeout",
  "continuation_timeout",
]);

/** 正常完成（runner resolve）的终态分类。 */
export function classifySuccess(stopReason: WorkerStopReason | null): TerminalClassification {
  if (stopReason !== null) {
    // stop 与正常完成竞争：以主动 stop 为准，避免把 stop 当成普通成功。
    return classifyStop(stopReason);
  }
  return {
    status: "succeeded",
    error: null,
    suppressRetry: false,
    retryKind: "continuation",
  };
}

/** 异常结束（runner reject）的终态分类。 */
export function classifyError(
  error: unknown,
  stopReason: WorkerStopReason | null,
): TerminalClassification {
  if (stopReason !== null) {
    return classifyStop(stopReason);
  }
  if (error instanceof AgentError) {
    if (TIMEOUT_ERROR_CODES.has(error.code)) {
      return {
        status: "timed_out",
        error: error.code,
        suppressRetry: false,
        retryKind: "failure",
      };
    }
    return {
      status: "failed",
      error: error.code,
      suppressRetry: false,
      retryKind: "failure",
    };
  }
  return {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    suppressRetry: false,
    retryKind: "failure",
  };
}

/** 主动 stop reason → 终态分类。 */
export function classifyStop(stopReason: WorkerStopReason): TerminalClassification {
  switch (stopReason.kind) {
    case "stall":
      return {
        status: "stalled",
        error: "worker stopped: stall",
        suppressRetry: false,
        retryKind: "failure",
      };
    case "reconciliation":
    case "terminal":
      return {
        status: "canceled_by_reconciliation",
        error: `worker stopped: ${stopReason.kind}`,
        suppressRetry: true,
        retryKind: "none",
      };
    case "shutdown":
      return {
        status: "failed",
        error: "worker stopped: shutdown",
        suppressRetry: true,
        retryKind: "none",
      };
  }
}
