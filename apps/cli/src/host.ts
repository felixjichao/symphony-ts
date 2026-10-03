import { runAgentAttempt } from "@symphony/agent";
import {
  watchWorkflow,
  type EffectiveWorkflow,
  type WorkflowWatchHandle,
  type WorkflowWatchScheduler,
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
  readonly failure: Promise<unknown>;
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
  readonly watcherScheduler?: WorkflowWatchScheduler | undefined;
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

  let reportFailure!: (error: unknown) => void;
  const failure = new Promise<unknown>((resolve) => { reportFailure = resolve; });
  let watcher: WorkflowWatchHandle;
  try {
    watcher = watchWorkflow({
      path: workflowPath,
      autoStart: false,
      ...(options.watcherScheduler !== undefined ? { scheduler: options.watcherScheduler } : {}),
      onFatal: reportFailure,
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
    try { logger.close(); } catch { /* Preserve initial validation failure. */ }
    throw error;
  }

  try {
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
        const result = watcher.reloadWithResult();
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

    let stopping = false;
    let startPromise: Promise<void> | undefined;
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (stopPromise !== undefined) return stopPromise;
      stopping = true;
      let resolveStop!: () => void;
      let rejectStop!: (error: unknown) => void;
      stopPromise = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
      controller.close();
      observers.lifecycle({ event: "shutdown", outcome: "started" });
      const errors: unknown[] = [];
      try { watcher.close(); } catch (error) { errors.push(error); }
      // Call the loop's synchronous shutdown prefix before waiting for startup.
      let shutdown: Promise<void>;
      try { shutdown = loop.stop(); } catch (error) { shutdown = Promise.reject(error); }
      void (async () => {
        try { await shutdown; } catch (error) { errors.push(error); }
        observers.lifecycle({ event: "shutdown", outcome: errors.length ? "failed" : "completed" });
        try { logger.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Host shutdown failed");
      })().then(resolveStop, rejectStop);
      return stopPromise;
    };

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
      failure,
      start() {
        if (stopping) return Promise.reject(new Error("Host is stopped"));
        if (startPromise !== undefined) return startPromise;
        observers.lifecycle({ event: "startup", outcome: "started" });
        startPromise = (async () => {
          try {
            watcher.startMonitoring();
            if (stopping) return;
            await loop.start();
            if (!stopping) observers.lifecycle({ event: "startup", outcome: "completed" });
          } catch (error) {
            observers.lifecycle({ event: "startup", outcome: "failed" });
            try { await stop(); } catch { /* Preserve the original startup failure. */ }
            throw error;
          }
        })();
        return startPromise;
      },
      stop,
    };
  } catch (error) {
    controller.close();
    try { watcher.close(); } catch { /* Continue construction rollback. */ }
    try { logger.close(); } catch { /* Preserve the original construction failure. */ }
    throw error;
  }
}
