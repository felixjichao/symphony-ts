/** Node-only controlled read-only sources; never opens production persistence. */
import { createOperationalQueryService, type SourceReader, type OperationSourceKind, type GitHubWorkFacts, type DecisionWorkFacts, type RuntimeWorkFacts, type ExecutorFacts, type SourceFreshnessStatus } from "@symphony/operations";
export type Scenario = "populated" | "empty" | "unavailable" | "stale" | "unknown";
export function demoService(scenario: Scenario = "populated") {
  const keys = [{ provider: "github", key: "demo/alpha#1" }, { provider: "github", key: "demo/beta#1" }];
  function reader<T>(source: OperationSourceKind, facts: T, status: SourceFreshnessStatus = "fresh"): SourceReader<T> {
    return { async read() { const now = Date.now(); return { source, instance: `demo:${source}`, facts: status === "unavailable" || status === "unknown" ? null : facts, freshness: status === "unknown" ? { status, lastAttemptAt: null, reason: "source_not_configured" } : status === "unavailable" ? { status, observedAt: null, lastAttemptAt: now, reason: "demo_unavailable" } : { status, observedAt: status === "stale" ? now - 120_000 : now, lastAttemptAt: now } }; } };
  }
  const status = scenario === "unavailable" || scenario === "stale" || scenario === "unknown" ? scenario : "fresh";
  return createOperationalQueryService({
    workKeys: scenario === "empty" ? [] : keys,
    getGitHubReader: workKey => reader<GitHubWorkFacts>("github", { workKey, issue: { state: "open", url: `https://github.com/${workKey.key.replace("#", "/issues/")}` }, pullRequest: { number: 2, state: "open", url: "https://github.com/demo/alpha/pull/2", headSha: "a".repeat(40), isDraft: false }, ci: { status: "pending" }, provenance: { source: "github", instance: "demo:github", observedAt: Date.now() } }, status),
    getDecisionReader: workKey => reader<DecisionWorkFacts>("decision", { workKey, session: null, tasks: [], results: [], provenance: { source: "decision", instance: "demo:decision", observedAt: Date.now() } }, status),
    runtimeReader: reader<readonly RuntimeWorkFacts[]>("runtime", [], status),
    executorReader: reader<readonly ExecutorFacts[]>("executor", [], status),
  });
}
