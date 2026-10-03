/** Structured logging context, SPEC §13.1 / §13.2. No raw payload extension. */
interface LogFields {
  readonly timestamp?: string;
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly outcome: "started" | "completed" | "failed" | "retrying" | "stopped" | "omitted";
  readonly reason?: string;
  readonly message?: string;
  readonly error?: string;
  readonly stderr?: string;
  readonly issue_url?: string | null;
  readonly attempt?: number | null;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly codex_app_server_pid?: string | null;
  readonly status?: string;
  readonly duration_ms?: number;
  readonly retry_in_ms?: number;
  readonly retry_kind?: string;
  readonly hook?: string;
  readonly error_code?: string;
  readonly operation?: "fetch_issues_by_states" | "fetch_issues_by_ids";
}
export type StructuredLogEvent = LogFields & (
  | { readonly scope: "service" }
  | { readonly scope: "issue"; readonly issue_id: string | null; readonly issue_identifier: string | null }
  | { readonly scope: "session"; readonly issue_id: string | null; readonly issue_identifier: string | null; readonly session_id: string }
);
