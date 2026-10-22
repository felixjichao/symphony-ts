import type { OperationalSnapshot } from "@symphony/operations";
// Wire shape checks only: no defaults, normalization, SHA comparison or projection.
type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };
const key = { provider: "string", key: "string" };
const target = { repository: "string", prNumber: "number", headSha: "string" };
const fresh = { status: "fresh|stale", observedAt: "number", lastAttemptAt: "number" };
const unknown = { status: "unknown", lastAttemptAt: "number|null", reason: "string|null" };
const unavailable = { status: "unavailable", observedAt: "number|null", lastAttemptAt: "number", reason: "string" };
const sourceFreshness = [fresh, unknown, unavailable];
const nullable = (shape: Shape): Shape => ["null", shape];
const task = { taskId: "string", revision: "number", kind: "plan|review", status: "pending|claimed|running|completed|failed|cancelled|superseded", createdAtMs: "number", updatedAtMs: "number" };
const result = { taskId: "string", revision: "number", createdAtMs: "number", outcome: [{ kind: "plan", verdict: "ready|needs_clarification|needs_human" }, { kind: "review", verdict: "approve|changes_requested|needs_human", target }] };
const schema: Shape = {
  schemaVersion: "1", generatedAt: "number", health: "healthy|degraded|unavailable|unknown",
  summary: { active: "number", waiting: "number", retrying: "number", needsHuman: "number", "degradedWork?": "number", "anomalyCount?": "number" },
  work: { "[]": { key, workItem: { identifier: "string", title: "string|null", url: "string|null" }, phase: "planning|ready|coding|ci|review|repair|landing|completed|unknown", attention: "normal|waiting|degraded|needs_human|failed",
    waiting: nullable({ reason: "waiting_for_plan|waiting_for_executor|waiting_for_ci|waiting_for_review|retry_backoff|needs_clarification|needs_human|blocked_by_dependency", since: "number|null" }),
    planning: nullable({ sessionStatus: "active|completed|broken-binding|null", taskStatus: "pending|claimed|running|completed|failed|cancelled|superseded|null", planVerdict: "ready|needs_clarification|needs_human|null" }),
    execution: nullable({ issueId: "string", attempt: "number|null", status: "preparing_workspace|building_prompt|launching_agent_process|initializing_session|streaming_turn|finishing|succeeded|failed|timed_out|stalled|canceled_by_reconciliation|null", workspacePath: "string|null", startedAtMs: "number|null", retryInMs: "number|null" }),
    ci: nullable({ status: "pending|success|failure" }), pullRequest: nullable({ number: "number", url: "string", state: "open|closed|merged", isDraft: "boolean", headSha: "string", mergeable: "MERGEABLE|CONFLICTING|UNKNOWN|null" }),
    review: nullable({ approval: "approved_current_head|approved_stale_head|changes_requested|pending|not_approved|unknown", currentHeadSha: "string|null", taskTarget: nullable(target), task: nullable([ { ...task, kind: "plan" }, { ...task, kind: "review", target } ]), result: nullable(result) }),
    freshness: { github: sourceFreshness, runtime: sourceFreshness, decision: sourceFreshness }, evidence: { "[]": "object" },
  } },
  sources: { "[]": { source: "github|runtime|decision|executor", instance: "string", "workKey?": nullable(key), freshness: sourceFreshness } },
  executors: { "[]": { id: "string", role: "planner|implementer|reviewer|null", adapter: "string", host: "string|null", status: "online|busy|stale|offline|unknown", currentWork: nullable(key), lastHeartbeatAt: "number|null" } },
  anomalies: { "[]": "object" },
};
function matches(value: unknown, shape: Shape): boolean {
  if (typeof shape === "string") return shape.split("|").some(s => s === "null" ? value === null : s === "number" ? typeof value === "number" && Number.isFinite(value) : s === "string" ? typeof value === "string" : s === "boolean" ? typeof value === "boolean" : s === "object" ? value !== null && typeof value === "object" : s === "1" ? value === 1 : typeof value === "string" && value === s);
  if (Array.isArray(shape)) return shape.some(s => matches(value, s));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const object = shape as { readonly [key: string]: Shape };
  if (object["[]"]) return Array.isArray(value) && value.every(v => matches(v, object["[]"]!));
  return Object.entries(object).every(([name, child]) => name.endsWith("?") ? record[name.slice(0, -1)] === undefined || matches(record[name.slice(0, -1)], child) : matches(record[name], child));
}
export function validateSnapshot(value: unknown): asserts value is OperationalSnapshot {
  if (!matches(value, schema)) throw new Error("Invalid snapshot shape");
}
