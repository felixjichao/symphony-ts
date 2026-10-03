/** M6.2 composition helpers only. Production host lifecycle belongs to M6.3–M6.5. */
import { isAgentEventName, type AgentAttemptOptions, type AgentEvent } from "@symphony/agent";
import { SymphonyConfigError, type WorkflowReloadEvent } from "@symphony/config";
import type { StructuredLogger, StructuredLogEvent } from "@symphony/observability";
import type { OrchestratorEvent, WorkerTerminalOutcome, LoopDiagnostic, RetryDiagnostic } from "@symphony/orchestrator";
import { TrackerError, type TrackerAdapter, type TrackerAdapterProfile, type TrackerEnv, type GitHubMalformedRecord } from "@symphony/tracker";
import type { WorkspaceHookEvent } from "@symphony/workspace";

/** Register raw/resolved candidate secrets before construction or failure logging; retain old values. */
export function registerTrackerLogSecrets(logger: StructuredLogger, profile: TrackerAdapterProfile,
  provider: Readonly<Record<string, unknown>>, env: TrackerEnv): void {
  const values: string[] = [];
  for (const key of profile.secretProviderKeys) {
    const value = provider[key];
    if (typeof value === "string") values.push(value);
  }
  for (const name of profile.secretEnvVars) {
    const value = env[name];
    if (value !== undefined) values.push(value);
  }
  logger.registerSecrets(values);
}
export function createRuntimeLogObservers(logger: StructuredLogger) {
  // Protect port adapters as well as logger.emit: custom loggers and hostile properties may throw.
  const safe = <T>(observer: (value: T) => void) => (value: T): void => {
    try { observer(value); } catch { /* observation cannot alter correctness */ }
  };
  const service = (event: string, outcome: StructuredLogEvent["outcome"], reason: string): void =>
    logger.emit({ scope: "service", severity: outcome === "failed" ? "error" : "info", event, outcome, reason });
  return {
    lifecycle: safe((fact: { event: "startup" | "shutdown"; outcome: "started" | "completed" | "failed" }) =>
      service(fact.event, fact.outcome, `${fact.event}_${fact.outcome}`)),
    onConfigFailure: safe((error: unknown) => service("config_validation", "failed",
      error instanceof SymphonyConfigError ? error.code : error instanceof TrackerError ? error.category : "config_validation_failed")),
    onWorkflowEvent: safe((event: WorkflowReloadEvent) =>
      // Watcher acceptance is distinct from future effective-runtime commit.
      service("workflow_reload", event.kind === "error" ? "failed" : "completed", event.kind === "error" ? "workflow_rejected" : "watcher_version_accepted")),
    onDiagnostic: safe((diagnostic: LoopDiagnostic) => service("orchestrator_diagnostic", "failed", diagnostic.kind)),
    onMalformedRecord: safe((_record: GitHubMalformedRecord) => logger.emit({ scope: "service", severity: "warn", event: "tracker_record_omitted", outcome: "omitted", reason: "malformed_state_list_record" })),
    onEvent: safe((fact: OrchestratorEvent) => logger.emit({
      scope: "issue", severity: fact.event === "dispatch_failed" ? "error" : "info",
      event: fact.event, outcome: fact.event === "retry_scheduled" ? "retrying" : fact.event === "dispatch_failed" ? "failed" : fact.event === "reconciliation_applied" ? "stopped" : "started",
      reason: "reason" in fact ? fact.reason : fact.event,
      issue_id: fact.issueId, issue_identifier: fact.issueIdentifier,
      ...(fact.issueUrl === undefined ? {} : { issue_url: fact.issueUrl }),
      ...("attempt" in fact ? { attempt: fact.attempt } : {}),
      ...(fact.event === "retry_scheduled" ? { retry_in_ms: fact.retryInMs, retry_kind: fact.retryKind } : {}),
      ...(fact.event === "reconciliation_applied" ? { status: fact.action } : {}),
    })),
    onOutcome: safe((terminal: WorkerTerminalOutcome) => logger.emit({
      ...(terminal.sessionId ? { scope: "session", session_id: terminal.sessionId } as const : { scope: "issue" } as const),
      severity: terminal.status === "succeeded" ? "info" : "warn", event: "worker_finished",
      outcome: terminal.status === "succeeded" ? "completed" : terminal.stopReason ? "stopped" : "failed",
      reason: terminal.stopReason?.kind ?? terminal.status, status: terminal.status,
      issue_id: terminal.issueId, issue_identifier: terminal.issueIdentifier,
      issue_url: terminal.issueUrl ?? null, attempt: terminal.attempt, duration_ms: terminal.durationMs,
      // Error text/result can contain provider payload; stable classification is sufficient.
    })),
    onCleanupDiagnostic: safe((diagnostic: RetryDiagnostic) => logger.emit({
      ...(diagnostic.issueId !== null || diagnostic.identifier !== null ? { scope: "issue", issue_id: diagnostic.issueId, issue_identifier: diagnostic.identifier } as const : { scope: "service" } as const),
      severity: diagnostic.kind === "cleanup_completed" ? "info" : "warn", event: "workspace_cleanup",
      outcome: diagnostic.kind === "cleanup_completed" ? "completed" : "failed", reason: diagnostic.kind,
      ...(diagnostic.cleanupStatus === undefined ? {} : { status: diagnostic.cleanupStatus }),
    })),
    observeTracker(adapter: TrackerAdapter): TrackerAdapter {
      const operation = async <T>(invoke: () => Promise<T>): Promise<T> => {
        try { return await invoke(); }
        catch (error) {
          try { service("tracker_error", "failed", error instanceof TrackerError ? error.category : "tracker_runtime_error"); } catch { /* preserve original failure */ }
          throw error;
        }
      };
      return { kind: adapter.kind,
        fetchIssuesByStates: (states) => operation(() => adapter.fetchIssuesByStates(states)),
        fetchIssuesByIds: (ids) => operation(() => adapter.fetchIssuesByIds(ids)),
      };
    },
    observeAttempt(options: AgentAttemptOptions): AgentAttemptOptions {
      const identity = { issue_id: options.issue.id, issue_identifier: options.issue.identifier, issue_url: options.issue.url, attempt: options.attempt };
      let sessionId: string | undefined;
      const onEvent = safe((event: AgentEvent) => {
        if (event.sessionId) sessionId = event.sessionId;
        const name = event.event === "session_started" && !event.sessionId ? "agent_thread_started" : isAgentEventName(event.event) ? event.event : "agent_event";
        logger.emit({ ...identity,
          ...(event.sessionId ? { scope: "session", session_id: event.sessionId } as const : { scope: "issue" } as const),
          severity: /failed|error|malformed/.test(name) ? "warn" : "info", event: name,
          outcome: /failed|error/.test(name) ? "failed" : /completed/.test(name) ? "completed" : /cancelled/.test(name) ? "stopped" : "started",
          reason: name, codex_app_server_pid: event.codexAppServerPid,
          ...(event.threadId === undefined ? {} : { thread_id: event.threadId }),
          ...(event.turnId === undefined ? {} : { turn_id: event.turnId }),
        });
      });
      const onHookEvent = safe((event: WorkspaceHookEvent) => logger.emit({ ...identity, scope: "issue", severity: "warn", event: "workspace_hook", outcome: "failed", reason: event.outcome, hook: event.hook }));
      const onStderr = safe((line: string) => logger.emit({ ...identity,
        ...(sessionId ? { scope: "session", session_id: sessionId } as const : { scope: "issue" } as const),
        severity: "warn", event: "agent_stderr", outcome: "completed", reason: "stderr_diagnostic",
        stderr: /^\s*[{[]/.test(line) ? "diagnostic payload omitted" : line,
      }));
      return { ...options,
        onEvent(event) { try { options.onEvent?.(event); } finally { onEvent(event); } },
        onHookEvent(event) { try { options.onHookEvent?.(event); } finally { onHookEvent(event); } },
        onStderr(line) { try { options.onStderr?.(line); } finally { onStderr(line); } },
      };
    },
  };
}
