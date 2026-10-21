import { createHostWorkContinuity } from "./work-continuity";
import fs from "node:fs";
import path from "node:path";
import { runAgentAttempt } from "@symphony/agent";
import {
  SymphonyConfigError,
  watchWorkflow,
  type EffectiveWorkflow,
  type WorkflowWatchHandle,
  type WorkflowWatchScheduler,
} from "@symphony/config";
import {
  decisionSessionId,
  githubDecisionRoot,
  type DecisionMaterializedPlan,
  type Issue,
  type OrchestratorRuntimeState,
} from "@symphony/domain";
import {
  DecisionBridgeClient,
  DecisionPlanningGate,
  DecisionService,
  DurableDecisionStore,
} from "@symphony/decision";

function resolveIssueSessionId(issue: Issue, fallbackRepo?: string | null): string | null {
  if (issue.nativeRef && typeof issue.nativeRef["repo"] === "string" && typeof issue.nativeRef["number"] === "number") {
    const parts = (issue.nativeRef["repo"] as string).split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return decisionSessionId(githubDecisionRoot(parts[0], parts[1], issue.nativeRef["number"] as number));
    }
  }
  if (issue.url) {
    const match = issue.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
    if (match && match[1] && match[2] && match[3]) {
      return decisionSessionId(githubDecisionRoot(match[1], match[2], Number(match[3])));
    }
  }
  const repoToUse = fallbackRepo ?? (issue.nativeRef && typeof issue.nativeRef["repo"] === "string" ? (issue.nativeRef["repo"] as string) : null);
  if (repoToUse) {
    const parts = repoToUse.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      const num = Number(issue.id.replace(/^GH-/, "")) || Number(issue.identifier.replace(/^GH-/, ""));
      if (!Number.isNaN(num) && num > 0) {
        return decisionSessionId(githubDecisionRoot(parts[0], parts[1], num));
      }
    }
  }
  return null;
}
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
  readonly workContinuity: ReturnType<typeof createHostWorkContinuity>["coordinator"];
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
  readonly canDispatch?: ((issue: Issue, context: { readonly isRetry: boolean }) => boolean) | undefined;
  readonly getPlanForIssue?: ((issue: Issue) => DecisionMaterializedPlan | null | undefined) | undefined;
  readonly continuityGitHub?: Parameters<typeof createHostWorkContinuity>[0]["github"] | undefined;
  readonly enablePlanning?: boolean | undefined;
  readonly decisionStoreDir?: string | undefined;
  readonly decisionBridgeUrl?: string | undefined;
  readonly decisionBridgeToken?: string | undefined;
  readonly planningGate?: DecisionPlanningGate | undefined;
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

  const cwd = options.cwd ?? process.cwd();
  const defaultStoreDir = path.join(cwd, ".symphony", "decision");

  if (options.decisionStoreDir !== undefined && options.decisionBridgeUrl !== undefined) {
    throw new SymphonyConfigError("invalid_config", "Conflicting backend options: cannot specify both decisionStoreDir and decisionBridgeUrl", { path: workflowPath });
  }

  const explicitStoreDir = options.decisionStoreDir;
  const explicitBridgeUrl = options.decisionBridgeUrl;
  const envBridgeUrl = options.env !== undefined ? options.env["DECISION_BRIDGE_URL"] : process.env["DECISION_BRIDGE_URL"];
  const envStoreDir = options.env !== undefined ? options.env["DECISION_STORE_DIR"] : process.env["DECISION_STORE_DIR"];
  const envBridgeToken = options.env !== undefined ? options.env["DECISION_BRIDGE_TOKEN"] : process.env["DECISION_BRIDGE_TOKEN"];
  const envPlanningEnabled = options.env !== undefined ? options.env["SYMPHONY_PLANNING_ENABLED"] : process.env["SYMPHONY_PLANNING_ENABLED"];

  const isExplicitlyDisabled =
    options.enablePlanning === false ||
    envPlanningEnabled === "0" ||
    envPlanningEnabled === "false";
  const isExplicitlyEnabled =
    options.enablePlanning === true ||
    envPlanningEnabled === "1" ||
    envPlanningEnabled === "true";

  let planningGate: DecisionPlanningGate | null = options.planningGate ?? null;
  let ownedStore: DurableDecisionStore | null = null;

  if (!planningGate && !isExplicitlyDisabled) {
    if (explicitStoreDir !== undefined) {
      if (!fs.existsSync(explicitStoreDir)) {
        fs.mkdirSync(explicitStoreDir, { recursive: true });
      }
      ownedStore = new DurableDecisionStore({ storeDir: explicitStoreDir });
      await ownedStore.open();
      const service = new DecisionService(ownedStore);
      planningGate = new DecisionPlanningGate(service);
    } else if (explicitBridgeUrl !== undefined) {
      const token = options.decisionBridgeToken ?? envBridgeToken;
      const client = new DecisionBridgeClient(explicitBridgeUrl, { ...(token ? { authToken: token } : {}) });
      planningGate = new DecisionPlanningGate(client);
    } else if (envBridgeUrl) {
      const token = options.decisionBridgeToken ?? envBridgeToken;
      const client = new DecisionBridgeClient(envBridgeUrl, { ...(token ? { authToken: token } : {}) });
      planningGate = new DecisionPlanningGate(client);
    } else if (envStoreDir || isExplicitlyEnabled || fs.existsSync(defaultStoreDir)) {
      const storeDir = envStoreDir ?? defaultStoreDir;
      if (!fs.existsSync(storeDir)) {
        fs.mkdirSync(storeDir, { recursive: true });
      }
      ownedStore = new DurableDecisionStore({ storeDir });
      await ownedStore.open();
      const service = new DecisionService(ownedStore);
      planningGate = new DecisionPlanningGate(service);
    }
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

    const getEffectiveRepo = (): string | null => {
      const provider = controller.current.serviceConfig.tracker?.provider as Record<string, unknown> | undefined;
      return typeof provider?.["repo"] === "string" ? (provider["repo"] as string) : null;
    };

    const getPlanForIssue = (issue: Issue): DecisionMaterializedPlan | null => {
      if (options.getPlanForIssue) {
        const customPlan = options.getPlanForIssue(issue);
        if (customPlan !== undefined) {
          return customPlan;
        }
      }
      if (!planningGate) {
        return null;
      }
      const sessionId = resolveIssueSessionId(issue, getEffectiveRepo());
      if (!sessionId) {
        return null;
      }
      const record = planningGate.getLatestPlanSync(sessionId);
      if (record?.result && record.result.verdict === "ready") {
        return {
          taskId: record.taskId,
          revision: record.revision,
          plan: record.result.content.plan,
          acceptanceCriteria: record.result.content.acceptanceCriteria,
          risks: record.result.content.risks,
          clarifications: record.requirements.clarifications ?? [],
        };
      }
      return null;
    };

    let continuity: ReturnType<typeof createHostWorkContinuity> | null = null;
    const canDispatch = (issue: Issue, context: { readonly isRetry: boolean }): boolean => {
      if (options.canDispatch && !options.canDispatch(issue, context)) {
        return false;
      }
      if (!planningGate) {
        return true;
      }
      const sessionId = resolveIssueSessionId(issue, getEffectiveRepo());
      if (!sessionId) {
        return false;
      }
      const requirements = {
        title: issue.title,
        body: issue.description ?? "",
      };
      const eligibility = planningGate.verifyPlanEligibilitySync(sessionId, requirements);
      return eligibility.eligible;
    };

    const authority = new OrchestratorAuthority({
      state,
      policy: controller.current.scheduling.policy,
      tracker: trackerProxy,
      runner: runAgentAttempt,
      createAttemptOptions: (context) =>
        workspaceCoordinator.createAttemptOptions(context, {
          plan: getPlanForIssue(context.issue),
        }),
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
      canDispatch,
      refreshDispatch: issue => continuity ? continuity.refreshDispatch(issue) : Promise.resolve(null),
    });

    controller.setAuthority(authority);

    continuity = createHostWorkContinuity({ controller, authority, planningGate,
      resolveSession: issue => resolveIssueSessionId(issue, getEffectiveRepo()), now,
      github: options.continuityGitHub });
    const workContinuity = continuity.coordinator;
    const loop = new OrchestratorLoop({
      authority,
      workContinuity,
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
        if (ownedStore) {
          try { await ownedStore.close(); } catch (error) { errors.push(error); }
        }
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
      workContinuity,
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
    if (ownedStore) {
      try { await ownedStore.close(); } catch { /* Continue construction rollback. */ }
    }
    controller.close();
    try { watcher.close(); } catch { /* Continue construction rollback. */ }
    try { logger.close(); } catch { /* Preserve the original construction failure. */ }
    throw error;
  }
}
