/**
 * Stable in-process Operational Query Service (NEST-117 / GitHub #113).
 *
 * Final implementation and acceptance slice for #108 (Observation Plane).
 * Composes normalized contracts, read-only source readers, deterministic projectors,
 * cross-source anomaly detection, and freshness handling into a single in-process
 * query surface for CLI status, JSON API, Dashboard, and alerting consumers.
 *
 * Invariants:
 * - Read-only: no mutation, no scheduler, no workflow coordinator, no write-backs.
 * - Single-round bounded assembly: all reader reads settle concurrently before returning.
 *   No background polling, persistent caching, retry coordination, or new timeout lifecycles.
 * - Bounded work scope: work items are defined exclusively by host-injected canonical WorkKeys;
 *   runtime rows outside scope do not create work items; unknown valid keys return null.
 * - Partial failure tolerance: failures in individual source reads degrade affected projections
 *   and system health without failing the overall query.
 * - Deterministic: identical collected facts and explicit clock yield identical results.
 */
import {
  formatWorkKey,
  parseWorkKey,
  type DecisionWorkFacts,
  type ExecutorFacts,
  type ExecutorProjection,
  type GitHubWorkFacts,
  type OperationalAnomaly,
  type OperationalSnapshot,
  type OperationSourceKind,
  type OperationSourceResult,
  type RuntimeWorkFacts,
  type SourceStatus,
  type UtcTimestampMs,
  type WorkKey,
  type WorkProjection,
} from "@symphony/domain";
import { sortAndDeduplicateAnomalies } from "./anomalies";
import { projectOperationalSnapshot, projectWorkWithAnomalies } from "./projectors";
import type { SourceReader } from "./readers";

/**
 * Public in-process read surface for operational observation consumers.
 */
export interface OperationalQueryService {
  /**
   * Returns a complete, deterministic OperationalSnapshot representing the
   * current read-only observation plane state across all in-scope work items,
   * executors, source freshness envelopes, and cross-source anomalies.
   */
  getOperationalSnapshot(): Promise<OperationalSnapshot>;

  /**
   * Lists work item projections for all canonical work keys currently in scope,
   * sorted deterministically by work key.
   */
  listWork(): Promise<readonly WorkProjection[]>;

  /**
   * Returns the work projection for a specific work key in scope.
   * If the work key is valid but not in scope, returns null.
   * If the work key is invalid, throws TypeError.
   * Source failure degrades the projection but does not return null.
   */
  getWork(workKey: WorkKey | string): Promise<WorkProjection | null>;

  /**
   * Lists operational executor projections without coupling work identity to hosts/machines.
   */
  listExecutors(): Promise<readonly ExecutorProjection[]>;
}

export type WorkKeyProvider =
  | readonly (WorkKey | string)[]
  | (() => readonly (WorkKey | string)[] | Promise<readonly (WorkKey | string)[]>);

export type GitHubReaderFactory =
  | ((workKey: WorkKey) => SourceReader<GitHubWorkFacts> | null | undefined)
  | ReadonlyMap<string, SourceReader<GitHubWorkFacts>>
  | null
  | undefined;

export type DecisionReaderFactory =
  | ((workKey: WorkKey) => SourceReader<DecisionWorkFacts> | null | undefined)
  | ReadonlyMap<string, SourceReader<DecisionWorkFacts>>
  | null
  | undefined;

export interface OperationalQueryServiceOptions {
  /** Explicit clock returning UTC timestamp in milliseconds. Defaults to Date.now. */
  readonly clock?: () => number;

  /** Canonical work keys in scope for this query service. */
  readonly workKeys: WorkKeyProvider;

  /** Shared runtime reader for orchestrator attempts and retries (called once per query round). */
  readonly runtimeReader?: SourceReader<readonly RuntimeWorkFacts[]> | null | undefined;

  /** Shared executor inventory reader (called once per query round). */
  readonly executorReader?: SourceReader<readonly ExecutorFacts[]> | null | undefined;

