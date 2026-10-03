import type { EffectiveWorkflow, WorkflowEffectiveStore } from "@symphony/config";
import type { ServiceConfig } from "@symphony/domain";
import { SymphonyConfigError } from "@symphony/config";
import type { DispatchPolicy, EffectiveSchedulingConfig, OrchestratorAuthority } from "@symphony/orchestrator";
import type { TrackerAdapter, TrackerAdapterProfile, TrackerAdapterRegistry, TrackerEnv } from "@symphony/tracker";
import { TrackerError } from "@symphony/tracker";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";
import type { StructuredLogger } from "@symphony/observability";
import { createRuntimeLogObservers, registerTrackerLogSecrets } from "./logging";

/**
 * 单一 EffectiveRuntime 权威快照（SPEC §6.2 / §13 / §18.1，M6.4）。
 *
 * 保证以下内容永远来自同一次原子事务，不得互相漂移：
 * - EffectiveWorkflow
 * - ServiceConfig
 * - selected tracker profile
 * - constructed tracker adapter
 * - derived secret env exclusions
 * - workspace manager
 * - scheduling projection
 */
export interface EffectiveRuntime {
  readonly effectiveWorkflow: EffectiveWorkflow;
  readonly serviceConfig: ServiceConfig;
  readonly profile: TrackerAdapterProfile | undefined;
  readonly adapter: TrackerAdapter;
  readonly excludeEnvNames: readonly string[];
  readonly workspaceManager: WorkspaceManager;
  readonly scheduling: EffectiveSchedulingConfig;
}

export interface EffectiveRuntimeControllerOptions {
  readonly workflowPath: string;
  readonly registry: TrackerAdapterRegistry;
  readonly env?: TrackerEnv | undefined;
  readonly logger: StructuredLogger;
  readonly observers: ReturnType<typeof createRuntimeLogObservers>;
  readonly onCommit?: ((runtime: EffectiveRuntime) => void) | undefined;
}

export class EffectiveRuntimeController {
  public readonly workflowPath: string;
  private readonly registry: TrackerAdapterRegistry;
  private readonly env: TrackerEnv | undefined;
  private readonly logger: StructuredLogger;
  private readonly observers: ReturnType<typeof createRuntimeLogObservers>;
  private readonly onCommit: ((runtime: EffectiveRuntime) => void) | undefined;

  private currentRuntime: EffectiveRuntime | null = null;
  private authority: OrchestratorAuthority | null = null;

  constructor(options: EffectiveRuntimeControllerOptions) {
    this.workflowPath = options.workflowPath;
    this.registry = options.registry;
    this.env = options.env;
    this.logger = options.logger;
    this.observers = options.observers;
    this.onCommit = options.onCommit;
  }

  public get current(): EffectiveRuntime {
    if (this.currentRuntime === null) {
      throw new Error("EffectiveRuntimeController has not been initialized with an EffectiveWorkflow");
    }
    return this.currentRuntime;
  }

  public setAuthority(authority: OrchestratorAuthority): void {
    this.authority = authority;
  }

  public get store(): WorkflowEffectiveStore {
    return {
      current: () => this.current.effectiveWorkflow,
      accept: (effective: EffectiveWorkflow) => this.accept(effective),
    };
  }

  /**
   * 同步准备并提交新 EffectiveWorkflow。
   *
   * 事务顺序：
   * 1. 校验 codex.command 非空；
   * 2. 查找 selected profile 并注册敏感变量到 logger；
   * 3. registry.create 构造新 adapter 并包装 observer；
   * 4. 构造对应 workspaceManager 与 scheduling projection；
   * 5. 提取 excludeEnvNames；
   * 6. 原子提交为 currentRuntime；
   * 7. 若已关联 authority，立即同步应用调度投影；
   * 8. 触发 onCommit 回调。
   *
   * 任何步骤在提交前失败均抛出异常，完整保留原 currentRuntime，不发事件，不产生 partial publish。
   */
  public accept(effective: EffectiveWorkflow): void {
    const command = effective.serviceConfig.codex.command.trim();
    if (!command) {
      throw new SymphonyConfigError(
        "invalid_config",
        "codex.command is empty",
        { path: this.workflowPath },
      );
    }

    const profile = this.registry.lookup(effective.serviceConfig.tracker.kind);
    if (profile) {
      registerTrackerLogSecrets(
        this.logger,
        profile,
        effective.serviceConfig.tracker.provider,
        this.env ?? process.env,
      );
    }

    let rawAdapter: TrackerAdapter;
    try {
      rawAdapter = this.registry.create(effective.serviceConfig.tracker, this.env);
    } catch (error) {
      if (error instanceof TrackerError) {
        throw new SymphonyConfigError(
          error.category === "unsupported_tracker_kind"
            ? "unsupported_tracker_kind"
            : error.category === "missing_tracker_secret"
              ? "missing_tracker_secret"
              : "invalid_tracker_config",
          error.message,
          { path: this.workflowPath, cause: error },
        );
      }
      throw error;
    }

    const adapter = this.observers.observeTracker(rawAdapter);
    const workspaceManager = createWorkspaceManager({ workspace: effective.serviceConfig.workspace });

    const activeStates = effective.serviceConfig.tracker.activeStates ?? profile?.defaultActiveStates ?? [];
    const terminalStates = effective.serviceConfig.tracker.terminalStates ?? profile?.defaultTerminalStates ?? [];
    const policy: DispatchPolicy = {
      activeStates,
      terminalStates,
      requiredLabels: effective.serviceConfig.tracker.requiredLabels,
      maxConcurrentAgentsByState: effective.serviceConfig.agent.maxConcurrentAgentsByState,
    };

    const scheduling: EffectiveSchedulingConfig = {
      pollIntervalMs: effective.serviceConfig.polling.intervalMs,
      maxConcurrentAgents: effective.serviceConfig.agent.maxConcurrentAgents,
      policy,
    };

    const excludeEnvNames = Object.freeze(
      profile ? [...profile.secretEnvVars] : [],
    );

    const nextRuntime: EffectiveRuntime = {
      effectiveWorkflow: effective,
      serviceConfig: effective.serviceConfig,
      profile,
      adapter,
      excludeEnvNames,
      workspaceManager,
      scheduling,
    };

    this.currentRuntime = nextRuntime;

    if (this.authority !== null) {
      this.authority.applyEffectiveSchedulingConfig(scheduling);
    }

    this.onCommit?.(nextRuntime);
  }
}
