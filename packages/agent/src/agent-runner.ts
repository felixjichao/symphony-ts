/**
 * Symphony Agent Runner (SPEC **§10.7 / §12 / §16.5**，M4.5 / #41）。
 *
 * 把 workspace provisioning、config prompt rendering 与 Codex session client
 * 组合成单一 worker attempt 驱动原语：
 *
 * 1. create / reuse workspace；
 * 2. before_run lifecycle hook（fatal）；
 * 3. 严格 prompt 模板渲染（launch 前发生）；
 * 4. launch-safe Codex app-server session；
 * 5. 首轮 turn 执行；
 * 6. 可选的 continuation turns（复用同一 live thread）；
 * 7. stop session；
 * 8. after_run lifecycle hook（finally-style best-effort）；
 * 9. workspace 在 attempt 成功 / 失败后均不删除（§10.7）。
 */
import { renderPrompt } from "@symphony/config";
import type {
  Issue,
  ServiceConfig,
  WorkflowDefinition,
  Workspace,
} from "@symphony/domain";
import {
  WorkspaceManager,
  type WorkspaceHookEventSink,
} from "@symphony/workspace";

import {
  startAppServerSession,
  type AppServerSession,
  type TurnCompletedOutcome,
} from "./app-server-session";
import {
  DEFAULT_CONTINUATION_GUIDANCE,
  DEFAULT_CONTINUATION_TIMEOUT_MS,
  defaultContinuationDecider,
  executeContinuationDecider,
  type ContinuationDecider,
} from "./continuation";
import { AgentError } from "./errors";
import type { AgentEvent } from "./events";

/**
 * 一次 Agent Attempt 的输入选项。
 */
export interface AgentAttemptOptions {
  /** 本次 attempt 的目标工单（§4.1.1）。 */
  readonly issue: Issue;
  /** attempt 序号（1-based，首次为 1；null 表示不传或未编号 attempt）。 */
  readonly attempt: number | null;
  /** 已加载的 workflow 定义（含 promptTemplate）。 */
  readonly workflow: WorkflowDefinition;
  /** workflow 文件绝对路径（供 prompt parse/render 诊断）。 */
  readonly workflowPath: string;
  /** 获取当前 effective ServiceConfig 的 getter（支持 hook 动态获取）。 */
  readonly getConfig: () => ServiceConfig;
  /** 注入的 continuation 判定函数；缺省使用 {@link defaultContinuationDecider}（单 turn stop）。 */
  readonly continuationDecider?: ContinuationDecider | undefined;
  /** continuation decider 等待超时毫秒数；缺省 30_000 ms。 */
  readonly continuationTimeoutMs?: number | undefined;
  /** 显式注入的子进程环境变量（优先于继承环境）。 */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** 从继承环境中剔除的变量名名单。 */
  readonly excludeEnvNames?: readonly string[] | undefined;
  /** 运行时事件回调（隔离 sink 抛错）。 */
  readonly onEvent?: ((event: AgentEvent) => void) | undefined;
  /** workspace hook 失败 / 超时事件接收器。 */
  readonly onHookEvent?: WorkspaceHookEventSink | undefined;
  /** 子进程 stderr 诊断行回调。 */
  readonly onStderr?: ((line: string) => void) | undefined;
}

/**
 * 一次 Agent Attempt 正常完成后的产出。
 */
export interface AgentAttemptResult {
  /** 本次 attempt 复用或创建的 workspace 实体。 */
  readonly workspace: Workspace;
  /** 结束时的工单快照（若 continuation 中途接收了 refreshed Issue，则反映最新快照）。 */
  readonly issue: Issue;
  /** 本次 attempt 全生命周期复用的 live thread ID。 */
  readonly threadId: string;
  /** 本次 attempt 实际完成的 turn 数（1-based）。 */
  readonly turnCount: number;
  /** 最后一个 turn 的完成产出。 */
  readonly lastTurn: TurnCompletedOutcome;
  /** 停止原因：decider 返回 stop，或达到 maxTurns 硬上限。 */
  readonly stopReason: "decider_stop" | "max_turns";
}

/**
 * 执行一次 Symphony coding agent attempt（SPEC §10.7 / §12 / §16.5）。
 */
