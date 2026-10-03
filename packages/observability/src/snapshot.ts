/** Synchronous, isolated projection (SPEC §13.3 / §13.5). No state writes or I/O. */
import type {
  ObservabilityRuntimeView, ObservabilitySnapshot, SnapshotClock, SnapshotResult, SnapshotValue,
} from "@symphony/domain";

/** Reject exotic mutable containers rather than exposing them in a public snapshot. */
function assertSnapshotValue(value: unknown, seen = new WeakSet<object>()): asserts value is SnapshotValue {
  if (value === null || value === undefined || ["string", "number", "boolean", "bigint"].includes(typeof value)) return;
  if (typeof value !== "object") throw new TypeError("Unsupported snapshot payload");
  if (seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Unsupported snapshot container");
  }
  for (const nested of Object.values(value)) assertSnapshotValue(nested, seen);
}

export function projectObservabilitySnapshot(state: ObservabilityRuntimeView, clock: SnapshotClock): ObservabilitySnapshot {
  const generatedAt = clock.wallNow();
  const monotonicNow = clock.monotonicNow();
  const running = [...state.running.values()].map((entry) => {
    const session = entry.session;
    return {
      issueId: entry.issue.id,
      issueIdentifier: entry.issue.identifier,
      issueUrl: entry.issue.url,
      issueState: entry.issue.state,
      attempt: entry.attempt.attempt,
      status: entry.attempt.status,
      workspacePath: entry.workspacePath,
      startedAt: entry.attempt.startedAt,
      elapsedMs: Math.max(0, monotonicNow - entry.startedAtMs),
      sessionId: session?.sessionId ?? null,
      threadId: session?.threadId ?? null,
      turnId: session?.turnId ?? null,
      codexAppServerPid: session?.codexAppServerPid ?? null,
      turnCount: session?.turnCount ?? null,
      lastCodexEvent: session?.lastCodexEvent ?? null,
      lastCodexMessage: session?.lastCodexMessage ?? null,
      lastCodexTimestamp: session?.lastCodexTimestamp ?? null,
      tokens: session === null ? null : {
        inputTokens: session.codexInputTokens,
        outputTokens: session.codexOutputTokens,
        totalTokens: session.codexTotalTokens,
      },
    };
  }).sort((a, b) => a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0);
  const retrying = [...state.retryAttempts.values()].map((entry) => ({
    issueId: entry.issueId,
    issueIdentifier: entry.identifier,
    issueUrl: entry.issueUrl ?? null,
    attempt: entry.attempt,
    retryInMs: Math.max(0, entry.dueAtMs - monotonicNow),
    error: entry.error,
  })).sort((a, b) => a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0);
  const rateLimits: unknown = structuredClone(state.codexRateLimits);
  assertSnapshotValue(rateLimits);
  // The root is a record by the runtime contract; nested exotic values were rejected above.
  return {
    generatedAt,
    pollIntervalMs: state.pollIntervalMs,
    maxConcurrentAgents: state.maxConcurrentAgents,
    running,
    retrying,
    codexTotals: {
      inputTokens: state.codexTotals.inputTokens,
      outputTokens: state.codexTotals.outputTokens,
      totalTokens: state.codexTotals.totalTokens,
      secondsRunning: state.codexTotals.secondsRunning + running.reduce((sum, row) => sum + row.elapsedMs, 0) / 1000,
    },
    rateLimits: rateLimits as ObservabilitySnapshot["rateLimits"],
  };
}

/** No timeout: a future asynchronous acquisition layer must own that budget. */
export function tryProjectObservabilitySnapshot(state: ObservabilityRuntimeView | null, clock: SnapshotClock): SnapshotResult {
  if (state === null) return { status: "unavailable", reason: "runtime_unavailable" };
  try {
    return { status: "available", snapshot: projectObservabilitySnapshot(state, clock) };
  } catch {
    return { status: "unavailable", reason: "projection_failed" };
  }
}
