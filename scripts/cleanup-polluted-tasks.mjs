#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process$1 from "node:process";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import crypto__default from "node:crypto";
import * as fsSync from "node:fs";
import os from "node:os";
class DecisionStoreError extends Error {
  code;
  status;
  constructor(message, code = "store_error", status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}
class DecisionStoreLockError extends DecisionStoreError {
  constructor(message) {
    super(message, "store_locked", 503);
  }
}
class CorruptedStoreError extends DecisionStoreError {
  constructor(message) {
    super(message, "corrupted_store", 500);
  }
}
class UnsupportedStoreVersionError extends DecisionStoreError {
  constructor(version2) {
    super(`Unsupported store schemaVersion: ${String(version2)}`, "unsupported_store_version", 500);
  }
}
class StorePoisonedError extends DecisionStoreError {
  constructor(message) {
    super(`Store is poisoned due to previous write failure: ${message}`, "store_poisoned", 503);
  }
}
class DecisionConflictError extends DecisionStoreError {
  constructor(message, code = "conflict") {
    super(message, code, 409);
  }
}
class DecisionNotFoundError extends DecisionStoreError {
  constructor(message, code = "not_found") {
    super(message, code, 404);
  }
}
class DecisionValidationError extends DecisionStoreError {
  constructor(message, code = "validation_error") {
    super(message, code, 400);
  }
}
function requireValue(condition, message) {
  if (!condition) throw new TypeError(`Invalid decision record: ${message}`);
}
function record(value, keys) {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "expected object");
  const object = value;
  requireValue(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null, "expected plain object");
  requireValue(Reflect.ownKeys(object).length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  }), "missing or unknown field");
  return object;
}
function string(value) {
  requireValue(typeof value === "string" && value.trim().length > 0, "expected nonempty string");
}
function integer(value, minimum = 0) {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "expected safe integer");
}
function timestamp(value) {
  integer(value);
  requireValue(value <= 864e13, "timestamp outside UTC range");
}
function oneOf(value, choices) {
  requireValue(typeof value === "string" && choices.includes(value), "invalid enum");
}
function version(value) {
  requireValue(value === 1, "unsupported schemaVersion");
}
function array(value) {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, "expected plain array");
  requireValue(Reflect.ownKeys(value).length === value.length + 1, "unknown array field or sparse array");
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    requireValue(descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"), "expected array data element");
  }
  return value;
}
function strings(value) {
  const items = array(value);
  for (let index = 0; index < items.length; index++) string(items[index]);
}
function repository(value) {
  string(value);
  requireValue(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/.test(value), "expected canonical owner/repository");
  requireValue(!value.endsWith("/.") && !value.endsWith("/.."), "invalid repository");
}
function validateRoot(value) {
  const root = record(value, ["provider", "key"]);
  string(root["provider"]);
  string(root["key"]);
  requireValue(/^[a-z][a-z0-9-]*$/.test(root["provider"]), "invalid work-item provider");
  if (root["provider"] === "github") {
    const match = /^(.*)#([1-9][0-9]*)$/.exec(root["key"]);
    requireValue(match !== null, "invalid GitHub issue key");
    repository(match[1]);
    integer(Number(match[2]), 1);
  }
  return value;
}
function decisionSessionId(root) {
  validateRoot(root);
  return `${root.provider}:${root.key}`;
}
function parseDecisionReviewTarget(value) {
  const target = record(value, ["repository", "prNumber", "headSha"]);
  repository(target["repository"]);
  integer(target["prNumber"], 1);
  requireValue(typeof target["headSha"] === "string" && /^[0-9a-f]{40}$/.test(target["headSha"]), "expected full lowercase HEAD SHA");
  return value;
}
function parseDecisionSessionRootFromId(sessionId) {
  string(sessionId);
  const colon = sessionId.indexOf(":");
  requireValue(colon > 0, "invalid session id");
  return validateRoot({ provider: sessionId.slice(0, colon), key: sessionId.slice(colon + 1) });
}
function validateSessionId(value) {
  string(value);
  parseDecisionSessionRootFromId(value);
}
function decisionTaskId(task) {
  validateSessionId(task.sessionId);
  integer(task.revision, 1);
  oneOf(task.kind, ["plan", "review"]);
  const prefix = `${encodeURIComponent(task.sessionId)}:${task.kind}:${task.revision}`;
  if (task.kind === "plan") return prefix;
  const target = parseDecisionReviewTarget(task.target);
  return `${prefix}:${encodeURIComponent(target.repository)}:${target.prNumber}:${target.headSha}`;
}
function parseExecutorBinding(value) {
  const binding = record(value, ["schemaVersion", "adapter", "externalSessionRef", "resumeUri", "generation"]);
  version(binding["schemaVersion"]);
  string(binding["adapter"]);
  string(binding["externalSessionRef"]);
  if (binding["resumeUri"] !== null) string(binding["resumeUri"]);
  integer(binding["generation"], 1);
  return value;
}
function times(object) {
  timestamp(object["createdAtMs"]);
  timestamp(object["updatedAtMs"]);
  requireValue(object["updatedAtMs"] >= object["createdAtMs"], "time moved backwards");
}
function parseDecisionSession(value) {
  const session = record(value, ["schemaVersion", "id", "root", "status", "binding", "bindingGeneration", "createdAtMs", "updatedAtMs"]);
  version(session["schemaVersion"]);
  const root = validateRoot(session["root"]);
  requireValue(session["id"] === decisionSessionId(root), "session/root mismatch");
  oneOf(session["status"], ["active", "completed", "broken-binding"]);
  integer(session["bindingGeneration"]);
  times(session);
  if (session["binding"] !== null) {
    const binding = parseExecutorBinding(session["binding"]);
    requireValue(binding.generation === session["bindingGeneration"], "binding generation mismatch");
  }
  requireValue(session["status"] !== "broken-binding" || session["binding"] === null && session["bindingGeneration"] > 0, "broken binding must retain generation and be cleared");
  return value;
}
function parseDecisionLease(value) {
  const lease = record(value, ["owner", "token", "generation", "expiresAtMs"]);
  string(lease["owner"]);
  string(lease["token"]);
  integer(lease["generation"], 1);
  timestamp(lease["expiresAtMs"]);
  return value;
}
function parseDecisionTask(value) {
  requireValue(typeof value === "object" && value !== null, "expected task");
  const kind = value["kind"];
  oneOf(kind, ["plan", "review"]);
  const task = record(value, ["schemaVersion", "id", "sessionId", "kind", "revision", "status", "lease", "claimGeneration", "lastClaimToken", "createdAtMs", "updatedAtMs", ...kind === "review" ? ["target"] : []]);
  version(task["schemaVersion"]);
  validateSessionId(task["sessionId"]);
  integer(task["revision"], 1);
  oneOf(task["status"], ["pending", "claimed", "running", "completed", "failed", "cancelled", "superseded"]);
  integer(task["claimGeneration"]);
  times(task);
  if (task["lastClaimToken"] !== null) string(task["lastClaimToken"]);
  requireValue(task["claimGeneration"] === 0 === (task["lastClaimToken"] === null), "claim history mismatch");
  requireValue(!["completed", "failed"].includes(task["status"]) || task["claimGeneration"] > 0, "terminal execution requires claim history");
  const leased = task["status"] === "claimed" || task["status"] === "running";
  requireValue(leased === (task["lease"] !== null), "lease/status mismatch");
  if (task["lease"] !== null) {
    const lease = parseDecisionLease(task["lease"]);
    requireValue(lease.generation === task["claimGeneration"] && lease.token === task["lastClaimToken"], "lease/history mismatch");
    requireValue(lease.expiresAtMs > task["updatedAtMs"], "lease already expired at transition");
  }
  if (kind === "review") parseDecisionReviewTarget(task["target"]);
  requireValue(task["id"] === decisionTaskId(value), "task id mismatch");
  return value;
}
function parseDecisionResult(value) {
  requireValue(typeof value === "object" && value !== null, "expected result");
  const kind = value["kind"];
  oneOf(kind, ["plan", "review"]);
  const result = record(value, ["schemaVersion", "taskId", "sessionId", "kind", "revision", "createdAtMs", "verdict", ...kind === "plan" ? ["content"] : ["target", "findings"]]);
  version(result["schemaVersion"]);
  validateSessionId(result["sessionId"]);
  integer(result["revision"], 1);
  timestamp(result["createdAtMs"]);
  if (kind === "plan") {
    oneOf(result["verdict"], ["ready", "needs_clarification", "needs_human"]);
    const content = record(result["content"], ["plan", "acceptanceCriteria", "risks", "clarifications"]);
    string(content["plan"]);
    strings(content["acceptanceCriteria"]);
    strings(content["risks"]);
    strings(content["clarifications"]);
  } else {
    oneOf(result["verdict"], ["approve", "changes_requested", "needs_human"]);
    parseDecisionReviewTarget(result["target"]);
    const findings = array(result["findings"]);
    for (let index = 0; index < findings.length; index++) {
      const finding = record(findings[index], ["severity", "message", "location"]);
      oneOf(finding["severity"], ["blocker", "suggestion"]);
      string(finding["message"]);
      if (finding["location"] !== null) string(finding["location"]);
    }
  }
  requireValue(result["taskId"] === decisionTaskId(value), "result task id mismatch");
  return value;
}
function sameTarget(a, b) {
  return a.repository === b.repository && a.prNumber === b.prNumber && a.headSha === b.headSha;
}
function validateDecisionResultForTask(task, result) {
  parseDecisionTask(task);
  parseDecisionResult(result);
  requireValue(task.kind === result.kind && task.id === result.taskId && task.sessionId === result.sessionId && task.revision === result.revision, "result/task mismatch");
  requireValue(result.createdAtMs >= task.createdAtMs, "result predates task");
  if (task.kind === "review" && result.kind === "review") requireValue(sameTarget(task.target, result.target), "review target mismatch");
}
function checkNow(updatedAtMs, now) {
  timestamp(now);
  requireValue(now >= updatedAtMs, "time moved backwards");
}
function checkLease(task, lease, now) {
  parseDecisionLease(lease);
  requireValue(task.lease !== null && task.lease.owner === lease.owner && task.lease.token === lease.token && task.lease.generation === lease.generation && task.lease.expiresAtMs === lease.expiresAtMs, "stale claim");
  requireValue(now < task.lease.expiresAtMs, "expired claim");
}
function claimDecisionTask(task, lease, now) {
  parseDecisionTask(task);
  parseDecisionLease(lease);
  checkNow(task.updatedAtMs, now);
  requireValue(task.status === "pending", "only pending tasks can be claimed");
  requireValue(lease.generation === task.claimGeneration + 1 && lease.token !== task.lastClaimToken && lease.expiresAtMs > now, "claim must be fresh");
  return parseDecisionTask({ ...task, status: "claimed", lease, claimGeneration: lease.generation, lastClaimToken: lease.token, updatedAtMs: now });
}
function startDecisionTask(task, lease, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  checkLease(task, lease, now);
  requireValue(task.status === "claimed", "only claimed tasks can start");
  return parseDecisionTask({ ...task, status: "running", updatedAtMs: now });
}
function heartbeatDecisionTask(task, lease, newExpiry, now) {
  parseDecisionTask(task);
  parseDecisionLease(lease);
  checkNow(task.updatedAtMs, now);
  checkLease(task, lease, now);
  requireValue(task.status === "claimed" || task.status === "running", "only leased tasks can heartbeat");
  timestamp(newExpiry);
  requireValue(newExpiry > now, "heartbeat expiry must be in the future");
  const updatedLease = { ...task.lease, expiresAtMs: newExpiry };
  return parseDecisionTask({ ...task, lease: updatedLease, updatedAtMs: now });
}
function completeDecisionTask(task, result, lease, now) {
  validateDecisionResultForTask(task, result);
  checkNow(task.updatedAtMs, now);
  checkLease(task, lease, now);
  requireValue(task.status === "running" && result.createdAtMs <= now, "only running tasks with a current result can complete");
  return parseDecisionTask({ ...task, status: "completed", lease: null, updatedAtMs: now });
}
function failDecisionTask(task, lease, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  checkLease(task, lease, now);
  requireValue(task.status === "claimed" || task.status === "running", "only leased tasks can fail");
  return parseDecisionTask({ ...task, status: "failed", lease: null, updatedAtMs: now });
}
function releaseExpiredDecisionTask(task, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  requireValue(task.lease !== null && now >= task.lease.expiresAtMs, "claim has not expired");
  return parseDecisionTask({ ...task, status: "pending", lease: null, updatedAtMs: now });
}
function releaseDecisionTaskForBindingInvalidation(task, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  requireValue(task.lease !== null && (task.status === "claimed" || task.status === "running"), "only actively leased tasks can be released for binding invalidation");
  return parseDecisionTask({ ...task, status: "pending", lease: null, updatedAtMs: now });
}
function cancelDecisionTask(task, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  requireValue(["pending", "claimed", "running"].includes(task.status), "only unfinished tasks can cancel");
  return parseDecisionTask({ ...task, status: "cancelled", lease: null, updatedAtMs: now });
}
function supersedeDecisionTask(task, now) {
  parseDecisionTask(task);
  checkNow(task.updatedAtMs, now);
  requireValue(task.status !== "superseded", "superseded task cannot transition");
  return parseDecisionTask({ ...task, status: "superseded", lease: null, updatedAtMs: now });
}
function isDecisionReviewApproved(task, result, current) {
  try {
    validateDecisionResultForTask(task, result);
    const { sessionId, ...target } = current;
    validateSessionId(sessionId);
    parseDecisionReviewTarget(target);
    return task.kind === "review" && result.kind === "review" && task.status === "completed" && result.verdict === "approve" && task.sessionId === sessionId && sameTarget(task.target, target) && result.createdAtMs <= task.updatedAtMs;
  } catch {
    return false;
  }
}
function rebindDecisionSession(session, binding, now) {
  parseDecisionSession(session);
  parseExecutorBinding(binding);
  checkNow(session.updatedAtMs, now);
  requireValue(session.status !== "completed", "reopen completed session before rebind");
  requireValue(binding.generation === session.bindingGeneration + 1, "binding generation must increment");
  return parseDecisionSession({ ...session, binding, bindingGeneration: binding.generation, status: "active", updatedAtMs: now });
}
function breakDecisionBinding(session, now) {
  parseDecisionSession(session);
  checkNow(session.updatedAtMs, now);
  requireValue(session.status === "active" && session.binding !== null, "only active bound sessions can break");
  return parseDecisionSession({ ...session, binding: null, status: "broken-binding", updatedAtMs: now });
}
function completeDecisionSession(session, tasks, now) {
  parseDecisionSession(session);
  checkNow(session.updatedAtMs, now);
  requireValue(session.status !== "completed", "session already completed");
  for (const task of tasks) {
    parseDecisionTask(task);
    requireValue(task.sessionId === session.id && !["pending", "claimed", "running"].includes(task.status), "session has foreign or executable task");
    requireValue(task.updatedAtMs <= now, "task newer than completion");
  }
  return parseDecisionSession({ ...session, status: "completed", updatedAtMs: now });
}
function reopenDecisionSession(session, now) {
  parseDecisionSession(session);
  checkNow(session.updatedAtMs, now);
  requireValue(session.status === "completed", "only completed sessions can reopen");
  return parseDecisionSession({ ...session, status: "active", updatedAtMs: now });
}
function boolean(value) {
  requireValue(typeof value === "boolean", "expected boolean");
}
function sha(value) {
  requireValue(typeof value === "string" && /^[0-9a-f]{40}$/.test(value), "expected full lowercase 40-char SHA");
}
function parseDecisionContextBundle(value) {
  requireValue(typeof value === "object" && value !== null, "expected context bundle object");
  const strategy = value["strategy"];
  oneOf(strategy, ["connector", "materialized"]);
  if (strategy === "connector") {
    const obj2 = record(value, ["strategy", "workItem", "repository", "prNumber", "headSha"]);
    const workItem2 = validateRoot(obj2["workItem"]);
    repository(obj2["repository"]);
    if (obj2["prNumber"] !== null) integer(obj2["prNumber"], 1);
    if (obj2["headSha"] !== null) sha(obj2["headSha"]);
    return {
      strategy: "connector",
      workItem: workItem2,
      repository: obj2["repository"],
      prNumber: obj2["prNumber"],
      headSha: obj2["headSha"]
    };
  }
  const obj = record(value, [
    "strategy",
    "workItem",
    "repository",
    "issue",
    "plan",
    "pullRequest",
    "diff",
    "ci",
    "repositoryInstructions",
    "previousReviews",
    "unresolvedFindings"
  ]);
  const workItem = validateRoot(obj["workItem"]);
  repository(obj["repository"]);
  const rawIssue = record(obj["issue"], ["repository", "number", "title", "body"]);
  repository(rawIssue["repository"]);
  integer(rawIssue["number"], 1);
  string(rawIssue["title"]);
  requireValue(typeof rawIssue["body"] === "string", "expected issue body string");
  const issue = {
    repository: rawIssue["repository"],
    number: rawIssue["number"],
    title: rawIssue["title"],
    body: rawIssue["body"]
  };
  let plan = null;
  if (obj["plan"] !== null) {
    const rawPlan = record(obj["plan"], ["taskId", "revision", "plan", "acceptanceCriteria", "risks", "clarifications"]);
    string(rawPlan["taskId"]);
    integer(rawPlan["revision"], 1);
    string(rawPlan["plan"]);
    strings(rawPlan["acceptanceCriteria"]);
    strings(rawPlan["risks"]);
    strings(rawPlan["clarifications"]);
    plan = {
      taskId: rawPlan["taskId"],
      revision: rawPlan["revision"],
      plan: rawPlan["plan"],
      acceptanceCriteria: rawPlan["acceptanceCriteria"],
      risks: rawPlan["risks"],
      clarifications: rawPlan["clarifications"]
    };
  }
  let pullRequest = null;
  if (obj["pullRequest"] !== null) {
    const rawPr = record(obj["pullRequest"], ["repository", "prNumber", "headSha", "baseRef", "headRef", "title", "body"]);
    repository(rawPr["repository"]);
    integer(rawPr["prNumber"], 1);
    sha(rawPr["headSha"]);
    string(rawPr["baseRef"]);
    string(rawPr["headRef"]);
    string(rawPr["title"]);
    requireValue(typeof rawPr["body"] === "string", "expected PR body string");
    pullRequest = {
      repository: rawPr["repository"],
      prNumber: rawPr["prNumber"],
      headSha: rawPr["headSha"],
      baseRef: rawPr["baseRef"],
      headRef: rawPr["headRef"],
      title: rawPr["title"],
      body: rawPr["body"]
    };
  }
  let diff = null;
  if (obj["diff"] !== null) {
    const rawDiff = record(obj["diff"], ["patch", "files", "truncated"]);
    requireValue(typeof rawDiff["patch"] === "string", "expected patch string");
    strings(rawDiff["files"]);
    boolean(rawDiff["truncated"]);
    diff = {
      patch: rawDiff["patch"],
      files: rawDiff["files"],
      truncated: rawDiff["truncated"]
    };
  }
  let ci = null;
  if (obj["ci"] !== null) {
    const rawCi = record(obj["ci"], ["state", "summary", "checks"]);
    string(rawCi["state"]);
    requireValue(typeof rawCi["summary"] === "string", "expected CI summary string");
    const rawChecks = array(rawCi["checks"]);
    const checks = [];
    for (const item of rawChecks) {
      const checkRecord = record(item, ["name", "status", "conclusion", "url"]);
      string(checkRecord["name"]);
      string(checkRecord["status"]);
      if (checkRecord["conclusion"] !== null) string(checkRecord["conclusion"]);
      if (checkRecord["url"] !== null) string(checkRecord["url"]);
      checks.push({
        name: checkRecord["name"],
        status: checkRecord["status"],
        conclusion: checkRecord["conclusion"],
        url: checkRecord["url"]
      });
    }
    ci = {
      state: rawCi["state"],
      summary: rawCi["summary"],
      checks
    };
  }
  let repositoryInstructions = null;
  if (obj["repositoryInstructions"] !== null) {
    requireValue(typeof obj["repositoryInstructions"] === "string", "expected repository instructions string");
    repositoryInstructions = obj["repositoryInstructions"];
  }
  const rawReviews = array(obj["previousReviews"]);
  const previousReviews = [];
  for (const item of rawReviews) {
    const parsed = parseDecisionResult(item);
    requireValue(parsed.kind === "review", "previousReviews elements must be review results");
    previousReviews.push(parsed);
  }
  const rawFindings = array(obj["unresolvedFindings"]);
  const unresolvedFindings = [];
  for (const item of rawFindings) {
    const findingRecord = record(item, ["severity", "message", "location"]);
    oneOf(findingRecord["severity"], ["blocker", "suggestion"]);
    string(findingRecord["message"]);
    if (findingRecord["location"] !== null) string(findingRecord["location"]);
    unresolvedFindings.push({
      severity: findingRecord["severity"],
      message: findingRecord["message"],
      location: findingRecord["location"]
    });
  }
  return {
    strategy: "materialized",
    workItem,
    repository: obj["repository"],
    issue,
    plan,
    pullRequest,
    diff,
    ci,
    repositoryInstructions,
    previousReviews,
    unresolvedFindings
  };
}
function validateDecisionContextForTask(context, task, session) {
  parseDecisionTask(task);
  parseDecisionContextBundle(context);
  if (session !== void 0) {
    parseDecisionSession(session);
    requireValue(task.sessionId === session.id, "task sessionId mismatch with session id");
    requireValue(
      context.workItem.provider === session.root.provider && context.workItem.key === session.root.key,
      "context workItem mismatch with session root"
    );
  } else {
    const expectedRoot = parseDecisionSessionRootFromId(task.sessionId);
    requireValue(
      context.workItem.provider === expectedRoot.provider && context.workItem.key === expectedRoot.key,
      "context workItem mismatch with task session root"
    );
  }
  const effectiveRoot = session !== void 0 ? session.root : parseDecisionSessionRootFromId(task.sessionId);
  if (effectiveRoot.provider === "github") {
    const match = /^(.*)#([1-9][0-9]*)$/.exec(effectiveRoot.key);
    requireValue(match !== null, "invalid GitHub issue key in session root");
    const expectedRepo = match[1];
    const expectedIssueNum = Number(match[2]);
    requireValue(
      context.repository === expectedRepo,
      "context repository mismatch with session root repository"
    );
    if (context.strategy === "materialized") {
      requireValue(
        context.issue.repository === expectedRepo,
        "materialized issue repository mismatch with session root repository"
      );
      requireValue(
        context.issue.number === expectedIssueNum,
        "materialized issue number mismatch with session root issue number"
      );
    }
  }
  if (task.kind === "review") {
    if (context.strategy === "connector") {
      requireValue(
        context.repository === task.target.repository && context.prNumber === task.target.prNumber && context.headSha === task.target.headSha,
        "connector review context repository/prNumber/headSha mismatch with task target"
      );
    } else {
      requireValue(
        context.repository === task.target.repository,
        "materialized review context repository mismatch with task target"
      );
      requireValue(
        context.pullRequest !== null,
        "materialized review context must include pullRequest metadata"
      );
      requireValue(
        context.pullRequest.repository === task.target.repository && context.pullRequest.prNumber === task.target.prNumber && context.pullRequest.headSha === task.target.headSha,
        "materialized review context pullRequest mismatch with task target"
      );
    }
  } else {
    if (context.strategy === "materialized") {
      requireValue(
        context.issue.repository === context.repository,
        "materialized plan context issue repository mismatch with context repository"
      );
    }
  }
}
function canonicalJsonStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return `[${items.join(",")}]`;
  }
  const obj = value;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => {
    const serializedKey = JSON.stringify(key);
    const serializedValue = canonicalJsonStringify(obj[key]);
    return `${serializedKey}:${serializedValue}`;
  });
  return `{${pairs.join(",")}}`;
}
function canonicalJsonEqual(a, b) {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}
function computeRequirementFingerprint(title, body, clarifications = []) {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  const normalizedClarifications = clarifications.map((c) => c.trim()).filter((c) => c.length > 0);
  const payload = {
    title: normalizedTitle,
    body: normalizedBody,
    clarifications: normalizedClarifications
  };
  const hash = crypto__default.createHash("sha256");
  hash.update(canonicalJsonStringify(payload), "utf8");
  return hash.digest("hex");
}
class DecisionService {
  store;
  clock;
  defaultClaimTtlMs;
  constructor(store, config = {}) {
    this.store = store;
    this.clock = config.clock ?? (() => Date.now());
    this.defaultClaimTtlMs = config.defaultClaimTtlMs ?? 12e4;
  }
  /** Read-only operational view from the already-open store. */
  observeWork(root) {
    return this.store.observeWork(root);
  }
  /** Read current tasks from the already-open authoritative store; never expose lease tokens. */
  continuityWork() {
    const claimBindings = this.store.getState().claimBindingGenerations;
    return this.store.getAllSessions().map((session) => ({
      workKey: session.root,
      sessionId: session.id,
      bindingGeneration: session.bindingGeneration,
      tasks: this.getTasksForSession(session.id).map((task) => ({
        id: task.id,
        revision: task.revision,
        kind: task.kind,
        status: task.status,
        claimBindingGeneration: claimBindings[task.id] ?? null,
        claimGeneration: task.claimGeneration,
        createdAtMs: task.createdAtMs,
        owner: task.lease?.owner ?? null,
        leaseExpiresAtMs: task.lease?.expiresAtMs ?? null,
        verdict: this.getResult(task.id)?.verdict ?? null,
        target: task.kind === "review" ? task.target : null
      }))
    }));
  }
  /** Authority commit: renewal, completion, rebinding and competing reclaim all win over stale callers. */
  async reclaimExpiredClaim(expected) {
    return this.store.transaction((draft) => {
      const task = draft.tasks[expected.taskId];
      const session = task ? draft.sessions[task.sessionId] : void 0;
      const now = this.clock();
      if (!task || !session || session.status === "completed" || task.revision !== expected.revision || task.claimGeneration !== expected.claimGeneration || session.bindingGeneration !== expected.bindingGeneration || task.status !== "claimed" && task.status !== "running" || !task.lease || task.lease.expiresAtMs !== expected.leaseExpiresAtMs || now < task.lease.expiresAtMs) return false;
      draft.tasks[task.id] = releaseExpiredDecisionTask(task, now);
      delete draft.claimBindingGenerations?.[task.id];
      return true;
    });
  }
  getStore() {
    return this.store;
  }
  async createSession(root) {
    const id = decisionSessionId(root);
    const existing = this.store.getSession(id);
    if (existing) {
      return existing;
    }
    return await this.store.transaction((draft) => {
      const current = draft.sessions[id];
      if (current) return current;
      const now = this.clock();
      const session = {
        schemaVersion: 1,
        id,
        root,
        status: "active",
        binding: null,
        bindingGeneration: 0,
        createdAtMs: now,
        updatedAtMs: now
      };
      draft.sessions[id] = session;
      return session;
    });
  }
  getSession(id) {
    return this.store.getSession(id);
  }
  getAllSessions() {
    return this.store.getAllSessions();
  }
  async putBinding(sessionId, params) {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }
      const now = this.clock();
      if (params.owner !== void 0 || params.token !== void 0 || params.generation !== void 0) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) => t.sessionId === sessionId && (t.status === "claimed" || t.status === "running") && t.lease !== null && now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for binding update");
        }
        if (activeLeaseTask.lease.owner !== params.owner || activeLeaseTask.lease.token !== params.token || activeLeaseTask.lease.generation !== params.generation) {
          throw new DecisionConflictError("Stale or invalid lease credentials for binding update");
        }
      }
      if (session.binding !== null) {
        if (session.binding.adapter === params.adapter && session.binding.externalSessionRef === params.externalSessionRef && session.binding.resumeUri === params.resumeUri) {
          return session;
        }
        throw new DecisionConflictError(
          "Session is already bound. To replace with a new generation, use POST /v1/sessions/:id/rebind"
        );
      }
      if (session.status === "completed") {
        throw new DecisionConflictError("Cannot bind a completed session; reopen first");
      }
      const nextGen = session.bindingGeneration === 0 ? 1 : session.bindingGeneration + 1;
      const updated = {
        ...session,
        binding: {
          schemaVersion: 1,
          adapter: params.adapter,
          externalSessionRef: params.externalSessionRef,
          resumeUri: params.resumeUri,
          generation: nextGen
        },
        bindingGeneration: nextGen,
        status: "active",
        updatedAtMs: now
      };
      draft.sessions[sessionId] = updated;
      if (session.bindingGeneration === 0 && nextGen === 1) {
        if (!draft.claimBindingGenerations) {
          draft.claimBindingGenerations = {};
        }
        for (const t of Object.values(draft.tasks)) {
          if (t.sessionId === sessionId && (t.status === "claimed" || t.status === "running") && draft.claimBindingGenerations[t.id] === 0) {
            draft.claimBindingGenerations[t.id] = 1;
          }
        }
      }
      return updated;
    });
  }
  async rebindSession(sessionId, params) {
    const checkRebindOp = (op) => {
      const genMatches = params.expectedGeneration === op.expectedGeneration || params.expectedGeneration === op.bindingGeneration;
      if (op.kind !== "rebind-session" || op.sessionId !== sessionId || !genMatches || op.adapter !== params.adapter || op.externalSessionRef !== params.externalSessionRef || op.resumeUri !== params.resumeUri || !op.resultingSession) {
        throw new DecisionConflictError(
          `Operation key "${params.operationKey}" was already used for a different operation`
        );
      }
      return op.resultingSession;
    };
    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        return checkRebindOp(op);
      }
    }
    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          return checkRebindOp(op);
        }
      }
      const session = draft.sessions[sessionId];
      if (!session) {
        throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      }
      const now = this.clock();
      if (params.owner !== void 0 || params.token !== void 0 || params.generation !== void 0) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) => t.sessionId === sessionId && (t.status === "claimed" || t.status === "running") && t.lease !== null && now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for binding update");
        }
        if (activeLeaseTask.lease.owner !== params.owner || activeLeaseTask.lease.token !== params.token || activeLeaseTask.lease.generation !== params.generation) {
          throw new DecisionConflictError("Stale or invalid lease credentials for binding update");
        }
      }
      if (session.bindingGeneration !== params.expectedGeneration) {
        throw new DecisionConflictError(
          `Compare-and-swap failed: expected bindingGeneration ${params.expectedGeneration}, but current is ${session.bindingGeneration}`
        );
      }
      const nextGen = session.bindingGeneration + 1;
      const binding = {
        schemaVersion: 1,
        adapter: params.adapter,
        externalSessionRef: params.externalSessionRef,
        resumeUri: params.resumeUri,
        generation: nextGen
      };
      const updated = rebindDecisionSession(session, binding, now);
      draft.sessions[sessionId] = updated;
      if (!draft.claimBindingGenerations) {
        draft.claimBindingGenerations = {};
      }
      for (const t of Object.values(draft.tasks)) {
        if (t.sessionId === sessionId && (t.status === "claimed" || t.status === "running")) {
          draft.tasks[t.id] = releaseDecisionTaskForBindingInvalidation(t, now);
          delete draft.claimBindingGenerations[t.id];
        }
      }
      if (params.operationKey) {
        const receipt = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "rebind-session",
          sessionId,
          bindingGeneration: nextGen,
          expectedGeneration: params.expectedGeneration,
          adapter: params.adapter,
          externalSessionRef: params.externalSessionRef,
          resumeUri: params.resumeUri,
          resultingSession: updated,
          entityId: sessionId,
          createdAtMs: now
        };
        draft.operationReceipts[params.operationKey] = receipt;
      }
      return updated;
    });
  }
  async breakBinding(sessionId, params) {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const now = this.clock();
      if (params?.owner !== void 0 || params?.token !== void 0 || params?.generation !== void 0) {
        const activeLeaseTask = Object.values(draft.tasks).find(
          (t) => t.sessionId === sessionId && (t.status === "claimed" || t.status === "running") && t.lease !== null && now < t.lease.expiresAtMs
        );
        if (!activeLeaseTask || !activeLeaseTask.lease) {
          throw new DecisionConflictError("No active lease found on session matching credentials for break binding");
        }
        if (activeLeaseTask.lease.owner !== params.owner || activeLeaseTask.lease.token !== params.token || activeLeaseTask.lease.generation !== params.generation) {
          throw new DecisionConflictError("Stale or invalid lease credentials for break binding");
        }
      }
      if (params?.expectedGeneration !== void 0) {
        if (session.bindingGeneration > params.expectedGeneration) {
          throw new DecisionConflictError(
            `Stale breakBinding request: expectedGeneration was ${params.expectedGeneration}, but session is at ${session.bindingGeneration}`
          );
        }
        if (session.status === "broken-binding" && session.bindingGeneration === params.expectedGeneration) {
          return session;
        }
      }
      if (session.status === "broken-binding") {
        return session;
      }
      const updated = breakDecisionBinding(session, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }
  async completeSession(sessionId) {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const tasks = Object.values(draft.tasks).filter((t) => t.sessionId === sessionId);
      const now = this.clock();
      const updated = completeDecisionSession(session, tasks, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }
  async reopenSession(sessionId) {
    return await this.store.transaction((draft) => {
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      const now = this.clock();
      const updated = reopenDecisionSession(session, now);
      draft.sessions[sessionId] = updated;
      return updated;
    });
  }
  async createPlanTask(sessionId, params = {}) {
    const title = params.requirements?.title?.trim() || (params.context?.strategy === "materialized" ? params.context.issue.title : "") || "Issue Requirements";
    const body = params.requirements?.body ?? (params.context?.strategy === "materialized" ? params.context.issue.body : "");
    const clarifications = params.requirements?.clarifications ?? [];
    const fingerprint = computeRequirementFingerprint(title, body, clarifications);
    const triggerKind = params.triggerKind ?? "initial";
    const previousTaskId = params.previousTaskId ?? null;
    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (op.kind !== "create-plan-task" || op.sessionId !== sessionId) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        if (op.fingerprint !== void 0 && op.fingerprint !== fingerprint || op.triggerKind !== void 0 && op.triggerKind !== triggerKind || op.previousTaskId !== void 0 && op.previousTaskId !== previousTaskId) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used with different parameters`
          );
        }
        const existing = this.store.getTask(op.entityId);
        if (existing) {
          return existing;
        }
      }
    }
    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          if (op.kind !== "create-plan-task" || op.sessionId !== sessionId) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used for a different operation`
            );
          }
          if (op.fingerprint !== void 0 && op.fingerprint !== fingerprint || op.triggerKind !== void 0 && op.triggerKind !== triggerKind || op.previousTaskId !== void 0 && op.previousTaskId !== previousTaskId) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used with different parameters`
            );
          }
          const existing = draft.tasks[op.entityId];
          if (existing) {
            return existing;
          }
        }
      }
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }
      const now = this.clock();
      const revKey = `plan:${sessionId}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;
      for (const t of Object.values(draft.tasks)) {
        if (t.sessionId === sessionId && t.kind === "plan" && t.status !== "superseded") {
          draft.tasks[t.id] = supersedeDecisionTask(t, now);
        }
      }
      for (const p of Object.values(draft.plans)) {
        if (p.sessionId === sessionId && (p.status === "pending" || p.status === "running")) {
          draft.plans[p.taskId] = {
            ...p,
            status: "superseded",
            updatedAtMs: now
          };
        }
      }
      const id = decisionTaskId({ sessionId, kind: "plan", revision: rev });
      const task = {
        schemaVersion: 1,
        id,
        sessionId,
        kind: "plan",
        revision: rev,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: now,
        updatedAtMs: now
      };
      draft.tasks[id] = task;
      if (params.context) {
        const parsed = parseDecisionContextBundle(params.context);
        validateDecisionContextForTask(parsed, task, session);
        draft.contexts[id] = parsed;
      } else {
        const root = session.root;
        const match = /^(.*)#([1-9][0-9]*)$/.exec(root.key);
        let repo = match ? match[1] : root.key.includes("/") ? root.key.split("#")[0] : "symphony/repo";
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/.test(repo)) {
          repo = "symphony/repo";
        }
        const issueNumber = match ? Number(match[2]) : 1;
        let priorMaterializedPlan = null;
        if (previousTaskId) {
          const prevPlan = draft.plans[previousTaskId];
          if (prevPlan && prevPlan.result?.kind === "plan") {
            priorMaterializedPlan = {
              taskId: prevPlan.taskId,
              revision: prevPlan.revision,
              plan: prevPlan.result.content.plan,
              acceptanceCriteria: prevPlan.result.content.acceptanceCriteria,
              risks: prevPlan.result.content.risks,
              clarifications: prevPlan.result.content.clarifications
            };
          }
        } else {
          const prevPlans = Object.values(draft.plans).filter((p) => p.sessionId === sessionId && p.status === "completed" && p.result !== null).sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
          const prev = prevPlans[0];
          if (prev && prev.result?.kind === "plan") {
            priorMaterializedPlan = {
              taskId: prev.taskId,
              revision: prev.revision,
              plan: prev.result.content.plan,
              acceptanceCriteria: prev.result.content.acceptanceCriteria,
              risks: prev.result.content.risks,
              clarifications: prev.result.content.clarifications
            };
          }
        }
        let enrichedBody = body;
        if (clarifications.length > 0) {
          enrichedBody += `

### Clarifications
` + clarifications.map((c) => `- ${c}`).join("\n");
        }
        const autoContext = {
          strategy: "materialized",
          workItem: root,
          repository: repo,
          issue: {
            repository: repo,
            number: issueNumber,
            title,
            body: enrichedBody
          },
          plan: priorMaterializedPlan,
          pullRequest: null,
          diff: null,
          ci: null,
          repositoryInstructions: null,
          previousReviews: [],
          unresolvedFindings: []
        };
        draft.contexts[id] = autoContext;
      }
      const planRecord = {
        schemaVersion: 1,
        sessionId,
        taskId: id,
        revision: rev,
        triggerKind: params.triggerKind ?? (rev === 1 ? "initial" : "clarification"),
        requirements: {
          title,
          body,
          clarifications,
          fingerprint
        },
        previousTaskId,
        status: "pending",
        result: null,
        publishedCommentId: null,
        publishedAtMs: null,
        createdAtMs: now,
        updatedAtMs: now
      };
      draft.plans[id] = planRecord;
      if (params.operationKey) {
        draft.operationReceipts[params.operationKey] = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "create-plan-task",
          sessionId,
          triggerKind,
          fingerprint,
          previousTaskId,
          entityId: id,
          createdAtMs: now
        };
      }
      return task;
    });
  }
  async createReviewTask(sessionId, params) {
    parseDecisionReviewTarget(params.target);
    if (params.operationKey) {
      const op = this.store.getOperationReceipt(params.operationKey);
      if (op) {
        if (op.kind !== "create-review-task" || op.sessionId !== sessionId || !canonicalJsonEqual(op.target, params.target)) {
          throw new DecisionConflictError(
            `Operation key "${params.operationKey}" was already used for a different operation`
          );
        }
        const existing = this.store.getTask(op.entityId);
        if (existing && existing.status !== "superseded" && existing.status !== "failed" && existing.status !== "cancelled") {
          return existing;
        }
      }
    }
    return await this.store.transaction((draft) => {
      if (params.operationKey) {
        const op = draft.operationReceipts[params.operationKey];
        if (op) {
          if (op.kind !== "create-review-task" || op.sessionId !== sessionId || !canonicalJsonEqual(op.target, params.target)) {
            throw new DecisionConflictError(
              `Operation key "${params.operationKey}" was already used for a different operation`
            );
          }
          const existing = draft.tasks[op.entityId];
          if (existing && existing.status !== "superseded" && existing.status !== "failed" && existing.status !== "cancelled") {
            return existing;
          }
        }
      }
      const session = draft.sessions[sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot create task for session in status "${session.status}"`);
      }
      const now = this.clock();
      const isExplicitNewRound = Boolean(params.forceNewRevision || params.operationKey && !draft.operationReceipts[params.operationKey]);
      const existingTask = Object.values(draft.tasks).find(
        (t) => {
          if (t.sessionId !== sessionId || t.kind !== "review" || t.target.repository.toLowerCase() !== params.target.repository.toLowerCase() || t.target.prNumber !== params.target.prNumber || t.target.headSha !== params.target.headSha) {
            return false;
          }
          if (t.status === "superseded" || t.status === "failed" || t.status === "cancelled") {
            return false;
          }
          if (t.status === "pending" || t.status === "claimed" || t.status === "running") {
            const existingCtx = draft.contexts[t.id];
            if (params.context?.strategy === "materialized" && params.context.plan) {
              if (!existingCtx || existingCtx.strategy !== "materialized" || !existingCtx.plan || existingCtx.plan.taskId !== params.context.plan.taskId || existingCtx.plan.revision !== params.context.plan.revision) {
                return false;
              }
            }
            return true;
          }
          if (t.status === "completed") {
            if (isExplicitNewRound) return false;
            const existingCtx = draft.contexts[t.id];
            if (params.context?.strategy === "materialized" && params.context.plan) {
              if (!existingCtx || existingCtx.strategy !== "materialized" || !existingCtx.plan || existingCtx.plan.taskId !== params.context.plan.taskId || existingCtx.plan.revision !== params.context.plan.revision) {
                return false;
              }
            }
            const res = draft.results[t.id];
            return Boolean(res && res.kind === "review");
          }
          return false;
        }
      );
      if (existingTask) {
        if (params.operationKey && !draft.operationReceipts[params.operationKey]) {
          draft.operationReceipts[params.operationKey] = {
            schemaVersion: 1,
            operationKey: params.operationKey,
            kind: "create-review-task",
            sessionId,
            target: params.target,
            entityId: existingTask.id,
            createdAtMs: now
          };
        }
        return existingTask;
      }
      const revKey = `review:${sessionId}:${params.target.repository}:${params.target.prNumber}`;
      const rev = (draft.revisions[revKey] ?? 0) + 1;
      draft.revisions[revKey] = rev;
      const shouldSupersede = Boolean(params.supersedeSessionReviews);
      for (const t of Object.values(draft.tasks)) {
        if (t.sessionId === sessionId && t.kind === "review" && (shouldSupersede || t.target.repository === params.target.repository && t.target.prNumber === params.target.prNumber) && t.status !== "superseded") {
          draft.tasks[t.id] = supersedeDecisionTask(t, now);
        }
      }
      const id = decisionTaskId({
        sessionId,
        kind: "review",
        revision: rev,
        target: params.target
      });
      const task = {
        schemaVersion: 1,
        id,
        sessionId,
        kind: "review",
        revision: rev,
        target: params.target,
        status: "pending",
        lease: null,
        claimGeneration: 0,
        lastClaimToken: null,
        createdAtMs: now,
        updatedAtMs: now
      };
      draft.tasks[id] = task;
      if (params.context) {
        const parsed = parseDecisionContextBundle(params.context);
        validateDecisionContextForTask(parsed, task, session);
        draft.contexts[id] = parsed;
      }
      if (params.operationKey) {
        draft.operationReceipts[params.operationKey] = {
          schemaVersion: 1,
          operationKey: params.operationKey,
          kind: "create-review-task",
          sessionId,
          target: params.target,
          entityId: id,
          createdAtMs: now
        };
      }
      return task;
    });
  }
  getTask(id) {
    return this.store.getTask(id);
  }
  getTasksForSession(sessionId) {
    return this.store.getAllTasks().filter((t) => t.sessionId === sessionId);
  }
  getLatestReviewTask(sessionId) {
    const tasks = this.getTasksForSession(sessionId).filter((t) => t.kind === "review").sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
    return tasks[0] ?? null;
  }
  verifyReviewApproval(sessionId, target, requirements) {
    const latestPlan = this.store.getLatestPlanForSession(sessionId);
    if (latestPlan !== null) {
      if (latestPlan.status !== "completed") {
        return {
          approved: false,
          reason: `Session plan is not completed (status: ${latestPlan.status}, task: ${latestPlan.taskId})`,
          sessionId,
          headSha: target.headSha
        };
      }
      if (latestPlan.result?.verdict !== "ready") {
        return {
          approved: false,
          reason: `Session plan verdict is not ready (verdict: ${latestPlan.result?.verdict ?? "unknown"})`,
          sessionId,
          headSha: target.headSha
        };
      }
      if (latestPlan.publishedCommentId === null) {
        return {
          approved: false,
          reason: `Session plan is not published to GitHub`,
          sessionId,
          headSha: target.headSha
        };
      }
      if (!requirements) {
        return {
          approved: false,
          reason: "Current requirements not provided; cannot verify approval against the session plan",
          sessionId,
          headSha: target.headSha
        };
      }
      const curFp = computeRequirementFingerprint(
        requirements.title,
        requirements.body,
        // Clarifications are durable operator input from the plan; fall back to
        // the saved set when the caller only supplies GitHub Issue facts.
        requirements.clarifications ?? latestPlan.requirements.clarifications
      );
      if (curFp !== latestPlan.requirements.fingerprint) {
        return {
          approved: false,
          reason: `Requirements changed since plan was created`,
          sessionId,
          headSha: target.headSha
        };
      }
    }
    const tasks = this.getTasksForSession(sessionId).filter(
      (t) => t.kind === "review" && t.target.repository === target.repository && t.target.prNumber === target.prNumber && t.target.headSha === target.headSha
    ).sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
    const task = tasks[0];
    if (!task) {
      return {
        approved: false,
        reason: `No review task found for target PR #${target.prNumber} @ ${target.headSha}`,
        headSha: target.headSha,
        sessionId
      };
    }
    if (latestPlan !== null) {
      const reviewCtx = this.store.getContext(task.id);
      if (!reviewCtx || reviewCtx.strategy !== "materialized" || !reviewCtx.plan || reviewCtx.plan.taskId !== latestPlan.taskId || reviewCtx.plan.revision !== latestPlan.revision) {
        return {
          approved: false,
          reason: `Review was evaluated against plan revision ${reviewCtx && reviewCtx.strategy === "materialized" ? reviewCtx.plan?.revision ?? "none" : "none"}, but latest plan is revision ${latestPlan.revision} (${latestPlan.taskId})`,
          taskId: task.id,
          sessionId,
          headSha: target.headSha
        };
      }
    }
    if (task.status !== "completed") {
      return {
        approved: false,
        reason: `Review task ${task.id} is not completed (status: ${task.status})`,
        taskId: task.id,
        sessionId,
        headSha: target.headSha
      };
    }
    const result = this.store.getResult(task.id);
    if (!result) {
      return {
        approved: false,
        reason: `No result found for completed review task ${task.id}`,
        taskId: task.id,
        sessionId,
        headSha: target.headSha
      };
    }
    const approved = isDecisionReviewApproved(task, result, {
      sessionId,
      repository: target.repository,
      prNumber: target.prNumber,
      headSha: target.headSha
    });
    if (approved) {
      return {
        approved: true,
        reason: "Review approved",
        taskId: task.id,
        sessionId,
        headSha: target.headSha,
        verdict: "approve"
      };
    }
    const reviewResult = result.kind === "review" ? result : void 0;
    return {
      approved: false,
      reason: `Review is not approved (task status: ${task.status}, verdict: ${reviewResult?.verdict ?? "unknown"})`,
      taskId: task.id,
      sessionId,
      headSha: target.headSha,
      verdict: reviewResult?.verdict
    };
  }
  getResult(taskId) {
    return this.store.getResult(taskId);
  }
  getFailure(taskId) {
    return this.store.getFailure(taskId);
  }
  getReceipt(taskId) {
    return this.store.getReceipt(taskId);
  }
  getAllTasks() {
    return this.store.getAllTasks();
  }
  async putTaskContext(taskId, context) {
    const parsed = parseDecisionContextBundle(context);
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const session = draft.sessions[task.sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${task.sessionId}" not found`);
      validateDecisionContextForTask(parsed, task, session);
      draft.contexts[taskId] = parsed;
      return parsed;
    });
  }
  getTaskContext(taskId) {
    return this.store.getContext(taskId);
  }
  async getNextTask() {
    const candidates = this.store.getAllTasks().filter((t) => {
      if (t.status !== "pending") return false;
      const s = this.store.getSession(t.sessionId);
      return s !== null && (s.status === "active" || s.status === "broken-binding");
    }).sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      return a.id.localeCompare(b.id);
    });
    const next = candidates[0];
    if (!next) return null;
    const session = this.store.getSession(next.sessionId);
    return { task: next, session };
  }
  async claimTask(taskId, params) {
    if (!params.owner || params.owner.trim() === "") {
      throw new DecisionValidationError("Claim owner must be a nonempty string");
    }
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const session = draft.sessions[task.sessionId];
      if (!session) throw new DecisionNotFoundError(`Session "${task.sessionId}" not found`);
      if (session.status !== "active" && session.status !== "broken-binding") {
        throw new DecisionConflictError(`Cannot claim task for session in status "${session.status}"`);
      }
      const now = this.clock();
      for (const otherTask of Object.values(draft.tasks)) {
        if (otherTask.sessionId === task.sessionId && otherTask.id !== taskId && (otherTask.status === "claimed" || otherTask.status === "running") && otherTask.lease) {
          throw new DecisionConflictError(
            `Session "${task.sessionId}" already has an actively executing task "${otherTask.id}" under lease`
          );
        }
      }
      if (task.status !== "pending") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}" and cannot be claimed`);
      }
      const ttl = params.ttlMs ?? this.defaultClaimTtlMs;
      const expiresAtMs = now + ttl;
      const token = crypto__default.randomUUID();
      const lease = {
        owner: params.owner,
        token,
        generation: task.claimGeneration + 1,
        expiresAtMs
      };
      const updated = claimDecisionTask(task, lease, now);
      draft.tasks[taskId] = updated;
      if (!draft.claimBindingGenerations) {
        draft.claimBindingGenerations = {};
      }
      draft.claimBindingGenerations[taskId] = session.bindingGeneration;
      return { task: updated, session, lease };
    });
  }
  async startTask(taskId, params) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      if (task.status !== "claimed") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}", expected "claimed"`);
      }
      if (!task.lease || task.lease.owner !== params.owner || task.lease.token !== params.token || task.lease.generation !== params.generation) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }
      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== void 0 && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }
      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }
      const updated = startDecisionTask(task, task.lease, now);
      draft.tasks[taskId] = updated;
      return updated;
    });
  }
  async heartbeatTask(taskId, params) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      if (task.status !== "claimed" && task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" is in status "${task.status}", expected leased state`);
      }
      if (!task.lease || task.lease.owner !== params.owner || task.lease.token !== params.token || task.lease.generation !== params.generation) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }
      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== void 0 && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }
      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }
      const ttl = params.ttlMs ?? this.defaultClaimTtlMs;
      const newExpiry = now + ttl;
      const updated = heartbeatDecisionTask(task, task.lease, newExpiry, now);
      draft.tasks[taskId] = updated;
      return { expiresAtMs: newExpiry, ttlMs: ttl };
    });
  }
  async submitResult(taskId, params) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const receipt = draft.receipts[taskId];
      if (receipt) {
        if (receipt.type === "result" && receipt.claimOwner === params.owner && receipt.claimGeneration === params.generation && receipt.claimToken === params.token && canonicalJsonEqual(receipt.payload, params.result)) {
          return {
            receipt,
            result: receipt.payload,
            superseded: task.status === "superseded"
          };
        }
        throw new DecisionConflictError("Submission conflict: task already has a conflicting result or failure");
      }
      if (task.status === "superseded" || task.status === "cancelled") {
        throw new DecisionConflictError(`Cannot submit result for ${task.status} task`);
      }
      if (task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" must be in "running" state to complete`);
      }
      if (!task.lease || task.lease.owner !== params.owner || task.lease.token !== params.token || task.lease.generation !== params.generation) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }
      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== void 0 && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }
      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }
      validateDecisionResultForTask(task, params.result);
      const completed = completeDecisionTask(task, params.result, task.lease, now);
      draft.tasks[taskId] = completed;
      delete draft.claimBindingGenerations?.[taskId];
      draft.results[taskId] = params.result;
      if (task.kind === "plan" && params.result.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "completed",
            result: params.result,
            updatedAtMs: now
          };
        }
      }
      const newReceipt = {
        schemaVersion: 1,
        taskId,
        type: "result",
        claimGeneration: params.generation,
        claimOwner: params.owner,
        claimToken: params.token,
        acceptedAtMs: now,
        payload: params.result
      };
      draft.receipts[taskId] = newReceipt;
      return {
        receipt: newReceipt,
        result: params.result,
        superseded: false
      };
    });
  }
  async submitFailure(taskId, params) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const receipt = draft.receipts[taskId];
      if (receipt) {
        if (receipt.type === "failure" && receipt.claimOwner === params.owner && receipt.claimGeneration === params.generation && receipt.claimToken === params.token && receipt.payload.error === params.error && receipt.payload.retryable === (params.retryable ?? false) && canonicalJsonEqual(
          receipt.payload.details,
          params.details ?? null
        )) {
          return {
            receipt,
            failure: receipt.payload,
            superseded: task.status === "superseded"
          };
        }
        throw new DecisionConflictError("Submission conflict: task already has a conflicting result or failure");
      }
      if (task.status === "superseded" || task.status === "cancelled") {
        throw new DecisionConflictError(`Cannot fail ${task.status} task`);
      }
      if (task.status !== "claimed" && task.status !== "running") {
        throw new DecisionConflictError(`Task "${taskId}" is not in claimed or running state`);
      }
      if (!task.lease || task.lease.owner !== params.owner || task.lease.token !== params.token || task.lease.generation !== params.generation) {
        throw new DecisionConflictError("Stale or invalid claim credentials");
      }
      const session = draft.sessions[task.sessionId];
      const claimBindingGen = draft.claimBindingGenerations?.[taskId];
      if (session && claimBindingGen !== void 0 && session.bindingGeneration !== claimBindingGen) {
        throw new DecisionConflictError(
          `Task claim belongs to stale binding generation ${claimBindingGen}, but session is at generation ${session.bindingGeneration}`
        );
      }
      const now = this.clock();
      if (now >= task.lease.expiresAtMs) {
        throw new DecisionConflictError("Claim lease has already expired");
      }
      const failed = failDecisionTask(task, task.lease, now);
      draft.tasks[taskId] = failed;
      delete draft.claimBindingGenerations?.[taskId];
      const failure = {
        schemaVersion: 1,
        taskId,
        sessionId: task.sessionId,
        revision: task.revision,
        error: params.error,
        details: params.details ?? null,
        retryable: params.retryable ?? false,
        createdAtMs: now
      };
      draft.failures[taskId] = failure;
      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "failed",
            updatedAtMs: now
          };
        }
      }
      const newReceipt = {
        schemaVersion: 1,
        taskId,
        type: "failure",
        claimGeneration: params.generation,
        claimOwner: params.owner,
        claimToken: params.token,
        acceptedAtMs: now,
        payload: failure
      };
      draft.receipts[taskId] = newReceipt;
      return {
        receipt: newReceipt,
        failure,
        superseded: false
      };
    });
  }
  async cancelTask(taskId) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const now = this.clock();
      const updated = cancelDecisionTask(task, now);
      draft.tasks[taskId] = updated;
      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "superseded",
            updatedAtMs: now
          };
        }
      }
      return updated;
    });
  }
  async supersedeTask(taskId) {
    return await this.store.transaction((draft) => {
      const task = draft.tasks[taskId];
      if (!task) throw new DecisionNotFoundError(`Task "${taskId}" not found`);
      const now = this.clock();
      const updated = supersedeDecisionTask(task, now);
      draft.tasks[taskId] = updated;
      if (task.kind === "plan") {
        const planRecord = draft.plans[taskId];
        if (planRecord) {
          draft.plans[taskId] = {
            ...planRecord,
            status: "superseded",
            updatedAtMs: now
          };
        }
      }
      return updated;
    });
  }
  getPlan(taskId) {
    return this.store.getPlan(taskId);
  }
  getLatestPlan(sessionId) {
    return this.store.getLatestPlanForSession(sessionId);
  }
  getLatestPlanForSession(sessionId) {
    return this.store.getLatestPlanForSession(sessionId);
  }
  getAllPlans() {
    return this.store.getAllPlans();
  }
  async markPlanPublished(taskId, published = {}) {
    if (published.commentId === void 0 || published.commentId === null || typeof published.commentId !== "number" && typeof published.commentId !== "string" || typeof published.commentId === "string" && published.commentId.trim() === "" || typeof published.commentId === "number" && (!Number.isFinite(published.commentId) || published.commentId <= 0)) {
      throw new DecisionValidationError("markPlanPublished requires valid non-empty commentId");
    }
    return await this.store.transaction((draft) => {
      const planRecord = draft.plans[taskId];
      if (!planRecord) {
        throw new DecisionNotFoundError(`Plan record for task "${taskId}" not found`);
      }
      const now = this.clock();
      const updated = {
        ...planRecord,
        publishedCommentId: published.commentId ?? null,
        publishedAtMs: published.publishedAtMs !== void 0 ? published.publishedAtMs : now,
        updatedAtMs: now
      };
      draft.plans[taskId] = updated;
      return updated;
    });
  }
  verifyPlanEligibility(sessionId, requirements) {
    const planRecord = this.store.getLatestPlanForSession(sessionId);
    if (!planRecord) {
      return {
        eligible: false,
        sessionId,
        reason: "no_plan"
      };
    }
    if (planRecord.status !== "completed") {
      return {
        eligible: false,
        sessionId,
        reason: `plan_status_${planRecord.status}`
      };
    }
    const result = planRecord.result;
    if (!result || result.kind !== "plan") {
      return {
        eligible: false,
        sessionId,
        reason: "no_plan_result"
      };
    }
    if (result.verdict !== "ready") {
      return {
        eligible: false,
        sessionId,
        reason: `verdict_${result.verdict}`,
        verdict: result.verdict
      };
    }
    if (result.content.clarifications && result.content.clarifications.length > 0) {
      return {
        eligible: false,
        sessionId,
        reason: "unresolved_clarifications",
        verdict: "ready"
      };
    }
    if (requirements) {
      const clarifications = requirements.clarifications ?? planRecord.requirements.clarifications;
      const currentFingerprint = computeRequirementFingerprint(
        requirements.title,
        requirements.body,
        clarifications
      );
      if (currentFingerprint !== planRecord.requirements.fingerprint) {
        return {
          eligible: false,
          sessionId,
          reason: "requirements_changed",
          verdict: "ready",
          fingerprint: planRecord.requirements.fingerprint
        };
      }
    }
    if (planRecord.publishedCommentId === null) {
      return {
        eligible: false,
        sessionId,
        reason: "plan_not_published_to_github",
        verdict: "ready"
      };
    }
    return {
      eligible: true,
      sessionId,
      verdict: "ready",
      fingerprint: planRecord.requirements.fingerprint,
      publishedCommentId: planRecord.publishedCommentId,
      plan: {
        taskId: planRecord.taskId,
        revision: planRecord.revision,
        plan: result.content.plan,
        acceptanceCriteria: result.content.acceptanceCriteria,
        risks: result.content.risks,
        clarifications: result.content.clarifications
      }
    };
  }
}
class StoreLock {
  lockPath;
  reclaimLockPath;
  storeDir;
  acquired = false;
  currentNonce = null;
  exitHandler = null;
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.lockPath = path.join(storeDir, "store.lock");
    this.reclaimLockPath = path.join(storeDir, "store.reclaim.lock");
  }
  isAcquired() {
    return this.acquired;
  }
  async acquire() {
    if (this.acquired) {
      return;
    }
    await fs.mkdir(this.storeDir, { recursive: true });
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const myNonce = crypto.randomUUID();
      const metadata = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
        nonce: myNonce
      };
      try {
        const handle = await fs.open(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.acquired = true;
        this.currentNonce = myNonce;
        this.installExitHandler();
        return;
      } catch (error) {
        const nodeError = error;
        if (nodeError.code !== "EEXIST") {
          throw new DecisionStoreLockError(
            `Failed to acquire lock for store directory "${this.storeDir}": ${nodeError.message}`
          );
        }
        const staleMeta = await this.inspectExistingLock();
        if (staleMeta && attempt < maxAttempts) {
          const reclaimed = await this.reclaimStaleLock(staleMeta, myNonce);
          if (reclaimed) {
            this.acquired = true;
            this.currentNonce = myNonce;
            this.installExitHandler();
            return;
          }
        }
        if (attempt < maxAttempts) {
          const jitter = 10 + Math.floor(Math.random() * 20);
          await new Promise((r) => setTimeout(r, jitter));
          continue;
        }
        throw new DecisionStoreLockError(
          `Store directory "${this.storeDir}" is currently locked by another process. Only one active writer is permitted. Remove "${this.lockPath}" only if the owning process is no longer running.`
        );
      }
    }
  }
  async acquireReclaimMutex(reclaimNonce) {
    const reclaimMeta = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAtMs: Date.now(),
      nonce: reclaimNonce
    };
    try {
      const handle = await fs.open(this.reclaimLockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(reclaimMeta, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      const nodeError = err;
      if (nodeError.code !== "EEXIST") {
        return false;
      }
    }
    const existing = await this.readReclaimMetadata();
    if (!existing) {
      return false;
    }
    if (existing.hostname !== os.hostname() || typeof existing.pid !== "number") {
      return false;
    }
    try {
      process.kill(existing.pid, 0);
      return false;
    } catch (killErr) {
      const kErr = killErr;
      if (kErr.code !== "ESRCH") {
        return false;
      }
    }
    return await this.atomicRetireAndReplace(this.reclaimLockPath, existing, reclaimMeta);
  }
  async atomicRetireAndReplace(targetPath, expected, newMeta) {
    const tombstone = `${targetPath}.retired.${expected.pid}.${expected.acquiredAtMs}.${expected.nonce || "0"}`;
    const reclaimAuthDir = `${tombstone}.reclaim-auth`;
    const authNonce = crypto.randomUUID();
    try {
      await fs.link(targetPath, tombstone);
    } catch (err) {
      const nodeErr = err;
      if (nodeErr.code !== "EEXIST") {
        return false;
      }
    }
    const gotAuth = await this.acquireDirectoryMutex(reclaimAuthDir, authNonce);
    if (!gotAuth) {
      return false;
    }
    try {
      const legacyTakeover = `${tombstone}.takeover`;
      await fs.unlink(legacyTakeover).catch(() => {
      });
      const stLock = await fs.stat(targetPath).catch(() => null);
      const stTomb = await fs.stat(tombstone).catch(() => null);
      if (!stLock || !stTomb || stLock.ino !== stTomb.ino) {
        return false;
      }
      const tombContent = await fs.readFile(tombstone, "utf8").catch(() => null);
      if (!tombContent) {
        return false;
      }
      try {
        const tombMeta = JSON.parse(tombContent);
        if (tombMeta.pid !== expected.pid || tombMeta.hostname !== expected.hostname || tombMeta.acquiredAtMs !== expected.acquiredAtMs) {
          return false;
        }
      } catch {
        return false;
      }
      await fs.unlink(targetPath).catch(() => {
      });
      try {
        const handle = await fs.open(targetPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(newMeta, null, 2), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      } catch {
        return false;
      }
    } finally {
      await this.releaseDirectoryMutex(reclaimAuthDir, authNonce);
    }
  }
  async acquireDirectoryMutex(mutexDir, nonce) {
    const claimMeta = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAtMs: Date.now(),
      nonce
    };
    try {
      await fs.mkdir(mutexDir);
      await fs.writeFile(path.join(mutexDir, "claim.json"), JSON.stringify(claimMeta, null, 2), "utf8");
      return true;
    } catch (err) {
      const nodeErr = err;
      if (nodeErr.code !== "EEXIST") {
        return false;
      }
    }
    const claimFile = path.join(mutexDir, "claim.json");
    const content = await fs.readFile(claimFile, "utf8").catch(() => null);
    if (!content) {
      return false;
    }
    try {
      const existing = JSON.parse(content);
      if (existing.hostname !== os.hostname() || typeof existing.pid !== "number") {
        return false;
      }
      try {
        process.kill(existing.pid, 0);
        return false;
      } catch (killErr) {
        if (killErr.code !== "ESRCH") {
          return false;
        }
      }
      const retiredDir = `${mutexDir}.retired.${existing.pid}.${existing.nonce || "0"}`;
      try {
        await fs.rename(mutexDir, retiredDir);
      } catch {
        return false;
      }
      try {
        await fs.mkdir(mutexDir);
        await fs.writeFile(path.join(mutexDir, "claim.json"), JSON.stringify(claimMeta, null, 2), "utf8");
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }
  async releaseDirectoryMutex(mutexDir, nonce) {
    try {
      const claimFile = path.join(mutexDir, "claim.json");
      const content = await fs.readFile(claimFile, "utf8").catch(() => null);
      if (content) {
        const meta = JSON.parse(content);
        if (meta.pid === process.pid && meta.hostname === os.hostname() && meta.nonce === nonce) {
          await fs.rm(mutexDir, { recursive: true, force: true }).catch(() => {
          });
        }
      }
    } catch {
    }
  }
  async reclaimStaleLock(expected, lockNonce) {
    const reclaimNonce = crypto.randomUUID();
    const gotMutex = await this.acquireReclaimMutex(reclaimNonce);
    if (!gotMutex) {
      return false;
    }
    try {
      const current = await this.readLockMetadata();
      if (!current || current.pid !== expected.pid || current.hostname !== expected.hostname || current.acquiredAtMs !== expected.acquiredAtMs) {
        return false;
      }
      try {
        process.kill(current.pid, 0);
        return false;
      } catch (kErr) {
        if (kErr.code !== "ESRCH") {
          return false;
        }
      }
      const myMainMeta = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
        nonce: lockNonce
      };
      return await this.atomicRetireAndReplace(this.lockPath, current, myMainMeta);
    } finally {
      try {
        const check = await this.readReclaimMetadata();
        if (check && check.pid === process.pid && check.hostname === os.hostname() && check.nonce === reclaimNonce) {
          await fs.unlink(this.reclaimLockPath).catch(() => {
          });
        }
      } catch {
      }
    }
  }
  async readLockMetadata() {
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  async readReclaimMetadata() {
    try {
      const content = await fs.readFile(this.reclaimLockPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  async inspectExistingLock() {
    try {
      const metadata = await this.readLockMetadata();
      if (!metadata) return null;
      if (metadata.hostname === os.hostname() && typeof metadata.pid === "number") {
        try {
          process.kill(metadata.pid, 0);
          return null;
        } catch (killError) {
          const err = killError;
          if (err.code === "ESRCH") {
            return metadata;
          }
          return null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  async release() {
    if (!this.acquired) {
      return;
    }
    this.removeExitHandler();
    this.acquired = false;
    try {
      const metadata = await this.readLockMetadata();
      if (metadata && metadata.pid === process.pid && metadata.hostname === os.hostname() && (this.currentNonce ? metadata.nonce === this.currentNonce : true)) {
        await fs.unlink(this.lockPath).catch(() => {
        });
      }
    } catch {
    }
  }
  installExitHandler() {
    if (this.exitHandler) return;
    this.exitHandler = () => {
      if (this.acquired) {
        try {
          if (fsSync.existsSync(this.lockPath)) {
            const content = fsSync.readFileSync(this.lockPath, "utf8");
            const meta = JSON.parse(content);
            if (meta.pid === process.pid && meta.hostname === os.hostname() && (this.currentNonce ? meta.nonce === this.currentNonce : true)) {
              fsSync.unlinkSync(this.lockPath);
            }
          }
        } catch {
        }
      }
    };
    process.once("exit", this.exitHandler);
  }
  removeExitHandler() {
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
  }
}
const DECISION_STORE_SCHEMA_VERSION = 1;
function validateDecisionTaskFailure(value) {
  if (typeof value !== "object" || value === null) {
    throw new DecisionValidationError("Expected task failure object");
  }
  const f = value;
  if (f["schemaVersion"] !== 1) {
    throw new DecisionValidationError("Invalid failure schemaVersion");
  }
  if (typeof f["taskId"] !== "string" || f["taskId"].trim() === "") {
    throw new DecisionValidationError("Invalid failure taskId");
  }
  if (typeof f["sessionId"] !== "string" || f["sessionId"].trim() === "") {
    throw new DecisionValidationError("Invalid failure sessionId");
  }
  if (typeof f["revision"] !== "number" || !Number.isSafeInteger(f["revision"]) || f["revision"] < 1) {
    throw new DecisionValidationError("Invalid failure revision");
  }
  if (typeof f["error"] !== "string" || f["error"].trim() === "") {
    throw new DecisionValidationError("Invalid failure error message");
  }
  if (typeof f["retryable"] !== "boolean") {
    throw new DecisionValidationError("Invalid failure retryable flag");
  }
  if (typeof f["createdAtMs"] !== "number" || !Number.isSafeInteger(f["createdAtMs"])) {
    throw new DecisionValidationError("Invalid failure createdAtMs");
  }
  return value;
}
function validateSubmissionReceipt(value) {
  if (typeof value !== "object" || value === null) {
    throw new DecisionValidationError("Expected submission receipt object");
  }
  const r = value;
  if (r["schemaVersion"] !== 1) {
    throw new DecisionValidationError("Invalid receipt schemaVersion");
  }
  if (typeof r["taskId"] !== "string" || r["taskId"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt taskId");
  }
  if (r["type"] !== "result" && r["type"] !== "failure") {
    throw new DecisionValidationError("Invalid receipt type");
  }
  if (typeof r["claimGeneration"] !== "number" || r["claimGeneration"] < 1) {
    throw new DecisionValidationError("Invalid receipt claimGeneration");
  }
  if (typeof r["claimOwner"] !== "string" || r["claimOwner"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt claimOwner");
  }
  if (typeof r["claimToken"] !== "string" || r["claimToken"].trim() === "") {
    throw new DecisionValidationError("Invalid receipt claimToken");
  }
  if (typeof r["acceptedAtMs"] !== "number" || !Number.isSafeInteger(r["acceptedAtMs"])) {
    throw new DecisionValidationError("Invalid receipt acceptedAtMs");
  }
  if (r["type"] === "result") {
    parseDecisionResult(r["payload"]);
  } else {
    validateDecisionTaskFailure(r["payload"]);
  }
  return value;
}
function validateDecisionPlanRecord(value) {
  if (typeof value !== "object" || value === null) {
    throw new DecisionValidationError("Expected plan record object");
  }
  const p = value;
  if (p["schemaVersion"] !== 1) {
    throw new DecisionValidationError("Invalid plan record schemaVersion");
  }
  if (typeof p["sessionId"] !== "string" || p["sessionId"].trim() === "") {
    throw new DecisionValidationError("Invalid plan record sessionId");
  }
  if (typeof p["taskId"] !== "string" || p["taskId"].trim() === "") {
    throw new DecisionValidationError("Invalid plan record taskId");
  }
  if (typeof p["revision"] !== "number" || !Number.isSafeInteger(p["revision"]) || p["revision"] < 1) {
    throw new DecisionValidationError("Invalid plan record revision");
  }
  if (!["initial", "requirements_changed", "clarification", "retry"].includes(p["triggerKind"])) {
    throw new DecisionValidationError("Invalid plan record triggerKind");
  }
  if (typeof p["requirements"] !== "object" || p["requirements"] === null) {
    throw new DecisionValidationError("Invalid plan record requirements");
  }
  const req = p["requirements"];
  if (typeof req["title"] !== "string") {
    throw new DecisionValidationError("Invalid plan record requirements title");
  }
  if (typeof req["body"] !== "string") {
    throw new DecisionValidationError("Invalid plan record requirements body");
  }
  if (!Array.isArray(req["clarifications"])) {
    throw new DecisionValidationError("Invalid plan record requirements clarifications");
  }
  if (typeof req["fingerprint"] !== "string" || req["fingerprint"].trim() === "") {
    throw new DecisionValidationError("Invalid plan record requirements fingerprint");
  }
  if (p["previousTaskId"] !== null && typeof p["previousTaskId"] !== "string") {
    throw new DecisionValidationError("Invalid plan record previousTaskId");
  }
  if (!["pending", "running", "completed", "failed", "superseded"].includes(p["status"])) {
    throw new DecisionValidationError("Invalid plan record status");
  }
  if (p["result"] !== null) {
    const res = parseDecisionResult(p["result"]);
    if (res.kind !== "plan") {
      throw new DecisionValidationError("Plan record result must be a plan result");
    }
  }
  if (p["publishedCommentId"] !== null && typeof p["publishedCommentId"] !== "string" && typeof p["publishedCommentId"] !== "number") {
    throw new DecisionValidationError("Invalid plan record publishedCommentId");
  }
  if (p["publishedAtMs"] !== null && (!Number.isSafeInteger(p["publishedAtMs"]) || p["publishedAtMs"] < 0)) {
    throw new DecisionValidationError("Invalid plan record publishedAtMs");
  }
  if (!Number.isSafeInteger(p["createdAtMs"]) || p["createdAtMs"] < 0) {
    throw new DecisionValidationError("Invalid plan record createdAtMs");
  }
  if (!Number.isSafeInteger(p["updatedAtMs"]) || p["updatedAtMs"] < 0) {
    throw new DecisionValidationError("Invalid plan record updatedAtMs");
  }
  return value;
}
function validateStoreRecord(record2) {
  if (typeof record2 !== "object" || record2 === null) {
    throw new CorruptedStoreError("Expected store record object");
  }
  if (record2.schemaVersion !== DECISION_STORE_SCHEMA_VERSION) {
    throw new UnsupportedStoreVersionError(record2.schemaVersion);
  }
  if (typeof record2.transactionSequence !== "number" || record2.transactionSequence < 0) {
    throw new CorruptedStoreError("Invalid transaction sequence");
  }
  if (typeof record2.sessions !== "object" || record2.sessions === null) {
    throw new CorruptedStoreError("sessions table must be an object");
  }
  if (typeof record2.tasks !== "object" || record2.tasks === null) {
    throw new CorruptedStoreError("tasks table must be an object");
  }
  if (typeof record2.results !== "object" || record2.results === null) {
    throw new CorruptedStoreError("results table must be an object");
  }
  if (typeof record2.failures !== "object" || record2.failures === null) {
    throw new CorruptedStoreError("failures table must be an object");
  }
  if (typeof record2.receipts !== "object" || record2.receipts === null) {
    throw new CorruptedStoreError("receipts table must be an object");
  }
  if (typeof record2.revisions !== "object" || record2.revisions === null) {
    throw new CorruptedStoreError("revisions table must be an object");
  }
  if (typeof record2.operationReceipts !== "object" || record2.operationReceipts === null) {
    throw new CorruptedStoreError("operationReceipts table must be an object");
  }
  if (record2.claimBindingGenerations !== void 0) {
    if (typeof record2.claimBindingGenerations !== "object" || record2.claimBindingGenerations === null) {
      throw new CorruptedStoreError("claimBindingGenerations table must be an object");
    }
    for (const [key, gen] of Object.entries(record2.claimBindingGenerations)) {
      if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0) {
        throw new CorruptedStoreError(`Invalid binding generation for task "${key}"`);
      }
    }
  }
  for (const [key, session] of Object.entries(record2.sessions)) {
    if (key !== session.id) {
      throw new CorruptedStoreError(`Session key "${key}" does not match session id "${session.id}"`);
    }
    parseDecisionSession(session);
  }
  for (const [key, task] of Object.entries(record2.tasks)) {
    if (key !== task.id) {
      throw new CorruptedStoreError(`Task key "${key}" does not match task id "${task.id}"`);
    }
    parseDecisionTask(task);
    if (!record2.sessions[task.sessionId]) {
      throw new CorruptedStoreError(`Task ${task.id} references non-existent session ${task.sessionId}`);
    }
  }
  for (const [revKey, revVal] of Object.entries(record2.revisions)) {
    if (typeof revVal !== "number" || !Number.isSafeInteger(revVal) || revVal < 0) {
      throw new CorruptedStoreError(`Invalid revision value for key "${revKey}"`);
    }
  }
  for (const task of Object.values(record2.tasks)) {
    const revKey = task.kind === "plan" ? `plan:${task.sessionId}` : `review:${task.sessionId}:${task.target.repository}:${task.target.prNumber}`;
    const storedRev = record2.revisions[revKey];
    if (storedRev === void 0 || storedRev < task.revision) {
      throw new CorruptedStoreError(
        `Task "${task.id}" has revision ${task.revision} but store revision index has ${storedRev ?? "undefined"}`
      );
    }
  }
  for (const [key, result] of Object.entries(record2.results)) {
    if (key !== result.taskId) {
      throw new CorruptedStoreError(`Result key "${key}" does not match result.taskId "${result.taskId}"`);
    }
    parseDecisionResult(result);
    const task = record2.tasks[result.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Result ${result.taskId} references non-existent task`);
    }
    if (task.sessionId !== result.sessionId) {
      throw new CorruptedStoreError(`Result ${result.taskId} sessionId does not match task sessionId`);
    }
    if (task.revision !== result.revision) {
      throw new CorruptedStoreError(`Result ${result.taskId} revision does not match task revision`);
    }
    if (task.kind !== result.kind) {
      throw new CorruptedStoreError(`Result ${result.taskId} kind does not match task kind`);
    }
    if (task.kind === "review" && result.kind === "review") {
      if (!canonicalJsonEqual(task.target, result.target)) {
        throw new CorruptedStoreError(`Result ${result.taskId} review target does not match task target`);
      }
    }
    if (task.status !== "completed" && task.status !== "superseded") {
      throw new CorruptedStoreError(`Result exists for task ${task.id} which is in status "${task.status}"`);
    }
  }
  for (const [key, failure] of Object.entries(record2.failures)) {
    if (key !== failure.taskId) {
      throw new CorruptedStoreError(`Failure key "${key}" does not match failure.taskId "${failure.taskId}"`);
    }
    validateDecisionTaskFailure(failure);
    const task = record2.tasks[failure.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} references non-existent task`);
    }
    if (task.sessionId !== failure.sessionId) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} sessionId does not match task sessionId`);
    }
    if (task.revision !== failure.revision) {
      throw new CorruptedStoreError(`Failure ${failure.taskId} revision does not match task revision`);
    }
    if (task.status !== "failed" && task.status !== "superseded") {
      throw new CorruptedStoreError(`Failure exists for task ${task.id} which is in status "${task.status}"`);
    }
  }
  for (const [key, receipt] of Object.entries(record2.receipts)) {
    if (key !== receipt.taskId) {
      throw new CorruptedStoreError(`Receipt key "${key}" does not match receipt.taskId "${receipt.taskId}"`);
    }
    validateSubmissionReceipt(receipt);
    const task = record2.tasks[receipt.taskId];
    if (!task) {
      throw new CorruptedStoreError(`Receipt ${receipt.taskId} references non-existent task`);
    }
    if (receipt.claimGeneration !== task.claimGeneration) {
      throw new CorruptedStoreError(
        `Receipt ${receipt.taskId} claimGeneration ${receipt.claimGeneration} does not match task claimGeneration ${task.claimGeneration}`
      );
    }
    if (receipt.claimToken !== task.lastClaimToken) {
      throw new CorruptedStoreError(
        `Receipt ${receipt.taskId} claimToken does not match task lastClaimToken`
      );
    }
    if (receipt.type === "result") {
      const res = record2.results[key];
      if (!res || !canonicalJsonEqual(res, receipt.payload)) {
        throw new CorruptedStoreError(`Receipt ${key} payload does not match stored result`);
      }
    } else {
      const fail = record2.failures[key];
      if (!fail || !canonicalJsonEqual(fail, receipt.payload)) {
        throw new CorruptedStoreError(`Receipt ${key} payload does not match stored failure`);
      }
    }
  }
  for (const task of Object.values(record2.tasks)) {
    if (task.status === "completed") {
      if (!record2.results[task.id] || !record2.receipts[task.id]) {
        throw new CorruptedStoreError(`Completed task ${task.id} has no persisted result or receipt`);
      }
    } else if (task.status === "failed") {
      if (!record2.failures[task.id] || !record2.receipts[task.id]) {
        throw new CorruptedStoreError(`Failed task ${task.id} has no persisted failure or receipt`);
      }
    } else if (task.status === "pending" || task.status === "claimed" || task.status === "running" || task.status === "cancelled") {
      if (record2.results[task.id] || record2.failures[task.id]) {
        throw new CorruptedStoreError(`Non-terminal task ${task.id} has unexpected result or failure`);
      }
    }
  }
  for (const [key, op] of Object.entries(record2.operationReceipts)) {
    if (key !== op.operationKey) {
      throw new CorruptedStoreError(
        `Operation receipt key "${key}" does not match operationKey "${op.operationKey}"`
      );
    }
    if (op.schemaVersion !== 1) {
      throw new CorruptedStoreError("Invalid operation receipt schemaVersion");
    }
    if (!record2.sessions[op.sessionId]) {
      throw new CorruptedStoreError(`Operation receipt references non-existent session ${op.sessionId}`);
    }
    if (op.kind === "create-plan-task") {
      const t = record2.tasks[op.entityId];
      if (!t) {
        throw new CorruptedStoreError(`Operation receipt references non-existent task ${op.entityId}`);
      }
      if (t.sessionId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt task sessionId does not match receipt sessionId`);
      }
      if (t.kind !== "plan") {
        throw new CorruptedStoreError(
          `Operation receipt kind is create-plan-task but task ${t.id} kind is "${t.kind}"`
        );
      }
      if (op.target !== void 0 && op.target !== null) {
        throw new CorruptedStoreError(`Operation receipt kind is create-plan-task but target is specified`);
      }
    } else if (op.kind === "create-review-task") {
      const t = record2.tasks[op.entityId];
      if (!t) {
        throw new CorruptedStoreError(`Operation receipt references non-existent task ${op.entityId}`);
      }
      if (t.sessionId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt task sessionId does not match receipt sessionId`);
      }
      if (t.kind !== "review") {
        throw new CorruptedStoreError(
          `Operation receipt kind is create-review-task but task ${t.id} kind is "${t.kind}"`
        );
      }
      if (!op.target) {
        throw new CorruptedStoreError(`Operation receipt kind is create-review-task but has no target`);
      }
      parseDecisionReviewTarget(op.target);
      if (!canonicalJsonEqual(op.target, t.target)) {
        throw new CorruptedStoreError(
          `Operation receipt ${op.operationKey} target does not match task ${t.id} target`
        );
      }
    } else if (op.kind === "rebind-session") {
      if (op.entityId !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt entityId does not match sessionId`);
      }
      const s = record2.sessions[op.entityId];
      if (!s) {
        throw new CorruptedStoreError(`Operation receipt references non-existent session ${op.entityId}`);
      }
      if (typeof op.adapter !== "string" || op.adapter.trim().length === 0) {
        throw new CorruptedStoreError(`Operation receipt missing or invalid adapter`);
      }
      if (typeof op.externalSessionRef !== "string" || op.externalSessionRef.trim().length === 0) {
        throw new CorruptedStoreError(`Operation receipt missing or invalid externalSessionRef`);
      }
      if (op.resumeUri !== null && typeof op.resumeUri !== "string") {
        throw new CorruptedStoreError(`Operation receipt invalid resumeUri`);
      }
      if (typeof op.expectedGeneration !== "number" || !Number.isSafeInteger(op.expectedGeneration) || op.expectedGeneration < 0) {
        throw new CorruptedStoreError(`Operation receipt missing or invalid expectedGeneration`);
      }
      if (typeof op.bindingGeneration !== "number" || !Number.isSafeInteger(op.bindingGeneration)) {
        throw new CorruptedStoreError(`Operation receipt missing or invalid bindingGeneration`);
      }
      if (op.bindingGeneration !== op.expectedGeneration + 1) {
        throw new CorruptedStoreError(
          `Operation receipt bindingGeneration must equal expectedGeneration + 1`
        );
      }
      if (!op.resultingSession) {
        throw new CorruptedStoreError(`Operation receipt missing resultingSession`);
      }
      parseDecisionSession(op.resultingSession);
      if (op.resultingSession.id !== op.sessionId) {
        throw new CorruptedStoreError(`Operation receipt resultingSession id does not match sessionId`);
      }
      if (op.resultingSession.bindingGeneration !== op.bindingGeneration) {
        throw new CorruptedStoreError(
          `Operation receipt resultingSession bindingGeneration does not match bindingGeneration`
        );
      }
      if (!op.resultingSession.binding) {
        throw new CorruptedStoreError(`Operation receipt resultingSession has no binding`);
      }
      if (op.resultingSession.binding.adapter !== op.adapter || op.resultingSession.binding.externalSessionRef !== op.externalSessionRef || op.resultingSession.binding.resumeUri !== op.resumeUri || op.resultingSession.binding.generation !== op.bindingGeneration) {
        throw new CorruptedStoreError(
          `Operation receipt resultingSession binding does not match receipt fields`
        );
      }
    } else {
      const unknownKind = op.kind;
      throw new CorruptedStoreError(
        `Unknown operation receipt kind: ${String(unknownKind)}`
      );
    }
  }
  if (record2.contexts !== void 0) {
    if (typeof record2.contexts !== "object" || record2.contexts === null) {
      throw new CorruptedStoreError("contexts table must be an object if present");
    }
    for (const [key, ctx] of Object.entries(record2.contexts)) {
      const task = record2.tasks[key];
      if (!task) {
        throw new CorruptedStoreError(`Context ${key} references non-existent task`);
      }
      const session = record2.sessions[task.sessionId];
      if (!session) {
        throw new CorruptedStoreError(`Task for context ${key} references non-existent session ${task.sessionId}`);
      }
      const parsedCtx = parseDecisionContextBundle(ctx);
      validateDecisionContextForTask(parsedCtx, task, session);
    }
  }
  if (record2.plans !== void 0) {
    if (typeof record2.plans !== "object" || record2.plans === null) {
      throw new CorruptedStoreError("plans table must be an object if present");
    }
    for (const [key, plan] of Object.entries(record2.plans)) {
      if (key !== plan.taskId) {
        throw new CorruptedStoreError(`Plan key "${key}" does not match plan taskId "${plan.taskId}"`);
      }
      validateDecisionPlanRecord(plan);
      if (!record2.sessions[plan.sessionId]) {
        throw new CorruptedStoreError(`Plan ${key} references non-existent session ${plan.sessionId}`);
      }
      if (!record2.tasks[plan.taskId]) {
        throw new CorruptedStoreError(`Plan ${key} references non-existent task ${plan.taskId}`);
      }
    }
  }
}
function createEmptyStoreRecord() {
  return {
    schemaVersion: DECISION_STORE_SCHEMA_VERSION,
    transactionSequence: 0,
    sessions: {},
    tasks: {},
    results: {},
    failures: {},
    receipts: {},
    revisions: {},
    operationReceipts: {},
    contexts: {},
    plans: {},
    claimBindingGenerations: {}
  };
}
class DurableDecisionStore {
  storeDir;
  storePath;
  lock;
  state = createEmptyStoreRecord();
  poisoned = false;
  observationAvailable = false;
  poisonReason = null;
  transactionQueue = Promise.resolve();
  constructor(config) {
    this.storeDir = path.resolve(config.storeDir);
    this.storePath = path.join(this.storeDir, "store.json");
    this.lock = new StoreLock(this.storeDir);
  }
  isPoisoned() {
    return this.poisoned;
  }
  async open() {
    await this.lock.acquire();
    await fs.mkdir(this.storeDir, { recursive: true });
    let content = null;
    try {
      content = await fs.readFile(this.storePath, "utf8");
    } catch (err) {
      const nodeErr = err;
      if (nodeErr.code === "ENOENT") {
        this.state = createEmptyStoreRecord();
        await this.persistDirect(this.state);
        this.observationAvailable = true;
        return;
      }
      throw err;
    }
    let raw;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new CorruptedStoreError(`Store file "${this.storePath}" contains invalid JSON`);
    }
    if (typeof raw !== "object" || raw === null) {
      throw new CorruptedStoreError(`Store file "${this.storePath}" does not contain a JSON object`);
    }
    const candidate = raw;
    try {
      validateStoreRecord(candidate);
    } catch (valErr) {
      if (valErr instanceof UnsupportedStoreVersionError) {
        throw valErr;
      }
      throw new CorruptedStoreError(`Store file validation failed: ${valErr.message}`);
    }
    const claimBindingGens = candidate.claimBindingGenerations ? { ...candidate.claimBindingGenerations } : {};
    const tasks = { ...candidate.tasks };
    if (!candidate.claimBindingGenerations) {
      for (const [id, task] of Object.entries(tasks)) {
        if (task.status === "claimed" || task.status === "running") {
          tasks[id] = releaseDecisionTaskForBindingInvalidation(task, task.updatedAtMs);
        }
      }
    }
    this.state = {
      ...candidate,
      tasks,
      contexts: candidate.contexts ?? {},
      plans: candidate.plans ?? {},
      claimBindingGenerations: claimBindingGens
    };
    this.observationAvailable = true;
  }
  async close() {
    this.observationAvailable = false;
    await this.transactionQueue.catch(() => {
    });
    await this.lock.release();
  }
  /** Single synchronous committed-state observation; no expiry cleanup or transactions. */
  observeWork(workKey) {
    if (!this.observationAvailable || this.poisoned) throw new StorePoisonedError("Store unavailable");
    const sessionId = decisionSessionId(workKey);
    const session = this.state.sessions[sessionId];
    const tasks = Object.values(this.state.tasks).filter((task) => task.sessionId === sessionId).map((task) => {
      const base = {
        taskId: task.id,
        revision: task.revision,
        status: task.status,
        createdAtMs: task.createdAtMs,
        updatedAtMs: task.updatedAtMs,
        claimGeneration: task.claimGeneration,
        claimBindingGeneration: this.state.claimBindingGenerations?.[task.id] ?? null,
        lease: task.lease === null ? null : {
          owner: task.lease.owner,
          generation: task.lease.generation,
          expiresAtMs: task.lease.expiresAtMs
        }
      };
      return task.kind === "plan" ? { ...base, kind: "plan" } : {
        ...base,
        kind: "review",
        target: { ...task.target }
      };
    });
    const results = Object.values(this.state.results).filter((result) => result.sessionId === sessionId).map((result) => ({
      taskId: result.taskId,
      revision: result.revision,
      createdAtMs: result.createdAtMs,
      outcome: result.kind === "plan" ? { kind: "plan", verdict: result.verdict } : {
        kind: "review",
        verdict: result.verdict,
        target: { ...result.target }
      }
    }));
    return {
      workKey: { ...workKey },
      tasks,
      results,
      session: session ? {
        sessionId: session.id,
        status: session.status,
        bindingGeneration: session.bindingGeneration,
        adapter: session.binding?.adapter ?? null,
        updatedAtMs: session.updatedAtMs
      } : null
    };
  }
  getState() {
    return structuredClone(this.state);
  }
  getSession(id) {
    const s = this.state.sessions[id];
    return s ? structuredClone(s) : null;
  }
  getAllSessions() {
    return Object.values(this.state.sessions).map((s) => structuredClone(s));
  }
  getTask(id) {
    const t = this.state.tasks[id];
    return t ? structuredClone(t) : null;
  }
  getAllTasks() {
    return Object.values(this.state.tasks).map((t) => structuredClone(t));
  }
  getTasksForSession(sessionId) {
    return Object.values(this.state.tasks).filter((t) => t.sessionId === sessionId).map((t) => structuredClone(t));
  }
  getResult(taskId) {
    const r = this.state.results[taskId];
    return r ? structuredClone(r) : null;
  }
  getFailure(taskId) {
    const f = this.state.failures[taskId];
    return f ? structuredClone(f) : null;
  }
  getReceipt(taskId) {
    const r = this.state.receipts[taskId];
    return r ? structuredClone(r) : null;
  }
  getOperationReceipt(key) {
    const r = this.state.operationReceipts[key];
    return r ? structuredClone(r) : null;
  }
  getRevision(key) {
    return this.state.revisions[key] ?? 0;
  }
  getContext(taskId) {
    const c = this.state.contexts?.[taskId];
    return c ? structuredClone(c) : null;
  }
  getAllContexts() {
    const res = {};
    if (this.state.contexts) {
      for (const [k, v] of Object.entries(this.state.contexts)) {
        res[k] = structuredClone(v);
      }
    }
    return res;
  }
  getPlan(taskId) {
    const p = this.state.plans?.[taskId];
    return p ? structuredClone(p) : null;
  }
  getAllPlans() {
    if (!this.state.plans) return [];
    return Object.values(this.state.plans).map((p) => structuredClone(p));
  }
  getLatestPlanForSession(sessionId) {
    if (!this.state.plans) return null;
    const sessionPlans = Object.values(this.state.plans).filter((p) => p.sessionId === sessionId);
    if (sessionPlans.length === 0) return null;
    sessionPlans.sort((a, b) => b.revision - a.revision);
    return structuredClone(sessionPlans[0]);
  }
  async transaction(mutator) {
    if (this.poisoned) {
      throw new StorePoisonedError(this.poisonReason ?? "Store previously experienced an unrecoverable write error");
    }
    const run = async () => {
      if (this.poisoned) {
        throw new StorePoisonedError(this.poisonReason ?? "Store is poisoned");
      }
      const draft = structuredClone(this.state);
      if (!draft.claimBindingGenerations) {
        draft.claimBindingGenerations = {};
      }
      const result = await mutator(draft);
      draft.transactionSequence = this.state.transactionSequence + 1;
      validateStoreRecord(draft);
      await this.persistDirect(draft);
      this.state = draft;
      return result;
    };
    const promise = this.transactionQueue.then(run, run);
    this.transactionQueue = promise.catch(() => {
    });
    return promise;
  }
  async persistDirect(record2) {
    const tempPath = path.join(this.storeDir, `store.json.tmp.${crypto__default.randomUUID()}`);
    const json = JSON.stringify(record2, null, 2);
    try {
      const handle = await fs.open(tempPath, "w");
      try {
        await handle.writeFile(json, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.storePath);
      try {
        const dirHandle = await fs.open(this.storeDir, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch (dirErr) {
        const code = dirErr.code;
        if (code === "EISDIR" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EINVAL" || code === "EPERM" && process.platform === "win32") {
        } else {
          throw dirErr;
        }
      }
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {
      }
      this.poisoned = true;
      this.poisonReason = err.message;
      throw err;
    }
  }
}
function parseArgs(argv) {
  let store = null;
  let bridgeUrl = null;
  let token = null;
  let session = "github:felixjichao/symphony-ts#99";
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--store") {
      store = argv[++i] ?? null;
    } else if (arg.startsWith("--store=")) {
      store = arg.slice("--store=".length);
    } else if (arg === "--bridge-url") {
      bridgeUrl = argv[++i] ?? null;
    } else if (arg.startsWith("--bridge-url=")) {
      bridgeUrl = arg.slice("--bridge-url=".length);
    } else if (arg === "--token") {
      token = argv[++i] ?? null;
    } else if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
    } else if (arg === "--session") {
      session = argv[++i] ?? session;
    } else if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { store, bridgeUrl, token, session, apply, help: false };
}
async function cleanupPollutedTasks(options, io = console) {
  const { store, bridgeUrl, token, session, apply } = options;
  if (store && bridgeUrl) {
    throw new Error("Conflicting options: Cannot specify both --store and --bridge-url");
  }
  if (!store && !bridgeUrl) {
    throw new Error("Must specify either --store <dir> or --bridge-url <url>");
  }
  if (!session || typeof session !== "string" || !session.trim()) {
    throw new Error("Target session ID must be non-empty");
  }
  const targetSessionId = session.trim();
  const cancelledTaskIds = [];
  if (store) {
    const resolvedStoreDir = path.resolve(store);
    const storePath = path.join(resolvedStoreDir, "store.json");
    try {
      await fs.access(storePath);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        io.log(`Store file not found at ${storePath}. Nothing to clean up.`);
        return { matched: 0, cancelled: 0, taskIds: [] };
      }
      throw err;
    }
    const storeInstance = new DurableDecisionStore({ storeDir: resolvedStoreDir });
    try {
      await storeInstance.open();
    } catch (err) {
      if (err instanceof DecisionStoreLockError || err && typeof err === "object" && err.name === "DecisionStoreLockError") {
        throw new Error(
          `Store directory "${resolvedStoreDir}" is currently locked by a running process. Local modification is rejected to prevent data corruption; use --bridge-url instead while the service is active.`
        );
      }
      throw err;
    }
    try {
      const decisionService = new DecisionService(storeInstance);
      const allTasks = storeInstance.getTasksForSession(targetSessionId);
      const targetTasks = allTasks.filter((t) => {
        return Boolean(t) && t.sessionId === targetSessionId && t.kind === "plan" && ["pending", "claimed", "running"].includes(t.status);
      });
      io.log(`Found ${targetTasks.length} pending plan task(s) for session "${targetSessionId}" in local store.`);
      if (targetTasks.length === 0) {
        return { matched: 0, cancelled: 0, taskIds: [] };
      }
      if (!apply) {
        io.log("[DRY-RUN] Tasks that would be cancelled:");
        for (const t of targetTasks) {
          io.log(`  - ${t.id} (status: ${t.status}, kind: ${t.kind}, revision: ${t.revision})`);
        }
        io.log("[DRY-RUN] Run with --apply to execute cancellation.");
        return { matched: targetTasks.length, cancelled: 0, taskIds: targetTasks.map((t) => t.id) };
      }
      for (const t of targetTasks) {
        await decisionService.cancelTask(t.id);
        cancelledTaskIds.push(t.id);
        io.log(`Cancelled task ${t.id}`);
      }
      io.log(`Successfully cancelled ${cancelledTaskIds.length} task(s) in local store.`);
      return { matched: targetTasks.length, cancelled: cancelledTaskIds.length, taskIds: cancelledTaskIds };
    } finally {
      await storeInstance.close();
    }
  }
  if (bridgeUrl) {
    const effectiveToken = token ?? process$1.env.DECISION_BRIDGE_TOKEN ?? null;
    const headers = {
      "Accept": "application/json",
      ...effectiveToken ? { "Authorization": `Bearer ${effectiveToken}` } : {}
    };
    const sessionTasksUrl = `${bridgeUrl.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(targetSessionId)}/tasks`;
    const res = await fetch(sessionTasksUrl, { method: "GET", headers });
    if (res.status === 404) {
      io.log(`Session "${targetSessionId}" not found on bridge. Nothing to clean up.`);
      return { matched: 0, cancelled: 0, taskIds: [] };
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to query tasks from bridge (${res.status}): ${errText}`);
    }
    const body = await res.json();
    const tasks = body.tasks || [];
    const targetTasks = tasks.filter((t) => {
      return Boolean(t) && t.sessionId === targetSessionId && t.kind === "plan" && ["pending", "claimed", "running"].includes(t.status);
    });
    io.log(`Found ${targetTasks.length} pending plan task(s) for session "${targetSessionId}" on bridge.`);
    if (targetTasks.length === 0) {
      return { matched: 0, cancelled: 0, taskIds: [] };
    }
    if (!apply) {
      io.log("[DRY-RUN] Tasks that would be cancelled:");
      for (const t of targetTasks) {
        io.log(`  - ${t.id} (status: ${t.status}, kind: ${t.kind}, revision: ${t.revision})`);
      }
      io.log("[DRY-RUN] Run with --apply to execute cancellation.");
      return { matched: targetTasks.length, cancelled: 0, taskIds: targetTasks.map((t) => t.id) };
    }
    for (const t of targetTasks) {
      const cancelUrl = `${bridgeUrl.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(t.id)}/cancel`;
      const cancelRes = await fetch(cancelUrl, { method: "POST", headers });
      if (!cancelRes.ok) {
        const cancelErr = await cancelRes.text();
        throw new Error(`Failed to cancel task ${t.id} (${cancelRes.status}): ${cancelErr}`);
      }
      cancelledTaskIds.push(t.id);
      io.log(`Cancelled task ${t.id}`);
    }
    io.log(`Successfully cancelled ${cancelledTaskIds.length} task(s) on bridge.`);
    return { matched: targetTasks.length, cancelled: cancelledTaskIds.length, taskIds: cancelledTaskIds };
  }
  return { matched: 0, cancelled: 0, taskIds: [] };
}
function isDirectExecution() {
  if (!process$1.argv[1]) return false;
  try {
    return path.resolve(process$1.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  let parsed;
  try {
    parsed = parseArgs(process$1.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process$1.exit(1);
  }
  if (parsed.help) {
    console.log(`
Usage: node scripts/cleanup-polluted-tasks.mjs [options]

Directionally cancels polluted/stuck Decision Plan tasks for a specific session (defaulting to #99).
Explicitly leaves #137 and all other sessions untouched.

Options:
  --store <dir>         Local decision store directory
  --bridge-url <url>    Remote decision bridge URL
  --token <token>       Bridge auth token (optional, or DECISION_BRIDGE_TOKEN)
  --session <id>        Target session ID (default: "github:felixjichao/symphony-ts#99")
  --apply               Execute cancellation (default is dry-run)
  -h, --help            Show this help message
`);
    process$1.exit(0);
  }
  cleanupPollutedTasks(parsed).then(() => process$1.exit(0)).catch((err) => {
    console.error(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    process$1.exit(1);
  });
}
export {
  cleanupPollutedTasks,
  isDirectExecution,
  parseArgs
};