export async function runAgentAttempt(options: AgentAttemptOptions): Promise<AgentAttemptResult> {
  const initialConfig = options.getConfig();
  const workspaceConfig = initialConfig.workspace;
  const codexConfig = initialConfig.codex;
  const maxTurns = initialConfig.agent.maxTurns;

  const workspaceManager = new WorkspaceManager({
    workspace: workspaceConfig,
  });

  // 1. 创建或复用 workspace；失败时直接抛出，不执行 after_run（新建时的半成品清理已由 manager 处理）
  const workspace = await workspaceManager.createWorkspace(options.issue.identifier, {
    hooks: options.getConfig().hooks,
    onHookEvent: options.onHookEvent,
  });

  let session: AppServerSession | null = null;
  let primaryError: unknown;
  let threadId: string | undefined;
  let turnCount = 0;
  let lastTurn: TurnCompletedOutcome | undefined;
  let stopReason: "decider_stop" | "max_turns" | undefined;
  let currentIssue = options.issue;
  const turnCompletedHolder: { event: AgentEvent | null } = { event: null };

  try {
    // 2. before_run hook：失败（non-zero / timeout）直接抛 fatal 并阻止 launch
    await workspaceManager.runBeforeRunHook(workspace, {
      hooks: options.getConfig().hooks,
      identifier: options.issue.identifier,
      onHookEvent: options.onHookEvent,
    });

    // 3. 严格 prompt 模板渲染：失败直接阻止 launch
    const firstPrompt = renderPrompt(options.workflow.promptTemplate, {
      issue: options.issue,
      attempt: options.attempt,
      workflowPath: options.workflowPath,
    });

    // 4. 启动 Codex live session
    session = await startAppServerSession({
      command: codexConfig.command,
      workspacePath: workspace.path,
      workspacePathSafety: workspaceManager,
      identifier: options.issue.identifier,
      env: options.env,
      excludeEnvNames: options.excludeEnvNames,
      readTimeoutMs: codexConfig.readTimeoutMs,
      turnTimeoutMs: codexConfig.turnTimeoutMs,
      approvalPolicy: codexConfig.approvalPolicy,
      threadSandbox: codexConfig.threadSandbox,
      turnSandboxPolicy: codexConfig.turnSandboxPolicy,
      onEvent: (event) => {
        if (event.event === "turn_completed") {
          turnCompletedHolder.event = event;
        }
        try {
          options.onEvent?.(event);
        } catch {
          /* 外部 sink 异常隔离 */
        }
      },
      onStderr: options.onStderr,
    });

    threadId = session.threadId;

    // 5. turn 循环
    const decider = options.continuationDecider ?? defaultContinuationDecider;
    const timeoutMs = options.continuationTimeoutMs ?? DEFAULT_CONTINUATION_TIMEOUT_MS;

    while (true) {
      turnCount += 1;
      const promptText = turnCount === 1 ? firstPrompt : DEFAULT_CONTINUATION_GUIDANCE;

      const outcome = await session.startTurn({ text: promptText });
      lastTurn = outcome;

      const lastEvt = turnCompletedHolder.event;
      const completedEvent: AgentEvent =
        lastEvt !== null &&
        lastEvt.threadId === threadId &&
        lastEvt.turnId === outcome.turnId
          ? lastEvt
          : {
              event: "turn_completed",
              timestamp: Date.now(),
              codexAppServerPid: session.codexAppServerPid,
              threadId,
              turnId: outcome.turnId,
              sessionId: outcome.sessionId,
              summary: "Turn completed successfully",
            };

      const decision = await executeContinuationDecider(
        decider,
        {
          issue: currentIssue,
          threadId,
          turnId: outcome.turnId,
          turnCount,
          event: completedEvent,
        },
        timeoutMs,
      );

      if (decision.kind === "stop") {
        stopReason = "decider_stop";
        break;
      }

      currentIssue = decision.issue;

      if (turnCount >= maxTurns) {
        stopReason = "max_turns";
        break;
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // 6. 收尾：先 await session.stop()，再执行 after_run
    try {
      if (session !== null) {
        try {
          await session.stop();
        } catch (stopError) {
          if (primaryError === undefined) {
            primaryError =
              stopError instanceof AgentError && stopError.code === "port_exit"
                ? stopError
                : new AgentError(
                    "port_exit",
                    `Session stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
                    { cause: stopError, threadId },
                  );
          }
        }
      }
    } finally {
      try {
        await workspaceManager.runAfterRunHook(workspace, {
          hooks: options.getConfig().hooks,
          identifier: options.issue.identifier,
          onHookEvent: options.onHookEvent,
        });
      } catch {
        /* best-effort：永不覆盖原 attempt outcome */
      }
    }
  }

  if (primaryError !== undefined) {
    throw primaryError;
  }

  return {
    workspace,
    issue: currentIssue,
    threadId: threadId!,
    turnCount,
    lastTurn: lastTurn!,
    stopReason: stopReason!,
  };
}
