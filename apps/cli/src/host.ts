import { runAgentAttempt } from "@symphony/agent";
import {
  watchWorkflow,
  type EffectiveWorkflow,
  type WorkflowWatchHandle,
} from "@symphony/config";
import type { OrchestratorRuntimeState } from "@symphony/domain";
import {
  createStructuredLogger,
  projectObservabilitySnapshot,
  tryProjectObservabilitySnapshot,
  type ObservabilitySnapshot,
  type SnapshotClock,
  type SnapshotResult,
  type StructuredLogger,
} from "@symphony/observability";
import {
  createOrchestratorRuntimeState,
  OrchestratorAuthority,
  OrchestratorLoop,
  type DispatchPreflightResult,
  type DispatchPreflightSource,
  type PollScheduler,
  type RetryScheduler,
  type RetryWorkspaceCleanup,
  type WorkspaceCleanupIssueContext,
} from "@symphony/orchestrator";
import {
  createGitHubAdapterProfile,
  TrackerAdapterRegistry,
  type TrackerAdapter,
  type TrackerAdapterProfile,
  type TrackerEnv,
} from "@symphony/tracker";
import { resolveWorkflowPath } from "./args";
import { EffectiveRuntimeController } from "./effective-runtime";
import { createRuntimeLogObservers } from "./logging";
import { WorkspaceLifecycleCoordinator } from "./workspace-lifecycle";

export interface SymphonyHost {
  readonly workflowPath: string;
  readonly effective: EffectiveWorkflow;
  readonly state: OrchestratorRuntimeState;
  readonly authority: OrchestratorAuthority;
  readonly cleanupWorkspace: RetryWorkspaceCleanup;
  readonly workspaceCoordinator: WorkspaceLifecycleCoordinator;
  readonly tracker: TrackerAdapter;
  readonly loop: OrchestratorLoop;
  readonly logger: StructuredLogger;
  readonly clock: SnapshotClock;
  getSnapshot(): ObservabilitySnapshot;
  tryGetSnapshot(): SnapshotResult;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateHostOptions {
  readonly workflowPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: TrackerEnv | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly trackerProfiles?: readonly TrackerAdapterProfile[] | undefined;
  readonly scheduler?: PollScheduler | undefined;
  readonly retryScheduler?: RetryScheduler | undefined;
  readonly now?: (() => number) | undefined;
  readonly monotonicNow?: (() => number) | undefined;
  readonly watcherIntervalMs?: number | undefined;
}

export async function createHost(options: CreateHostOptions = {}): Promise<SymphonyHost> {
  const workflowPath = resolveWorkflowPath(options.workflowPath, options.cwd);
  const logger = options.logger ?? createStructuredLogger();
  const observers = createRuntimeLogObservers(logger);

  const registry = options.trackerProfiles !== undefined
    ? new TrackerAdapterRegistry(options.trackerProfiles)
    : new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })]);

  const controller = new EffectiveRuntimeController({
    workflowPath,
    registry,
    env: options.env,
    logger,
    observers,
  });

  let watcher: WorkflowWatchHandle;
  try {
    watcher = watchWorkflow({
      path: workflowPath,
      ...(options.watcherIntervalMs !== undefined ? { intervalMs: options.watcherIntervalMs } : {}),
      trackerExtension: registry.createConfigExtension(),
      ...(options.env !== undefined ? { env: options.env } : {}),
      store: controller.store,
      onEvent: (event) => {
        observers.onWorkflowEvent(event);
      },
    });
  } catch (error) {
    observers.onConfigFailure(error);
    throw error;
  }

  const workspaceCoordinator = new WorkspaceLifecycleCoordinator(controller, observers);

  const trackerProxy: TrackerAdapter = {
    get kind() {
      return controller.current.adapter.kind;
    },
    fetchIssuesByStates(states) {
      return controller.current.adapter.fetchIssuesByStates(states);
    },
    fetchIssuesByIds(ids) {
      return controller.current.adapter.fetchIssuesByIds(ids);
    },
  };

  const preflight: DispatchPreflightSource = {
    preflight: (): DispatchPreflightResult => {
      const result = watcher.reloadWithResult({ ifChanged: true });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error.message,
        };
      }
      return {
        ok: true,
        effective: controller.current.scheduling,
      };
    },
  };

  const initialEffective = controller.current.scheduling;
  const state = createOrchestratorRuntimeState(initialEffective);

  const cleanupWorkspace: RetryWorkspaceCleanup = {
    removeWorkspace: (identifier: string) => cleanupWorkspace.removeWorkspaceForIssue!({ issueId: null, identifier }),
    removeWorkspaceForIssue: async (context: WorkspaceCleanupIssueContext) => {
      const { manager, release } = workspaceCoordinator.resolveForCleanup(context);
      const result = await manager.removeWorkspace(context.identifier, {
        hooks: controller.current.serviceConfig.hooks,
        onHookEvent: observers.onHookEventForIssue(context),
      });
      if (result.status === "removed" || result.status === "missing") {
        release();
      }
      return result;
    },
  };

  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const clock: SnapshotClock = {
    wallNow: () => now(),
    monotonicNow: () => monotonicNow(),
  };

  const authority = new OrchestratorAuthority({
    state,
    policy: controller.current.scheduling.policy,
    tracker: trackerProxy,
    runner: runAgentAttempt,
    createAttemptOptions: (context) => workspaceCoordinator.createAttemptOptions(context),
    resolveWorkspacePath: (issue) => workspaceCoordinator.resolveForDispatch(issue),
    onEvent: observers.onEvent,
    onOutcome: observers.onOutcome,
    onCleanupDiagnostic: observers.onCleanupDiagnostic,
    cleanupWorkspace,
    stallTimeoutMs: () => controller.current.serviceConfig.codex.stallTimeoutMs,
    retry: {
      ...(options.retryScheduler !== undefined ? { scheduler: options.retryScheduler } : {}),
      maxRetryBackoffMs: () => controller.current.serviceConfig.agent.maxRetryBackoffMs,
      cleanupWorkspace,
      onDiagnostic: observers.onCleanupDiagnostic,
    },
    now,
    monotonicNow,
  });

  controller.setAuthority(authority);

  const loop = new OrchestratorLoop({
    authority,
    candidates: trackerProxy,
    preflight,
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    onDiagnostic: observers.onDiagnostic,
  });

  return {
    workflowPath,
    get effective() {
      return controller.current.effectiveWorkflow;
    },
    state,
    authority,
    cleanupWorkspace,
    workspaceCoordinator,
    tracker: trackerProxy,
    loop,
    logger,
    clock,
    getSnapshot: () => projectObservabilitySnapshot(state, clock),
    tryGetSnapshot: () => tryProjectObservabilitySnapshot(state, clock),
    async start() {
      observers.lifecycle({ event: "startup", outcome: "started" });
      try {
        await loop.start();
        observers.lifecycle({ event: "startup", outcome: "completed" });
      } catch (error) {
        observers.lifecycle({ event: "startup", outcome: "failed" });
        throw error;
      }
    },
    async stop() {
      observers.lifecycle({ event: "shutdown", outcome: "started" });
      try {
        watcher.close();
        await loop.stop();
        observers.lifecycle({ event: "shutdown", outcome: "completed" });
      } finally {
        logger.close();
      }
    },
  };
}
