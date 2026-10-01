/**
 * Continuation decision 契约（SPEC **§10.2 / §10.3 continuation** 与 §12.3，M4.1 / #37）。
 *
 * 存在的理由是一条**依赖方向**约束（AGENTS.md 两条硬约束之一：agent runner 不拥有
 * coordination）：官方参考实现里"每个 turn 完成后 refresh tracker、再决定是否继续"
 * 的行为需要 tracker 语义（active / terminal states、required labels、claim、retry）。
 * `packages/agent` 不得 import `@symphony/tracker`，所以那份策略以**注入点**的形式
 * 出现在这里：agent 包提供"同一个 live thread 上继续下一个 turn"的执行能力，M5 注入
 * 真正的 eligibility 判定。
 *
 * 本文件只有类型，没有任何 runner 行为——执行、`agent.max_turns` 强制、decider 异常
 * 处理随 M4.5 落地（SPEC §10.3 "SHOULD start another turn on the same live thread"）。
 */
import type { Issue } from "@symphony/domain";

import type { AgentEvent } from "./events";

/**
 * 一次 turn 结束（成功或失败）后交给 {@link ContinuationDecider} 的上下文。
 *
 * 全部字段都是 Symphony 侧信息：{@link TurnCompletedContext.event} 是已映射的稳定
 * {@link AgentEvent}，不是 raw Codex payload——decider 因此不需要（也不应该）理解
 * app-server 协议。
 */
export interface TurnCompletedContext {
  /** 本次 attempt 派发时的归一化 issue（§4.1.1）；decider 若要 refresh，快照由它自己取。 */
  readonly issue: Issue;
  /** 本次 worker 生命周期内复用的 thread 标识（§10.2：continuation turns 同一 `thread_id`）。 */
  readonly threadId: string;
  /** 刚结束的 turn 标识。 */
  readonly turnId: string;
  /** 本 worker 生命周期内**已启动**的 turn 数（§4.1.6 `turn_count` 口径，1-based）。 */
  readonly turnCount: number;
  /** 触发本次判定的 turn 结束事件（`turn_completed` / `turn_failed` / …，§10.4）。 */
  readonly event: AgentEvent;
}

/**
 * decider 的返回值：唯一的判别式是 `kind`。
 *
 * - `stop`：结束 session（正常收尾、tracker 判定已 terminal、预算耗尽等，本契约不区分）；
 * - `continue`：在**同一个 live thread** 上再起一个 turn，并带上 decider 提供的
 *   issue 快照——它可能是 refresh 后的新快照。continuation prompt 不重发原始 workflow
 *   prompt（§10.2），因此该快照只用于上下文与观测，不改变 prompt 模板本身。
 */
export type ContinuationDecision =
  | { readonly kind: "stop" }
  | { readonly kind: "continue"; readonly issue: Issue };

/**
 * 由组合根 / orchestrator（M5）注入的 continuation 判定函数。
 *
 * 契约边界：实现方**不得**依赖 agent 包的任何内部状态来做决定，也不得在这里做
 * retry / backoff（§8.4 归 orchestrator）；runner 侧的承诺是"不无限等待"——
 * reject、超时或长时间挂起如何收敛成 attempt failure 由 M4.5 定义并测试。
 */
export type ContinuationDecider = (context: TurnCompletedContext) => Promise<ContinuationDecision>;
