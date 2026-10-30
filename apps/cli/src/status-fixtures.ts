/** Controlled external facts for acceptance; never imported by the executable. */
import { formatWorkKey, type DecisionObservation, type GitHubObservation, type SnapshotResult, type WorkKey } from "@symphony/domain";
import { type StatusSources } from "./status";
export const statusScenarios = ["healthy", "failed", "ci", "review", "executor-wait", "needs_human", "needs_clarification", "conflict", "stale", "partial", "target-mismatch", "approval-mismatch", "result-mismatch", "terminal", "completed", "active-inventory", "stale-inventory", "empty-inventory", "unknown-inventory", "unavailable-inventory"] as const;
export type StatusScenario = typeof statusScenarios[number];
export const statusKeys: readonly WorkKey[] = [{ provider: "github", key: "acceptance/alpha#1" }, { provider: "github", key: "acceptance/beta#1" }];
export const statusTime = 1_800_000_000_000;
export function statusFacts(scenario: StatusScenario): StatusSources {
  const active = scenario === "healthy" || scenario === "terminal" || scenario === "stale";
  const runtime = (): SnapshotResult => ({ status: "available", snapshot: {
    generatedAt: scenario === "stale" ? statusTime - 120_000 : statusTime, pollIntervalMs: 30_000, maxConcurrentAgents: 2,
    running: (active ? statusKeys : scenario === "failed" ? statusKeys.slice(1) : []).map(key => ({ issueId: formatWorkKey(key), issueIdentifier: "GH-1", issueUrl: `https://github.com/${key.key.replace("#", "/issues/")}`,
      issueState: "open", attempt: null, status: "streaming_turn", workspacePath: "/acceptance", startedAt: statusTime - 1000,
      elapsedMs: 1000, sessionId: null, threadId: null, turnId: null, codexAppServerPid: null, turnCount: null,
      lastCodexEvent: null, lastCodexMessage: null, lastCodexTimestamp: null, tokens: null })),
    retrying: [], codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 }, rateLimits: null,
  } });
  const github = async (workKey: WorkKey): Promise<GitHubObservation> => {
    if (scenario === "partial" && workKey.key === statusKeys[0]!.key) throw new Error("private credential never serialized");
    return { workKey, issue: { state: scenario === "terminal" || scenario === "completed" ? "closed" : "open", url: `https://github.com/${workKey.key.replace("#", "/issues/")}` },
      pullRequest: { number: 2, state: "open", url: `https://github.com/${workKey.key.split("#")[0]}/pull/2`, headSha: "a".repeat(40), isDraft: false },
      ci: { status: scenario === "ci" ? "pending" : "success", headSha: "a".repeat(40) } };
  };
  const decision = (workKey: WorkKey): DecisionObservation => {
    const target = { repository: workKey.key.split("#")[0]!, prNumber: 2, headSha: (scenario.includes("mismatch") ? "b" : "a").repeat(40) };
    const failed = scenario === "failed" && workKey.key === statusKeys[0]!.key;
    const review = failed || ["review", "executor-wait", "conflict", "target-mismatch", "approval-mismatch", "result-mismatch"].includes(scenario);
    const plan = scenario === "needs_human" || scenario === "needs_clarification";
    const base = { taskId: "shared-task", revision: 1, createdAtMs: statusTime, updatedAtMs: statusTime };
    return { workKey, session: { sessionId: formatWorkKey(workKey), status: "active", bindingGeneration: 1, adapter: "controlled", updatedAtMs: statusTime },
      tasks: review ? [{ ...base, kind: "review", status: failed ? "failed" : scenario === "approval-mismatch" ? "completed" : scenario === "executor-wait" ? "pending" : "running", target },
        ...(scenario === "conflict" ? [{ ...base, taskId: "other-task", kind: "review" as const, status: "running" as const, target }] : [])]
        : plan ? [{ ...base, kind: "plan", status: "completed" }] : [],
      results: plan ? [{ taskId: base.taskId, revision: 1, createdAtMs: statusTime, outcome: { kind: "plan", verdict: scenario as "needs_human" | "needs_clarification" } }]
        : scenario === "approval-mismatch" || scenario === "result-mismatch" ? [{ taskId: base.taskId, revision: 1, createdAtMs: statusTime,
          outcome: { kind: "review", verdict: "approve", target: { ...target, headSha: (scenario === "result-mismatch" ? "c" : "b").repeat(40) } } }] : [],
    };
  };
  return { clock: () => statusTime, runtime, github, decision,
    ...(scenario === "unknown-inventory" ? {} : { executor: () => {
      if (scenario === "unavailable-inventory") throw new Error("inventory unavailable");
      const stale = scenario === "stale-inventory";
      return { facts: scenario === "active-inventory" || stale ? [
        { id: "active", role: "implementer" as const, adapter: "controlled", host: "host-a", status: "busy" as const, currentWorkKey: statusKeys[0]!, lastHeartbeatAtMs: statusTime - (stale ? 120_000 : 2000) },
        { id: "idle", role: "reviewer" as const, adapter: "controlled", host: "host-b", status: "online" as const, currentWorkKey: null },
        { id: "other-work", role: null, adapter: "controlled-other", host: null, status: "unknown" as const, currentWorkKey: statusKeys[1]! },
      ] : [], observedAt: statusTime - (stale ? 120_000 : 0) };
    } }) };
}
