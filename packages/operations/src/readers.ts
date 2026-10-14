/** SPEC §13 adjacent / #110: one-shot read-only observations, never projections. */
import {
  DeliveryError, githubWorkKey, parseWorkKey,
  type DecisionObservation, type DecisionWorkFacts, type ExecutorFacts,
  type GitHubObservation, type GitHubWorkFacts, type OperationFactCollection,
  type OperationSourceKind, type OperationSourceResult, type RuntimeWorkFacts,
  type SnapshotResult, type WorkKey,
} from "@symphony/domain";

export interface ReaderOptions {
  readonly instance: string;
  readonly clock: () => number;
  readonly maxAgeMs: number;
}
export interface Observation<T> { readonly facts: T; readonly observedAt: number }
export interface SourceReader<T> {
  read(): Promise<OperationSourceResult<T>>;
}
class SourceReadError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function reader<T>(source: OperationSourceKind, options: ReaderOptions,
  read: (() => Observation<T> | Promise<Observation<T>>) | null): SourceReader<T> {
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0 || !options.instance) {
    throw new TypeError("Invalid source policy");
  }
  return { async read() {
    if (read === null) return { source, instance: options.instance, facts: null,
      freshness: { status: "unknown", lastAttemptAt: null, reason: "source_not_configured" } };
    const attemptedAt = options.clock();
    try {
      const observation = await read();
      const now = options.clock();
      if (!Number.isFinite(observation.observedAt) || observation.observedAt < 0 || observation.observedAt > now) {
        throw new SourceReadError("invalid_observation_time");
      }
      return { source, instance: options.instance, facts: observation.facts,
        freshness: { status: now - observation.observedAt > options.maxAgeMs ? "stale" : "fresh",
          observedAt: observation.observedAt, lastAttemptAt: Math.max(attemptedAt, observation.observedAt) } };
    } catch (error) {
      return { source, instance: options.instance, facts: null,
        freshness: { status: "unavailable", observedAt: null, lastAttemptAt: attemptedAt,
          reason: error instanceof SourceReadError ? error.reason : error instanceof DeliveryError ? error.code : "source_read_failed" } };
    }
  } };
}
function provenance(source: OperationSourceKind, options: ReaderOptions, observedAt: number) {
  return { source, instance: options.instance, observedAt };
}
function keyCopy(key: WorkKey): WorkKey { return { ...parseWorkKey(key) }; }

/** Host binds the tracker reader to a canonical work item and trusted delivery identity. */
export function createGitHubReader(options: ReaderOptions,
  read: (() => Promise<GitHubObservation>) | null): SourceReader<GitHubWorkFacts> {
  return reader("github", options, read === null ? null : async () => {
    const value = await read();
    const observedAt = options.clock();
    const pr = value.pullRequest;
    if (pr && !/^[0-9a-f]{40}$/.test(pr.headSha)) throw new SourceReadError("invalid_head_sha");
    if (value.ci && (!pr || value.ci.headSha !== pr.headSha)) throw new SourceReadError("head_changed");
    return { observedAt, facts: {
      workKey: keyCopy(value.workKey), issue: { state: value.issue.state, url: value.issue.url },
      pullRequest: pr ? { number: pr.number, state: pr.state, url: pr.url, headSha: pr.headSha, isDraft: pr.isDraft } : null,
      ci: value.ci ? { status: value.ci.status, headSha: pr!.headSha } : null,
      provenance: provenance("github", options, observedAt),
    } };
  });
}

function githubUrlKey(url: string | null): WorkKey | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || !match) return null;
    return githubWorkKey(match[1]!, match[2]!, Number(match[3]));
  } catch { return null; }
}

/** Acquires exactly one existing snapshot; the snapshot's UTC time is retained. */
export function createRuntimeReader(options: ReaderOptions, read: (() => SnapshotResult | Promise<SnapshotResult>) | null,
  resolve?: (issueId: string) => WorkKey | null): SourceReader<readonly RuntimeWorkFacts[]> {
  return reader("runtime", options, read === null ? null : async () => {
    const result = await read();
    if (result.status === "unavailable") throw new SourceReadError(result.reason);
    const snapshot = result.snapshot;
    const observedAt = snapshot.generatedAt;
    const rows = new Map<string, RuntimeWorkFacts>();
    const link = (id: string, url: string | null) => {
      const key = githubUrlKey(url) ?? resolve?.(id) ?? null;
      return key === null ? null : keyCopy(key);
    };
    for (const row of snapshot.running) rows.set(row.issueId, {
      workKey: link(row.issueId, row.issueUrl), issueId: row.issueId,
      attempt: { issueId: row.issueId, issueIdentifier: row.issueIdentifier, attempt: row.attempt,
        status: row.status, workspacePath: row.workspacePath, startedAtMs: row.startedAt,
        sessionId: row.sessionId, threadId: row.threadId, turnId: row.turnId },
      retry: null, provenance: provenance("runtime", options, observedAt),
    });
    for (const row of snapshot.retrying) {
      const existing = rows.get(row.issueId);
      rows.set(row.issueId, {
        workKey: existing?.workKey ?? link(row.issueId, row.issueUrl), issueId: row.issueId,
        attempt: existing?.attempt ?? null,
        retry: { issueId: row.issueId, identifier: row.issueIdentifier, attempt: row.attempt,
          retryInMs: row.retryInMs, error: row.error },
        provenance: provenance("runtime", options, observedAt),
      });
    }
    return { observedAt, facts: [...rows.values()] };
  });
}

