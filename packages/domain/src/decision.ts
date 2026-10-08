/** Provider-neutral Decision Plane extension; not the Symphony §7 state machine. */
import type { UtcTimestampMs } from "./time";

export const DECISION_SCHEMA_VERSION = 1 as const;
export type DecisionSessionStatus = "active" | "completed" | "broken-binding";
export type DecisionTaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "superseded";
export interface DecisionWorkItemRef {
  readonly provider: string;
  /** Stable provider-native work-item key, never an executor session reference. */
  readonly key: string;
}
export interface ExecutorBinding {
  readonly schemaVersion: 1;
  readonly adapter: string;
  readonly externalSessionRef: string;
  readonly resumeUri: string | null;
  readonly generation: number;
}
export interface DecisionSession {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly root: DecisionWorkItemRef;
  readonly status: DecisionSessionStatus;
  readonly binding: ExecutorBinding | null;
  /** Retained even when binding is lost. */
  readonly bindingGeneration: number;
  readonly createdAtMs: UtcTimestampMs;
  readonly updatedAtMs: UtcTimestampMs;
}
export interface DecisionReviewTarget {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
}
export interface DecisionLease {
  readonly owner: string;
  readonly token: string;
  readonly generation: number;
  readonly expiresAtMs: UtcTimestampMs;
}
interface DecisionTaskBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly status: DecisionTaskStatus;
  readonly lease: DecisionLease | null;
  readonly claimGeneration: number;
  readonly lastClaimToken: string | null;
  readonly createdAtMs: UtcTimestampMs;
  readonly updatedAtMs: UtcTimestampMs;
}
export interface DecisionPlanTask extends DecisionTaskBase { readonly kind: "plan" }
export interface DecisionReviewTask extends DecisionTaskBase {
  readonly kind: "review";
  readonly target: DecisionReviewTarget;
}
export type DecisionTask = DecisionPlanTask | DecisionReviewTask;
interface DecisionResultBase {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly createdAtMs: UtcTimestampMs;
}
export interface DecisionPlanResult extends DecisionResultBase {
  readonly kind: "plan";
  readonly verdict: "ready" | "needs_clarification" | "needs_human";
  readonly content: {
    readonly plan: string;
    readonly acceptanceCriteria: readonly string[];
    readonly risks: readonly string[];
    readonly clarifications: readonly string[];
  };
}
export interface DecisionReviewFinding {
  readonly severity: "blocker" | "suggestion";
  readonly message: string;
  readonly location: string | null;
}
export interface DecisionReviewResult extends DecisionResultBase {
  readonly kind: "review";
  readonly target: DecisionReviewTarget;
  readonly verdict: "approve" | "changes_requested" | "needs_human";
  readonly findings: readonly DecisionReviewFinding[];
}
export type DecisionResult = DecisionPlanResult | DecisionReviewResult;

