/**
 * Continuation decision 契约（SPEC **§10.2 / §10.3 continuation** 与 §12.3，M4.1 / M4.5）。
 *
 * 存在的理由是一条**依赖方向**约束（AGENTS.md 两条硬约束之一：agent runner 不拥有
 * coordination）：官方参考实现里"每个 turn 完成后 refresh tracker、再决定是否继续"
 * 的行为需要 tracker 语义（active / terminal states、required labels、claim、retry）。
 * `packages/agent` 不得 import `@symphony/tracker`，所以那份策略以**注入点**的形式
 * 出现在这里：agent 包提供"同一个 live thread 上继续下一个 turn"的执行能力，M5 注入
 * 真正的 eligibility 判定。
 */
import { composeSessionId, type Issue } from "@symphony/domain";

import { AgentError } from "./errors";
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
  /** 可选的 AbortSignal，供注入的异步 refresh 操作在超时或 attempt 中止时协作取消。 */
  readonly signal?: AbortSignal | undefined;
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
 * reject、超时或长时间挂起收敛为类型化 {@link AgentError}。
 */
export type ContinuationDecider = (context: TurnCompletedContext) => Promise<ContinuationDecision>;

/**
 * SPEC §10.2 continuation turns 默认指导文本。
 *
 * 不得重新渲染并重发完整原始 prompt，防止无谓 token 膨胀与上下文重复。
 */
export const DEFAULT_CONTINUATION_GUIDANCE =
  "Continue working on the same issue using the existing thread and workspace context. Do not restart from scratch or repeat completed work.";

/** continuation decider 默认等待超时窗口（30 秒）。 */
export const DEFAULT_CONTINUATION_TIMEOUT_MS = 30_000;

/** attempt 级外部取消的 typed 错误（复用 §10.6 `turn_cancelled`，见 M5.2 / #51）。 */
function cancellationError(context: TurnCompletedContext): AgentError {
  return new AgentError(
    "turn_cancelled",
    "Continuation decision was cancelled by the attempt AbortSignal",
    {
      threadId: context.threadId,
      turnId: context.turnId,
      sessionId: composeSessionId(context.threadId, context.turnId),
    },
  );
}

/** 默认 continuation decider：单 turn 正常结束。 */
export const defaultContinuationDecider: ContinuationDecider = async () => ({
  kind: "stop",
});

/**
 * 有界执行 {@link ContinuationDecider}，提供超时、取消 signal、决议校验与异常收敛。
 */
export async function executeContinuationDecider(
  decider: ContinuationDecider,
  context: Omit<TurnCompletedContext, "signal">,
  timeoutMs: number = DEFAULT_CONTINUATION_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<ContinuationDecision> {
  const effectiveTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_CONTINUATION_TIMEOUT_MS;

  const controller = new AbortController();
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  // attempt 级外部取消（M5.2 / #51）：concatenate 到内部 signal，使 decider 的异步
  // refresh 协作取消，并让本函数立即以取消错误收敛，而不是等满 timeout。
  let externalAbortListener: (() => void) | undefined;
  const externalAbortPromise = new Promise<never>((_, reject) => {
    if (externalSignal === undefined) {
      return;
    }
    if (externalSignal.aborted) {
      controller.abort();
      reject(cancellationError(context));
      return;
    }
    externalAbortListener = () => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(cancellationError(context));
    };
    externalSignal.addEventListener("abort", externalAbortListener, { once: true });
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(
        new AgentError(
          "continuation_timeout",
          `Continuation decider timed out after ${effectiveTimeout} ms`,
          {
            threadId: context.threadId,
            turnId: context.turnId,
            sessionId: composeSessionId(context.threadId, context.turnId),
          },
        ),
      );
    }, effectiveTimeout);
  });

  const fullContext: TurnCompletedContext = {
    ...context,
    signal: controller.signal,
  };

  let deciderPromise: Promise<ContinuationDecision>;
  try {
    deciderPromise = Promise.resolve(decider(fullContext));
  } catch (syncErr) {
    deciderPromise = Promise.reject(syncErr);
  }

  const safeDeciderPromise = deciderPromise.then(
    (res) => {
      if (settled) {
        return null as unknown as ContinuationDecision;
      }
      return res;
    },
    (err) => {
      if (settled) {
        // 迟到的 reject 吞掉，避免触发 Node.js unhandled rejection
        return null as unknown as ContinuationDecision;
      }
      throw new AgentError(
        "continuation_failed",
        `Continuation decider threw an error: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
          threadId: context.threadId,
          turnId: context.turnId,
          sessionId: composeSessionId(context.threadId, context.turnId),
        },
      );
    },
  );

  try {
    const decision = await Promise.race([
      safeDeciderPromise,
      timeoutPromise,
      externalAbortPromise,
    ]);

    if (typeof decision !== "object" || decision === null || !("kind" in decision)) {
      throw new AgentError(
        "continuation_failed",
        "Continuation decider returned an invalid decision object",
        {
          threadId: context.threadId,
          turnId: context.turnId,
          sessionId: composeSessionId(context.threadId, context.turnId),
        },
      );
    }

    if (decision.kind === "stop") {
      return { kind: "stop" };
    }

    if (decision.kind === "continue") {
      if (
        typeof decision.issue !== "object" ||
        decision.issue === null ||
        typeof decision.issue.id !== "string"
      ) {
        throw new AgentError(
          "continuation_failed",
          "Continuation decider returned continue decision without valid issue object",
          {
            threadId: context.threadId,
            turnId: context.turnId,
            sessionId: composeSessionId(context.threadId, context.turnId),
          },
        );
      }
      if (decision.issue.id !== context.issue.id) {
        throw new AgentError(
          "continuation_failed",
          `Continuation decider returned issue with mismatched id (expected '${context.issue.id}', got '${decision.issue.id}')`,
          {
            threadId: context.threadId,
            turnId: context.turnId,
            sessionId: composeSessionId(context.threadId, context.turnId),
          },
        );
      }
      return decision;
    }

    throw new AgentError(
      "continuation_failed",
      `Continuation decider returned unknown decision kind: ${String((decision as { kind: unknown }).kind)}`,
      {
        threadId: context.threadId,
        turnId: context.turnId,
        sessionId: composeSessionId(context.threadId, context.turnId),
      },
    );
  } finally {
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalAbortListener !== undefined && externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", externalAbortListener);
    }
  }
}