/** Port is DecisionService.observeWork; it never opens a second store. */
export function createDecisionReader(options: ReaderOptions,
  read: (() => DecisionObservation) | null): SourceReader<DecisionWorkFacts> {
  return reader("decision", options, read === null ? null : () => {
    const value = read();
    const observedAt = options.clock();
    return { observedAt, facts: { workKey: keyCopy(value.workKey),
      session: value.session ? {
        sessionId: value.session.sessionId, status: value.session.status,
        bindingGeneration: value.session.bindingGeneration, adapter: value.session.adapter,
        updatedAtMs: value.session.updatedAtMs,
      } : null,
      tasks: value.tasks.map((task) => {
        const base = { taskId: task.taskId, revision: task.revision, status: task.status,
          createdAtMs: task.createdAtMs, updatedAtMs: task.updatedAtMs,
          ...(task.claimGeneration === undefined ? {} : { claimGeneration: task.claimGeneration }),
          ...(task.claimBindingGeneration === undefined ? {} : { claimBindingGeneration: task.claimBindingGeneration }),
          ...(task.lease === undefined ? {} : { lease: task.lease === null ? null : {
            owner: task.lease.owner, generation: task.lease.generation, expiresAtMs: task.lease.expiresAtMs,
          } }),
        };
        return task.kind === "plan" ? { ...base, kind: "plan" as const } : {
          ...base, kind: "review" as const, target: { repository: task.target.repository,
            prNumber: task.target.prNumber, headSha: task.target.headSha },
        };
      }),
      results: value.results.map((result) => ({ taskId: result.taskId, revision: result.revision,
        createdAtMs: result.createdAtMs, outcome: result.outcome.kind === "plan" ? {
          kind: "plan" as const, verdict: result.outcome.verdict,
        } : { kind: "review" as const, verdict: result.outcome.verdict,
          target: { repository: result.outcome.target.repository, prNumber: result.outcome.target.prNumber,
            headSha: result.outcome.target.headSha } },
      })),
      provenance: provenance("decision", options, observedAt) } };
  });
}
export type ExecutorObservation = Omit<ExecutorFacts, "provenance" | "status" | "lastHeartbeatAtMs"> & {
  readonly status?: ExecutorFacts["status"];
  readonly lastHeartbeatAtMs?: number | null;
};
/** Only an explicit executor inventory can supply heartbeat/availability; no inference. */
export function createExecutorReader(options: ReaderOptions,
  read: (() => Observation<readonly ExecutorObservation[]> | Promise<Observation<readonly ExecutorObservation[]>>) | null): SourceReader<readonly ExecutorFacts[]> {
  return reader("executor", options, read === null ? null : async () => {
    const value = await read();
    return { observedAt: value.observedAt, facts: value.facts.map((entry) => {
      if (!entry.id.trim()) throw new SourceReadError("invalid_executor_identity");
      return { id: entry.id, role: entry.role, adapter: entry.adapter, host: entry.host,
        status: entry.status ?? "unknown", lastHeartbeatAtMs: entry.lastHeartbeatAtMs ?? null,
        bindingGeneration: entry.bindingGeneration ?? null,
        currentWorkKey: entry.currentWorkKey ? keyCopy(entry.currentWorkKey) : null,
        provenance: provenance("executor", options, value.observedAt) };
    }) };
  });
}

/** All owned reads settle before returning. Budgets/cancellation belong to source ports. */
export async function collectOperationFacts(readers: {
  readonly github: SourceReader<GitHubWorkFacts>;
  readonly runtime: SourceReader<readonly RuntimeWorkFacts[]>;
  readonly decision: SourceReader<DecisionWorkFacts>;
  readonly executor: SourceReader<readonly ExecutorFacts[]>;
}): Promise<OperationFactCollection> {
  const [github, runtime, decision, executor] = await Promise.all([
    readers.github.read(), readers.runtime.read(), readers.decision.read(), readers.executor.read(),
  ]);
  return { github, runtime, decision, executor };
}
