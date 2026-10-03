/** Read-only observation contracts (SPEC §13.3 / §13.5); never scheduler inputs. */
import type { CodexTotals, OrchestratorRuntimeState, RunningEntry } from "./orchestrator";
import type { RetryEntry } from "./retry";
import type { LiveSession } from "./session";
import type { RunAttempt, RunAttemptStatus } from "./run";
import type { MonotonicTimestampMs, UtcTimestampMs } from "./time";

export interface SnapshotClock {
  readonly wallNow: () => UtcTimestampMs;
  /** MUST use the same source as authority's monotonicNow. */
  readonly monotonicNow: () => MonotonicTimestampMs;
}

type RunningView = Readonly<Pick<RunningEntry, "workspacePath" | "startedAtMs">> & {
  readonly issue: Readonly<Pick<RunningEntry["issue"], "id" | "identifier" | "url" | "state">>;
  readonly attempt: Readonly<Pick<RunAttempt, "attempt" | "status" | "startedAt">>;
  readonly session: Readonly<LiveSession> | null;
};
export type ObservabilityRuntimeView = Readonly<Pick<OrchestratorRuntimeState,
  "pollIntervalMs" | "maxConcurrentAgents" | "codexRateLimits">> & {
  readonly running: ReadonlyMap<string, RunningView>;
  readonly retryAttempts: ReadonlyMap<string, Readonly<Omit<RetryEntry, "timerHandle">>>;
  readonly codexTotals: Readonly<CodexTotals>;
};

export interface SnapshotTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
export interface ObservabilityRunningRow {
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly issueUrl: string | null;
  readonly issueState: string;
  readonly attempt: number | null;
  readonly status: RunAttemptStatus;
  readonly workspacePath: string;
  readonly startedAt: UtcTimestampMs;
  readonly elapsedMs: number;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly codexAppServerPid: string | null;
  readonly turnCount: number | null;
  readonly lastCodexEvent: string | null;
  readonly lastCodexMessage: string | null;
  readonly lastCodexTimestamp: UtcTimestampMs | null;
  readonly tokens: SnapshotTokens | null;
}
export interface ObservabilityRetryRow {
  readonly issueId: string;
  readonly issueIdentifier: string | null;
  readonly issueUrl: string | null;
  readonly attempt: number;
  readonly retryInMs: number;
  readonly error: string | null;
}
export type SnapshotValue = null | undefined | string | number | boolean | bigint |
  readonly SnapshotValue[] | { readonly [key: string]: SnapshotValue };
export interface ObservabilitySnapshot {
  readonly generatedAt: UtcTimestampMs;
  readonly pollIntervalMs: number;
  readonly maxConcurrentAgents: number;
  readonly running: readonly ObservabilityRunningRow[];
  readonly retrying: readonly ObservabilityRetryRow[];
  readonly codexTotals: Readonly<CodexTotals>;
  readonly rateLimits: { readonly [key: string]: SnapshotValue } | null;
}
export type SnapshotResult =
  | { readonly status: "available"; readonly snapshot: ObservabilitySnapshot }
  | { readonly status: "unavailable"; readonly reason: "runtime_unavailable" | "projection_failed" };
