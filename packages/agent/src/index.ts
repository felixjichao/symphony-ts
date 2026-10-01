/**
 * @symphony/agent — SPEC §10 Agent Runner Protocol 与 §12 Prompt Construction and
 * Context Assembly 的 owner 包（§3 的 Agent Runner）。
 *
 * 本文件是包的唯一公共 API 面。**M4.1（#37）落地契约层**：稳定错误面、稳定事件面、
 * continuation 判定契约，以及它们与 pinned Codex 协议之间的分层边界。**M4.2（#38）落地
 * 最底层的 transport kernel 与 launch 边界**（`transport.ts` / `process-launcher.ts`，
 * 按方案 A 只在这里 re-export 类型与默认常量）。initialize / thread / turn 生命周期、
 * server request 的 approval / user-input 裁决、`turn/*` → `AgentEvent` 映射、
 * prompt / hooks 组装都还没有实现（见 README 的 Known limitations 与
 * `docs/conformance.md`）。
 *
 * 分层（README 与 Agent Note 记录了为什么这样切）：
 *
 * ```text
 * Agent Runner（M4.5）
 *     ↓ 本包导出面：AgentEvent / AgentError / ContinuationDecider（稳定 Symphony 契约）
 * Codex App-Server Client（M4.3–M4.4）
 *     ↓ pinned protocol adapter（协议词汇只存在于这一层）
 * JSON-RPC / NDJSON Transport（M4.2，包内）
 *     ↓
 * bash -lc <codex.command>（M4.2 launch 边界，含 workspace cwd 校验）
 * ```
 *
 * M5 / orchestrator 只 import 本文件导出的类型；不得要求它解释 raw Codex JSON。
 *
 * 边界约束：runner 不拥有 scheduler / retry policy / tracker eligibility —— 属
 * orchestrator（AGENTS.md 依赖方向：`agent → domain + config + workspace`）。
 */

export { AgentError, AGENT_ERROR_CODES } from "./errors";
export type { AgentErrorCode, AgentErrorDetails } from "./errors";

export { AGENT_EVENT_NAMES, isAgentEventName } from "./events";
export type { AgentEvent, AgentEventName, AgentTokenUsage } from "./events";

export type {
  ContinuationDecider,
  ContinuationDecision,
  TurnCompletedContext,
} from "./continuation";

/**
 * Transport 契约面（M4.2 / #38，**方案 A：只 re-export 类型，不导出实现**）。
 *
 * `launchTransport` / `createNdjsonTransport` 刻意**不**出现在本文件里：按 README 的
 * 分层，transport 位于 `Agent Runner → Codex App-Server Client → Transport` 的最底层，
 * 唯一消费者是同包的 M4.3 Codex client（`import ... from "./process-launcher"`）。
 * 包外（orchestrator / apps/cli）只应看到 Symphony 侧的稳定契约，不应获得一个
 * 「能直接起子进程」的入口 —— 那会绕过 prompt 组装、session 生命周期与事件映射。
 *
 * 因此这里导出的全是**类型与默认常量**：上层据此读写 transport，但不 own spawn。
 */
export {
  DEFAULT_MAX_PROTOCOL_LINE_BYTES,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from "./transport";
export type {
  JsonRpcErrorPayload,
  RequestId,
  Transport,
  TransportExitInfo,
  TransportListener,
  TransportNotification,
  TransportProtocolIssue,
  TransportRequest,
  TransportResponse,
  TransportServerRequest,
  TransportServerResponse,
} from "./transport";

export type { WorkspacePathSafetyGate } from "./process-launcher";

/**
 * Codex app-server live session 契约面与工厂（M4.3 / #39）。
 */
export {
  DEFAULT_TURN_TIMEOUT_MS,
  startAppServerSession,
} from "./app-server-session";
export type {
  AppServerSession,
  AppServerSessionOptions,
  TurnCompletedOutcome,
} from "./app-server-session";
