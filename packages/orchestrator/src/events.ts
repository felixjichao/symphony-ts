/** Committed facts only (SPEC §13.1). Scalars; no handles or scheduler input. */
interface EventIdentity {
  readonly issueId: string;
  readonly issueIdentifier: string | null;
  readonly issueUrl?: string | null;
}
export type RetryEventReason = "worker_failure" | "continuation" | "tracker_refresh_failed" |
  "no_available_slots" | "dispatch_failed" | "manual_retry";
export type OrchestratorEvent = Readonly<EventIdentity & (
  | { event: "dispatch_committed" | "worker_started"; attempt: number | null }
  | { event: "dispatch_failed" }
  | { event: "retry_scheduled"; attempt: number; retryInMs: number;
      retryKind: "continuation" | "failure"; reason: RetryEventReason }
  | { event: "reconciliation_applied"; action: "stop" | "retire_exited_lifecycle";
      reason: "missing" | "terminal" | "inactive" | "unroutable" }
)>;
