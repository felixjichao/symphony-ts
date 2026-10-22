/** Node-only controlled read-only sources; never opens production persistence. */
import { createOperationalQueryService, type SourceReader, type OperationSourceKind, type GitHubWorkFacts, type DecisionWorkFacts, type RuntimeWorkFacts, type ExecutorFacts, type SourceFreshnessStatus } from "@symphony/operations";
export type Scenario = "populated" | "empty" | "unavailable" | "stale" | "unknown" | "review" | "target-mismatch" | "result-mismatch" | "partial" | "conflict" | "terminal";
export function demoService(scenario: Scenario = "populated") {
  const keys = [{ provider: "github", key: "demo/alpha#1" }, { provider: "github", key: "demo/beta#1" }];
  function reader<T>(source: OperationSourceKind, facts: T, status: SourceFreshnessStatus = "fresh"): SourceReader<T> {
    return { async read() { const now = Date.now(); return { source, instance: `demo:${source}`, facts: status === "unavailable" || status === "unknown" ? null : facts, freshness: status === "unknown" ? { status, lastAttemptAt: null, reason: "source_not_configured" } : status === "unavailable" ? { status, observedAt: null, lastAttemptAt: now, reason: "demo_unavailable" } : { status, observedAt: status === "stale" ? now - 120_000 : now, lastAttemptAt: now } }; } };
  }
  const status = scenario === "unavailable" || scenario === "stale" || scenario === "unknown" ? scenario : "fresh";
  const diagnostics = ["review", "target-mismatch", "result-mismatch", "partial", "conflict", "terminal"].includes(scenario);
  function decision(workKey: { provider: string; key: string }): DecisionWorkFacts {
    const now = Date.now();
    const target = { repository: workKey.key.split("#")[0]!, prNumber: 2, headSha: (scenario === "target-mismatch" || scenario === "result-mismatch" ? "b" : "a").repeat(40) };
    const task = { kind: "review" as const, taskId: "demo-review", revision: 1, status: "running" as const, createdAtMs: now, updatedAtMs: now, target };
    return { workKey, session: diagnostics ? { sessionId: "demo-session", status: "active", bindingGeneration: 1, adapter: "demo", updatedAtMs: now } : null,
      tasks: diagnostics ? scenario === "conflict" ? [task, { ...task, taskId: "demo-conflicting-review" }] : [task] : [],
      results: scenario === "result-mismatch" ? [{ taskId: task.taskId, revision: 1, createdAtMs: now, outcome: { kind: "review", verdict: "approve", target: { ...target, headSha: "c".repeat(40) } } }] : [],
      provenance: { source: "decision", instance: "demo:decision", observedAt: now } };
  }
  return createOperationalQueryService({
    workKeys: scenario === "empty" ? [] : keys,
    getGitHubReader: workKey => reader<GitHubWorkFacts>("github", { workKey, issue: { state: scenario === "terminal" ? "closed" : "open", url: `https://github.com/${workKey.key.replace("#", "/issues/")}` }, pullRequest: { number: 2, state: "open", url: "https://github.com/demo/alpha/pull/2", headSha: "a".repeat(40), isDraft: false }, ci: { status: diagnostics ? "success" : "pending" }, provenance: { source: "github", instance: "demo:github", observedAt: Date.now() } }, status),
    getDecisionReader: workKey => reader<DecisionWorkFacts>("decision", decision(workKey), scenario === "partial" ? "unavailable" : status),
    runtimeReader: reader<readonly RuntimeWorkFacts[]>("runtime", scenario === "terminal" ? keys.map(workKey => ({ workKey, issueId: workKey.key, attempt: { issueId: workKey.key, issueIdentifier: workKey.key, attempt: null, status: "streaming_turn", workspacePath: "/demo", startedAtMs: Date.now() }, retry: null, provenance: { source: "runtime", instance: "demo:runtime", observedAt: Date.now() } })) : [], status),
    executorReader: reader<readonly ExecutorFacts[]>("executor", [], status),
  });
}