// Small strict v1 validators: unknown fields are rejected at every object boundary.
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid decision record: ${message}`);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "expected object");
  const object = value as Record<string, unknown>;
  requireValue(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null, "expected plain object");
  requireValue(Reflect.ownKeys(object).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  }), "missing or unknown field");
  return object;
}
function string(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, "expected nonempty string");
}
function integer(value: unknown, minimum = 0): asserts value is number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "expected safe integer");
}
function timestamp(value: unknown): asserts value is number {
  integer(value);
  requireValue(value <= 8_640_000_000_000_000, "timestamp outside UTC range");
}
function oneOf(value: unknown, choices: readonly string[]): void {
  requireValue(typeof value === "string" && choices.includes(value), "invalid enum");
}
function version(value: unknown): void { requireValue(value === 1, "unsupported schemaVersion"); }
/** Dense ordinary JSON arrays only; never trust a caller-supplied iterator or toJSON. */
function array(value: unknown): readonly unknown[] {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, "expected plain array");
  requireValue(Reflect.ownKeys(value).length === value.length + 1, "unknown array field or sparse array");
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    requireValue(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"), "expected array data element");
  }
  return value;
}
function strings(value: unknown): void {
  const items = array(value);
  for (let index = 0; index < items.length; index++) string(items[index]);
}
function repository(value: unknown): asserts value is string {
  string(value);
  requireValue(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/.test(value), "expected canonical owner/repository");
  requireValue(!value.endsWith("/.") && !value.endsWith("/.."), "invalid repository");
}
function validateRoot(value: unknown): DecisionWorkItemRef {
  const root = record(value, ["provider", "key"]);
  string(root["provider"]); string(root["key"]);
  requireValue(/^[a-z][a-z0-9-]*$/.test(root["provider"]), "invalid work-item provider");
  if (root["provider"] === "github") {
    const match = /^(.*)#([1-9][0-9]*)$/.exec(root["key"]);
    requireValue(match !== null, "invalid GitHub issue key");
    repository(match[1]); integer(Number(match[2]), 1);
  }
  return value as DecisionWorkItemRef;
}
export function decisionSessionId(root: DecisionWorkItemRef): string {
  validateRoot(root);
  return `${root.provider}:${root.key}`;
}
export function githubDecisionRoot(owner: string, repo: string, issueNumber: number): DecisionWorkItemRef {
  integer(issueNumber, 1);
  const root = { provider: "github", key: `${owner.toLowerCase()}/${repo.toLowerCase()}#${issueNumber}` };
  return validateRoot(root);
}
export function parseDecisionReviewTarget(value: unknown): DecisionReviewTarget {
  const target = record(value, ["repository", "prNumber", "headSha"]);
  repository(target["repository"]); integer(target["prNumber"], 1);
  requireValue(typeof target["headSha"] === "string" && /^[0-9a-f]{40}$/.test(target["headSha"]), "expected full lowercase HEAD SHA");
  return value as DecisionReviewTarget;
}
function validateSessionId(value: unknown): asserts value is string {
  string(value);
  const colon = value.indexOf(":");
  requireValue(colon > 0, "invalid session id");
  validateRoot({ provider: value.slice(0, colon), key: value.slice(colon + 1) });
}
export function decisionTaskId(task: Pick<DecisionTask, "sessionId" | "kind" | "revision"> & { readonly target?: DecisionReviewTarget }): string {
  validateSessionId(task.sessionId); integer(task.revision, 1); oneOf(task.kind, ["plan", "review"]);
  const prefix = `${encodeURIComponent(task.sessionId)}:${task.kind}:${task.revision}`;
  if (task.kind === "plan") return prefix;
  const target = parseDecisionReviewTarget(task.target);
  return `${prefix}:${encodeURIComponent(target.repository)}:${target.prNumber}:${target.headSha}`;
}
export function parseExecutorBinding(value: unknown): ExecutorBinding {
  const binding = record(value, ["schemaVersion", "adapter", "externalSessionRef", "resumeUri", "generation"]);
  version(binding["schemaVersion"]); string(binding["adapter"]); string(binding["externalSessionRef"]);
  if (binding["resumeUri"] !== null) string(binding["resumeUri"]);
  integer(binding["generation"], 1);
  return value as ExecutorBinding;
}
function times(object: Record<string, unknown>): void {
  timestamp(object["createdAtMs"]); timestamp(object["updatedAtMs"]);
  requireValue(object["updatedAtMs"] >= object["createdAtMs"], "time moved backwards");
}
export function parseDecisionSession(value: unknown): DecisionSession {
  const session = record(value, ["schemaVersion", "id", "root", "status", "binding", "bindingGeneration", "createdAtMs", "updatedAtMs"]);
  version(session["schemaVersion"]); const root = validateRoot(session["root"]);
  requireValue(session["id"] === decisionSessionId(root), "session/root mismatch");
  oneOf(session["status"], ["active", "completed", "broken-binding"]); integer(session["bindingGeneration"]); times(session);
  if (session["binding"] !== null) {
    const binding = parseExecutorBinding(session["binding"]);
    requireValue(binding.generation === session["bindingGeneration"], "binding generation mismatch");
  }
  requireValue(session["status"] !== "broken-binding" || (session["binding"] === null && session["bindingGeneration"] > 0), "broken binding must retain generation and be cleared");
  return value as DecisionSession;
}
export function parseDecisionLease(value: unknown): DecisionLease {
  const lease = record(value, ["owner", "token", "generation", "expiresAtMs"]);
  string(lease["owner"]); string(lease["token"]); integer(lease["generation"], 1); timestamp(lease["expiresAtMs"]);
  return value as DecisionLease;
}
export function parseDecisionTask(value: unknown): DecisionTask {
  requireValue(typeof value === "object" && value !== null, "expected task");
  const kind = (value as Record<string, unknown>)["kind"];
  oneOf(kind, ["plan", "review"]);
  const task = record(value, ["schemaVersion", "id", "sessionId", "kind", "revision", "status", "lease", "claimGeneration", "lastClaimToken", "createdAtMs", "updatedAtMs", ...(kind === "review" ? ["target"] : [])]);
  version(task["schemaVersion"]); validateSessionId(task["sessionId"]); integer(task["revision"], 1);
  oneOf(task["status"], ["pending", "claimed", "running", "completed", "failed", "cancelled", "superseded"]);
  integer(task["claimGeneration"]); times(task);
  if (task["lastClaimToken"] !== null) string(task["lastClaimToken"]);
  requireValue((task["claimGeneration"] === 0) === (task["lastClaimToken"] === null), "claim history mismatch");
  requireValue(!["completed", "failed"].includes(task["status"] as string) || task["claimGeneration"] > 0, "terminal execution requires claim history");
  const leased = task["status"] === "claimed" || task["status"] === "running";
  requireValue(leased === (task["lease"] !== null), "lease/status mismatch");
  if (task["lease"] !== null) {
    const lease = parseDecisionLease(task["lease"]);
    requireValue(lease.generation === task["claimGeneration"] && lease.token === task["lastClaimToken"], "lease/history mismatch");
    requireValue(lease.expiresAtMs > (task["updatedAtMs"] as number), "lease already expired at transition");
  }
  if (kind === "review") parseDecisionReviewTarget(task["target"]);
  requireValue(task["id"] === decisionTaskId(value as DecisionTask), "task id mismatch");
  return value as DecisionTask;
}
export function parseDecisionResult(value: unknown): DecisionResult {
  requireValue(typeof value === "object" && value !== null, "expected result");
  const kind = (value as Record<string, unknown>)["kind"];
  oneOf(kind, ["plan", "review"]);
  const result = record(value, ["schemaVersion", "taskId", "sessionId", "kind", "revision", "createdAtMs", "verdict", ...(kind === "plan" ? ["content"] : ["target", "findings"])]);
  version(result["schemaVersion"]); validateSessionId(result["sessionId"]); integer(result["revision"], 1); timestamp(result["createdAtMs"]);
  if (kind === "plan") {
    oneOf(result["verdict"], ["ready", "needs_clarification", "needs_human"]);
    const content = record(result["content"], ["plan", "acceptanceCriteria", "risks", "clarifications"]);
    string(content["plan"]); strings(content["acceptanceCriteria"]); strings(content["risks"]); strings(content["clarifications"]);
  } else {
    oneOf(result["verdict"], ["approve", "changes_requested", "needs_human"]);
    parseDecisionReviewTarget(result["target"]);
    const findings = array(result["findings"]);
    for (let index = 0; index < findings.length; index++) {
      const finding = record(findings[index], ["severity", "message", "location"]);
      oneOf(finding["severity"], ["blocker", "suggestion"]); string(finding["message"]);
      if (finding["location"] !== null) string(finding["location"]);
    }
  }
  requireValue(result["taskId"] === decisionTaskId(value as DecisionResult), "result task id mismatch");
  return value as DecisionResult;
}
function sameTarget(a: DecisionReviewTarget, b: DecisionReviewTarget): boolean {
  return a.repository === b.repository && a.prNumber === b.prNumber && a.headSha === b.headSha;
}
export function validateDecisionResultForTask(task: DecisionTask, result: DecisionResult): void {
  parseDecisionTask(task); parseDecisionResult(result);
  requireValue(task.kind === result.kind && task.id === result.taskId && task.sessionId === result.sessionId && task.revision === result.revision, "result/task mismatch");
  requireValue(result.createdAtMs >= task.createdAtMs, "result predates task");
  if (task.kind === "review" && result.kind === "review") requireValue(sameTarget(task.target, result.target), "review target mismatch");
}
function checkNow(updatedAtMs: number, now: number): void {
  timestamp(now); requireValue(now >= updatedAtMs, "time moved backwards");
}
/** Caller/store must atomically compare the current generation/token at commit time. */
function checkLease(task: DecisionTask, lease: DecisionLease, now: number): void {
  parseDecisionLease(lease);
  requireValue(task.lease !== null && task.lease.owner === lease.owner && task.lease.token === lease.token && task.lease.generation === lease.generation && task.lease.expiresAtMs === lease.expiresAtMs, "stale claim");
  requireValue(now < task.lease.expiresAtMs, "expired claim");
}
export function claimDecisionTask(task: DecisionTask, lease: DecisionLease, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); parseDecisionLease(lease); checkNow(task.updatedAtMs, now);
  requireValue(task.status === "pending", "only pending tasks can be claimed");
  requireValue(lease.generation === task.claimGeneration + 1 && lease.token !== task.lastClaimToken && lease.expiresAtMs > now, "claim must be fresh");
  return parseDecisionTask({ ...task, status: "claimed", lease, claimGeneration: lease.generation, lastClaimToken: lease.token, updatedAtMs: now });
}
export function startDecisionTask(task: DecisionTask, lease: DecisionLease, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); checkNow(task.updatedAtMs, now); checkLease(task, lease, now);
  requireValue(task.status === "claimed", "only claimed tasks can start");
  return parseDecisionTask({ ...task, status: "running", updatedAtMs: now });
}
export function completeDecisionTask(task: DecisionTask, result: DecisionResult, lease: DecisionLease, now: UtcTimestampMs): DecisionTask {
  validateDecisionResultForTask(task, result); checkNow(task.updatedAtMs, now); checkLease(task, lease, now);
  requireValue(task.status === "running" && result.createdAtMs <= now, "only running tasks with a current result can complete");
  return parseDecisionTask({ ...task, status: "completed", lease: null, updatedAtMs: now });
}
export function failDecisionTask(task: DecisionTask, lease: DecisionLease, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); checkNow(task.updatedAtMs, now); checkLease(task, lease, now);
  requireValue(task.status === "claimed" || task.status === "running", "only leased tasks can fail");
  return parseDecisionTask({ ...task, status: "failed", lease: null, updatedAtMs: now });
}
export function releaseExpiredDecisionTask(task: DecisionTask, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); checkNow(task.updatedAtMs, now);
  requireValue(task.lease !== null && now >= task.lease.expiresAtMs, "claim has not expired");
  return parseDecisionTask({ ...task, status: "pending", lease: null, updatedAtMs: now });
}
export function cancelDecisionTask(task: DecisionTask, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); checkNow(task.updatedAtMs, now);
  requireValue(["pending", "claimed", "running"].includes(task.status), "only unfinished tasks can cancel");
  return parseDecisionTask({ ...task, status: "cancelled", lease: null, updatedAtMs: now });
}
export function supersedeDecisionTask(task: DecisionTask, now: UtcTimestampMs): DecisionTask {
  parseDecisionTask(task); checkNow(task.updatedAtMs, now);
  requireValue(task.status !== "superseded", "superseded task cannot transition");
  return parseDecisionTask({ ...task, status: "superseded", lease: null, updatedAtMs: now });
}
/** Fail closed for malformed, stale, mismatched, or non-approval records. No CI/merge authorization. */
export function isDecisionReviewApproved(task: DecisionTask, result: DecisionResult, current: DecisionReviewTarget & { readonly sessionId: string }): boolean {
  try {
    validateDecisionResultForTask(task, result);
    const { sessionId, ...target } = current;
    validateSessionId(sessionId); parseDecisionReviewTarget(target);
    return task.kind === "review" && result.kind === "review" && task.status === "completed" && result.verdict === "approve" && task.sessionId === sessionId && sameTarget(task.target, target) && result.createdAtMs <= task.updatedAtMs;
  } catch { return false; }
}
export function rebindDecisionSession(session: DecisionSession, binding: ExecutorBinding, now: UtcTimestampMs): DecisionSession {
  parseDecisionSession(session); parseExecutorBinding(binding); checkNow(session.updatedAtMs, now);
  requireValue(session.status !== "completed", "reopen completed session before rebind");
  requireValue(binding.generation === session.bindingGeneration + 1, "binding generation must increment");
  return parseDecisionSession({ ...session, binding, bindingGeneration: binding.generation, status: "active", updatedAtMs: now });
}
export function breakDecisionBinding(session: DecisionSession, now: UtcTimestampMs): DecisionSession {
  parseDecisionSession(session); checkNow(session.updatedAtMs, now);
  requireValue(session.status === "active" && session.binding !== null, "only active bound sessions can break");
  return parseDecisionSession({ ...session, binding: null, status: "broken-binding", updatedAtMs: now });
}
/** tasks must be the store's complete, atomically read set for this session. */
export function completeDecisionSession(session: DecisionSession, tasks: readonly DecisionTask[], now: UtcTimestampMs): DecisionSession {
  parseDecisionSession(session); checkNow(session.updatedAtMs, now);
  requireValue(session.status !== "completed", "session already completed");
  for (const task of tasks) {
    parseDecisionTask(task);
    requireValue(task.sessionId === session.id && !["pending", "claimed", "running"].includes(task.status), "session has foreign or executable task");
    requireValue(task.updatedAtMs <= now, "task newer than completion");
  }
  return parseDecisionSession({ ...session, status: "completed", updatedAtMs: now });
}
export function reopenDecisionSession(session: DecisionSession, now: UtcTimestampMs): DecisionSession {
  parseDecisionSession(session); checkNow(session.updatedAtMs, now);
  requireValue(session.status === "completed", "only completed sessions can reopen");
  return parseDecisionSession({ ...session, status: "active", updatedAtMs: now });
}
