import { runAgentAttempt } from "@symphony/agent";
import { loadEffectiveWorkflow, type EffectiveWorkflow } from "@symphony/config";
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
  type DispatchPolicy,
  type DispatchPreflightResult,
  type EffectiveSchedulingConfig,
  type PollScheduler,
  type RetryScheduler,
} from "@symphony/orchestrator";
import {
  createGitHubAdapterProfile,
  TrackerAdapterRegistry,
  type TrackerAdapter,
  type TrackerAdapterProfile,
  type TrackerEnv,
} from "@symphony/tracker";
import { createWorkspaceManager } from "@symphony/workspace";
import { resolveWorkflowPath } from "./args";
import { createRuntimeLogObservers, registerTrackerLogSecrets } from "./logging";

export interface SymphonyHost {
  readonly workflowPath: string;
  readonly effective: EffectiveWorkflow;
  readonly state: OrchestratorRuntimeState;
  readonly authority: OrchestratorAuthority;
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
}

export async function createHost(options: CreateHostOptions = {}): Promise<SymphonyHost> {
  const workflowPath = resolveWorkflowPath(options.workflowPath, options.cwd);
  const logger = options.logger ?? createStructuredLogger();
  const observers = createRuntimeLogObservers(logger);

  const registry = options.trackerProfiles !== undefined
    ? new TrackerAdapterRegistry(options.trackerProfiles)
    : new TrackerAdapterRegistry([createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord })]);

  let effective: EffectiveWorkflow;
  try {
    effective = loadEffectiveWorkflow({
      path: workflowPath,
      trackerExtension: registry.createConfigExtension(),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  } catch (error) {
    observers.onConfigFailure(error);
    throw error;
  }

  const profile = registry.lookup(effective.serviceConfig.tracker.kind);
  if (profile) {
    registerTrackerLogSecrets(
      logger,
      profile,
      effective.serviceConfig.tracker.provider,
      options.env ?? process.env,
    );
  }

  let rawAdapter: TrackerAdapter;
  try {
    rawAdapter = registry.create(effective.serviceConfig.tracker, options.env);
  } catch (error) {
    observers.onConfigFailure(error);
    throw error;
  }
  const adapter = observers.observeTracker(rawAdapter);

  const command = effective.serviceConfig.codex.command.trim();
  if (!command) {
    const error = new Error("codex.command is empty");
    observers.onConfigFailure(error);
    throw error;
  }

  const manager = createWorkspaceManager({ workspace: effective.serviceConfig.workspace });

  const activeStates = effective.serviceConfig.tracker.activeStates ?? profile?.defaultActiveStates ?? [];
  const terminalStates = effective.serviceConfig.tracker.terminalStates ?? profile?.defaultTerminalStates ?? [];
  const policy: DispatchPolicy = {
    activeStates,
    terminalStates,
    requiredLabels: effective.serviceConfig.tracker.requiredLabels,
    maxConcurrentAgentsByState: effective.serviceConfig.agent.maxConcurrentAgentsByState,
  };
  const initialEffective: EffectiveSchedulingConfig = {
    pollIntervalMs: effective.serviceConfig.polling.intervalMs,
    maxConcurrentAgents: effective.serviceConfig.agent.maxConcurrentAgents,
    policy,
  };

  const preflight = {
    preflight: (): DispatchPreflightResult => ({
      ok: true,
      effective: initialEffective,
    }),
  };

  const state = createOrchestratorRuntimeState(initialEffective);

  const cleanupWorkspace = observers.observeCleanup(manager, () => effective.serviceConfig.hooks);

  const now = options.now ?? (() => Date.now());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const clock: SnapshotClock = {
    wallNow: () => now(),
    monotonicNow: () => monotonicNow(),
  };

  const authority = new OrchestratorAuthority({
    state,
    policy,
    tracker: adapter,
    runner: runAgentAttempt,
    createAttemptOptions: (context) => observers.observeAttempt({
      ...context,
      workflow: effective.definition,
      workflowPath,
      getConfig: () => effective.serviceConfig,
    }),
    resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
    onEvent: observers.onEvent,
    onOutcome: observers.onOutcome,
    onCleanupDiagnostic: observers.onCleanupDiagnostic,
    cleanupWorkspace,
    stallTimeoutMs: () => effective.serviceConfig.codex.stallTimeoutMs,
    retry: {
      ...(options.retryScheduler !== undefined ? { scheduler: options.retryScheduler } : {}),
      maxRetryBackoffMs: () => effective.serviceConfig.agent.maxRetryBackoffMs,
      cleanupWorkspace,
      onDiagnostic: observers.onCleanupDiagnostic,
    },
    now,
    monotonicNow,
  });

  const loop = new OrchestratorLoop({
    authority,
    candidates: adapter,
    preflight,
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    onDiagnostic: observers.onDiagnostic,
  });

  return {
    workflowPath,
    effective,
    state,
    authority,
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
        await loop.stop();
        observers.lifecycle({ event: "shutdown", outcome: "completed" });
      } finally {
        logger.close();
      }
    },
  };
}