  /** Factory or Map for GitHub readers per canonical work item. */
  readonly getGitHubReader?: GitHubReaderFactory;

  /** Factory or Map for Decision readers per canonical work item. */
  readonly getDecisionReader?: DecisionReaderFactory;

  /**
   * Optional default/fallback GitHub reader when getGitHubReader is not provided
   * or returns null/undefined for a work item.
   */
  readonly githubReader?: SourceReader<GitHubWorkFacts> | null | undefined;

  /**
   * Optional default/fallback Decision reader when getDecisionReader is not provided
   * or returns null/undefined for a work item.
   */
  readonly decisionReader?: SourceReader<DecisionWorkFacts> | null | undefined;
}

/**
 * Normalizes a WorkKey or string representation into a canonical WorkKey.
 * Throws TypeError if the key cannot be validated.
 */
function normalizeWorkKey(input: WorkKey | string): WorkKey {
  if (typeof input === "string") {
    const trimmed = input.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const provider = trimmed.slice(0, colonIdx);
      const key = trimmed.slice(colonIdx + 1);
      return parseWorkKey({ provider, key });
    }
    if (trimmed.includes("#")) {
      return parseWorkKey({ provider: "github", key: trimmed });
    }
    return parseWorkKey(trimmed as unknown);
  }
  return parseWorkKey(input);
}

/**
 * Resolves, deduplicates, and deterministically sorts canonical work keys in scope.
 */
async function resolveWorkKeys(provider: WorkKeyProvider): Promise<readonly WorkKey[]> {
  const raw = typeof provider === "function" ? await provider() : provider;
  const map = new Map<string, WorkKey>();
  for (const item of raw) {
    const key = normalizeWorkKey(item);
    map.set(formatWorkKey(key), key);
  }
  return [...map.values()].sort((a, b) => formatWorkKey(a).localeCompare(formatWorkKey(b)));
}

function resolveGitHubReader(
  key: WorkKey,
  options: OperationalQueryServiceOptions,
): SourceReader<GitHubWorkFacts> | null {
  if (typeof options.getGitHubReader === "function") {
    const reader = options.getGitHubReader(key);
    if (reader) return reader;
  } else if (options.getGitHubReader && typeof options.getGitHubReader === "object" && "get" in options.getGitHubReader) {
    const reader = options.getGitHubReader.get(formatWorkKey(key));
    if (reader) return reader;
  }
  return options.githubReader ?? null;
}

function resolveDecisionReader(
  key: WorkKey,
  options: OperationalQueryServiceOptions,
): SourceReader<DecisionWorkFacts> | null {
  if (typeof options.getDecisionReader === "function") {
    const reader = options.getDecisionReader(key);
    if (reader) return reader;
  } else if (options.getDecisionReader && typeof options.getDecisionReader === "object" && "get" in options.getDecisionReader) {
    const reader = options.getDecisionReader.get(formatWorkKey(key));
    if (reader) return reader;
  }
  return options.decisionReader ?? null;
}

/**
 * Safely executes a source reader, returning an unavailable result if execution throws.
 * Preserves unconfigured unknown semantics when reader is absent.
 */
async function executeReader<T>(
  source: OperationSourceKind,
  defaultInstance: string,
  reader: SourceReader<T> | null | undefined,
  now: UtcTimestampMs,
  workKey?: WorkKey | null,
): Promise<OperationSourceResult<T>> {
  if (!reader) {
    return {
      source,
      instance: defaultInstance,
      facts: null,
      freshness: {
        status: "unknown",
        lastAttemptAt: null,
        reason: "source_not_configured",
      },
      ...(workKey ? { workKey } : {}),
    };
  }
  try {
    const result = await reader.read();
    if (workKey && !result.workKey) {
      return {
        ...result,
        workKey,
      };
    }
    return result;
  } catch (error) {
    return {
      source,
      instance: defaultInstance,
      facts: null,
      freshness: {
        status: "unavailable",
        observedAt: null,
        lastAttemptAt: now,
        reason: error instanceof Error ? error.message : "source_read_failed",
      },
      ...(workKey ? { workKey } : {}),
    };
  }
}

