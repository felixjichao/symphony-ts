/**
 * @symphony/agent — SPEC §10 Agent Runner Protocol 与 §12 Prompt Construction and
 * Context Assembly 的 owner 包（§3 的 Agent Runner）。
 *
 * 本文件是包的唯一公共 API 面。**M4.1（#37）只落地契约层**：稳定错误面、稳定事件面、
 * continuation 判定契约，以及它们与 pinned Codex 协议之间的分层边界。子进程 launch、
 * JSON-RPC / NDJSON transport、initialize / thread / turn 生命周期、server request
 * 处理、prompt / hooks 组装都还没有实现（见 README 的 Known limitations 与
 * `docs/conformance.md`）。
 *
 * 分层（README 与 Agent Note 记录了为什么这样切）：
 *
 * ```text
 * Agent Runner（M4.5）
 *     ↓ 本包导出面：AgentEvent / AgentError / ContinuationDecider（稳定 Symphony 契约）
 * Codex App-Server Client（M4.2–M4.4）
 *     ↓ pinned protocol adapter（协议词汇只存在于这一层）
 * JSON-RPC / NDJSON Transport
 *     ↓
 * bash -lc <codex.command>
 * ```
 *
 * M5 / orchestrator 只 import 本文件导出的类型；不得要求它解释 raw Codex JSON。
 *
 * 边界约束：runner 不拥有 scheduler / retry policy / tracker eligibility —— 属
 * orchestrator（AGENTS.md 依赖方向：`agent → domain + config + workspace`）。
 */

export { AgentError, AGENT_ERROR_CODES } from "./errors";
export type { AgentErrorCode, AgentErrorDetails } from "./errors";

export { AGENT_EVENT_NAMES } from "./events";
export type { AgentEvent, AgentTokenUsage } from "./events";

export type {
  ContinuationDecider,
  ContinuationDecision,
  TurnCompletedContext,
} from "./continuation";
