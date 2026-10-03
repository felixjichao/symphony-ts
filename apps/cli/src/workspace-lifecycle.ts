import type { AgentAttemptOptions } from "@symphony/agent";
import type { Issue } from "@symphony/domain";
import type { AttemptContext, WorkspaceCleanupIssueContext } from "@symphony/orchestrator";
import type { WorkspaceManager } from "@symphony/workspace";
import type { EffectiveRuntime, EffectiveRuntimeController } from "./effective-runtime";
import type { createRuntimeLogObservers } from "./logging";

/**
 * 记录特定 issue attempt 选定的 workspace 归属生命周期（SPEC §6.2 / §9，M6.4）。
 */
export interface WorkspaceBinding {
  readonly issueId: string | null;
  readonly identifier: string;
  readonly manager: WorkspaceManager;
  readonly workspacePath: string;
  readonly runtime: EffectiveRuntime;
}

/**
 * Workspace 归属生命周期协调器：
 * - 调度派发时绑定当前 runtime 的 workspace root 与 manager；
 * - attempt 运行期间保持 root/prompt/codex/exclusions 冻结；
 * - hook 执行时读取当前最新的 live hooks；
 * - 终态 cleanup 依据该 issue 的绑定 manager 清理，避免 root reload 后清理错根；
 * - 未绑定的 cleanup（如 startup sweep）回退到当前 current workspace manager；
 * - 成功清理后释放绑定，失败或拒绝时保留绑定以备重试。
 */
export class WorkspaceLifecycleCoordinator {
  private readonly issueBindings = new Map<string, WorkspaceBinding>();
  private readonly identifierBindings = new Map<string, WorkspaceBinding>();

  constructor(
    private readonly controller: EffectiveRuntimeController,
    private readonly observers: ReturnType<typeof createRuntimeLogObservers>,
  ) {}

  public resolveForDispatch(issue: Issue): string {
    const runtime = this.controller.current;
    const path = runtime.workspaceManager.resolveWorkspacePath(issue.identifier);
    const binding: WorkspaceBinding = {
      issueId: issue.id,
      identifier: issue.identifier,
      manager: runtime.workspaceManager,
      workspacePath: path,
      runtime,
    };
    if (issue.id) {
      this.issueBindings.set(issue.id, binding);
    }
    this.identifierBindings.set(issue.identifier, binding);
    return path;
  }

  public createAttemptOptions(context: AttemptContext): AgentAttemptOptions {
    const binding = (context.issue.id ? this.issueBindings.get(context.issue.id) : undefined)
      ?? this.identifierBindings.get(context.issue.identifier);
    const runtime = binding ? binding.runtime : this.controller.current;

    return this.observers.observeAttempt({
      ...context,
      workflow: runtime.effectiveWorkflow.definition,
      workflowPath: this.controller.workflowPath,
      getConfig: () => ({
        ...runtime.serviceConfig,
        hooks: this.controller.current.serviceConfig.hooks,
      }),
      excludeEnvNames: runtime.excludeEnvNames,
    });
  }

  public resolveForCleanup(context: WorkspaceCleanupIssueContext): {
    manager: WorkspaceManager;
    release: () => void;
  } {
    const binding = (context.issueId ? this.issueBindings.get(context.issueId) : undefined)
      ?? this.identifierBindings.get(context.identifier);

    if (binding) {
      return {
        manager: binding.manager,
        release: () => {
          if (context.issueId && this.issueBindings.get(context.issueId) === binding) {
            this.issueBindings.delete(context.issueId);
          }
          if (this.identifierBindings.get(context.identifier) === binding) {
            this.identifierBindings.delete(context.identifier);
          }
        },
      };
    }

    return {
      manager: this.controller.current.workspaceManager,
      release: () => {},
    };
  }

  public getBinding(identifier: string): WorkspaceBinding | undefined {
    return this.identifierBindings.get(identifier);
  }
}