/**
 * Assembles a complete OperationalSnapshot through a single bounded collection round.
 */
async function assembleOperationalSnapshot(
  options: OperationalQueryServiceOptions,
): Promise<OperationalSnapshot> {
  const clock = options.clock ?? Date.now;
  const now = clock();
  const keys = await resolveWorkKeys(options.workKeys);

  // 1. Read global sources once per query turn
  const runtimePromise = executeReader(
    "runtime",
    "runtime",
    options.runtimeReader,
    now,
  );
  const executorPromise = executeReader(
    "executor",
    "executor",
    options.executorReader,
    now,
  );

  // 2. Read per-workKey sources concurrently
  const workReadsPromises = keys.map(async (key) => {
    const ghReader = resolveGitHubReader(key, options);
    const decReader = resolveDecisionReader(key, options);
    const [githubResult, decisionResult] = await Promise.all([
      executeReader("github", "github", ghReader, now, key),
      executeReader("decision", "decision", decReader, now, key),
    ]);
    return { key, githubResult, decisionResult };
  });

  const [runtimeResult, executorResult, workReads] = await Promise.all([
    runtimePromise,
    executorPromise,
    Promise.all(workReadsPromises),
  ]);

  const workProjections: WorkProjection[] = [];
  const allAnomalies: OperationalAnomaly[] = [];
  const sources: SourceStatus[] = [];

  // Record global source statuses
  sources.push({
    source: runtimeResult.source,
    instance: runtimeResult.instance,
    freshness: runtimeResult.freshness,
  });
  sources.push({
    source: executorResult.source,
    instance: executorResult.instance,
    freshness: executorResult.freshness,
  });

  // Project each work item and collect per-work source statuses and anomalies
  for (const { key, githubResult, decisionResult } of workReads) {
    const { projection, anomalies } = projectWorkWithAnomalies({
      workKey: key,
      github: githubResult,
      runtime: runtimeResult,
      decision: decisionResult,
      executor: executorResult,
      detectedAt: now,
    });

    workProjections.push(projection);
    allAnomalies.push(...anomalies);

    sources.push({
      source: githubResult.source,
      instance: githubResult.instance,
      freshness: githubResult.freshness,
      workKey: key,
    });
    sources.push({
      source: decisionResult.source,
      instance: decisionResult.instance,
      freshness: decisionResult.freshness,
      workKey: key,
    });
  }

  const sortedAnomalies = sortAndDeduplicateAnomalies(allAnomalies);

  return projectOperationalSnapshot({
    generatedAt: now,
    work: workProjections,
    executors: executorResult.facts ?? [],
    sources,
    anomalies: sortedAnomalies,
  });
}

/**
 * Creates an in-process Operational Query Service.
 */
export function createOperationalQueryService(
  options: OperationalQueryServiceOptions,
): OperationalQueryService {
  if (!options || typeof options !== "object") {
    throw new TypeError("OperationalQueryServiceOptions must be an object");
  }

  return {
    async getOperationalSnapshot(): Promise<OperationalSnapshot> {
      return assembleOperationalSnapshot(options);
    },

    async listWork(): Promise<readonly WorkProjection[]> {
      const snapshot = await assembleOperationalSnapshot(options);
      return snapshot.work;
    },

    async getWork(workKey: WorkKey | string): Promise<WorkProjection | null> {
      const target = normalizeWorkKey(workKey);
      const formatted = formatWorkKey(target);
      const snapshot = await assembleOperationalSnapshot(options);
      return snapshot.work.find((w) => formatWorkKey(w.key) === formatted) ?? null;
    },

    async listExecutors(): Promise<readonly ExecutorProjection[]> {
      const snapshot = await assembleOperationalSnapshot(options);
      return snapshot.executors;
    },
  };
}
