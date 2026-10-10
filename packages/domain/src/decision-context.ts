/**
 * Provider-neutral Decision execution context strategies and explicit payload bundles.
 * Independent of Symphony §7 orchestrator and concrete providers (e.g. ChatGPT).
 */
import {
  type DecisionWorkItemRef,
  type DecisionTask,
  type DecisionReviewResult,
  type DecisionReviewFinding,
  type DecisionSession,
  requireValue,
  record,
  string,
  integer,
  oneOf,
  array,
  strings,
  repository,
  validateRoot,
  parseDecisionResult,
  parseDecisionTask,
  parseDecisionSession,
  parseDecisionSessionRootFromId,
} from "./decision";

export type DecisionContextStrategyKind = "connector" | "materialized";

/**
 * Connector strategy: task carries stable references (WorkItem/Repository/PR/HEAD),
 * and the executor/adapter resolves repository context itself.
 */
export interface DecisionConnectorContext {
  readonly strategy: "connector";
  readonly workItem: DecisionWorkItemRef;
  readonly repository: string;
  readonly prNumber: number | null;
  readonly headSha: string | null;
}

export interface DecisionMaterializedIssue {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface DecisionMaterializedPlan {
  readonly taskId: string;
  readonly revision: number;
  readonly plan: string;
  readonly acceptanceCriteria: readonly string[];
  readonly risks: readonly string[];
  readonly clarifications: readonly string[];
}

export interface DecisionMaterializedPullRequest {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly title: string;
  readonly body: string;
}

export interface DecisionMaterializedDiff {
  readonly patch: string;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface DecisionMaterializedCiCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string | null;
}

export interface DecisionMaterializedCi {
  readonly state: string;
  readonly summary: string;
  readonly checks: readonly DecisionMaterializedCiCheck[];
}

/**
 * Materialized strategy: caller/adapter receives an explicit context bundle
 * (Issue, current/approved Plan, PR metadata, diff, CI state, repository instructions,
 * previous reviews, and unresolved findings).
 */
export interface DecisionMaterializedContext {
  readonly strategy: "materialized";
  readonly workItem: DecisionWorkItemRef;
  readonly repository: string;
  readonly issue: DecisionMaterializedIssue;
  readonly plan: DecisionMaterializedPlan | null;
  readonly pullRequest: DecisionMaterializedPullRequest | null;
  readonly diff: DecisionMaterializedDiff | null;
  readonly ci: DecisionMaterializedCi | null;
  readonly repositoryInstructions: string | null;
  readonly previousReviews: readonly DecisionReviewResult[];
  readonly unresolvedFindings: readonly DecisionReviewFinding[];
}

export type DecisionContextBundle = DecisionConnectorContext | DecisionMaterializedContext;

export interface DecisionExecutionRequest {
  readonly task: DecisionTask;
  readonly session: DecisionSession;
  readonly context: DecisionContextBundle;
}

function boolean(value: unknown): asserts value is boolean {
  requireValue(typeof value === "boolean", "expected boolean");
}

function sha(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^[0-9a-f]{40}$/.test(value), "expected full lowercase 40-char SHA");
}

export function parseDecisionContextBundle(value: unknown): DecisionContextBundle {
  requireValue(typeof value === "object" && value !== null, "expected context bundle object");
  const strategy = (value as Record<string, unknown>)["strategy"];
  oneOf(strategy, ["connector", "materialized"]);

  if (strategy === "connector") {
    const obj = record(value, ["strategy", "workItem", "repository", "prNumber", "headSha"]);
    const workItem = validateRoot(obj["workItem"]);
    repository(obj["repository"]);
    if (obj["prNumber"] !== null) integer(obj["prNumber"], 1);
    if (obj["headSha"] !== null) sha(obj["headSha"]);
    return {
      strategy: "connector",
      workItem,
      repository: obj["repository"] as string,
      prNumber: obj["prNumber"] as number | null,
      headSha: obj["headSha"] as string | null,
    };
  }

  // strategy === "materialized"
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
    "unresolvedFindings",
  ]);

  const workItem = validateRoot(obj["workItem"]);
  repository(obj["repository"]);

  // issue
  const rawIssue = record(obj["issue"], ["repository", "number", "title", "body"]);
  repository(rawIssue["repository"]);
  integer(rawIssue["number"], 1);
  string(rawIssue["title"]);
  requireValue(typeof rawIssue["body"] === "string", "expected issue body string");
  const issue: DecisionMaterializedIssue = {
    repository: rawIssue["repository"] as string,
    number: rawIssue["number"] as number,
    title: rawIssue["title"] as string,
    body: rawIssue["body"] as string,
  };

  // plan
  let plan: DecisionMaterializedPlan | null = null;
  if (obj["plan"] !== null) {
    const rawPlan = record(obj["plan"], ["taskId", "revision", "plan", "acceptanceCriteria", "risks", "clarifications"]);
    string(rawPlan["taskId"]);
    integer(rawPlan["revision"], 1);
    string(rawPlan["plan"]);
    strings(rawPlan["acceptanceCriteria"]);
    strings(rawPlan["risks"]);
    strings(rawPlan["clarifications"]);
    plan = {
      taskId: rawPlan["taskId"] as string,
      revision: rawPlan["revision"] as number,
      plan: rawPlan["plan"] as string,
      acceptanceCriteria: rawPlan["acceptanceCriteria"] as readonly string[],
      risks: rawPlan["risks"] as readonly string[],
      clarifications: rawPlan["clarifications"] as readonly string[],
    };
  }

  // pullRequest
  let pullRequest: DecisionMaterializedPullRequest | null = null;
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
      repository: rawPr["repository"] as string,
      prNumber: rawPr["prNumber"] as number,
      headSha: rawPr["headSha"] as string,
      baseRef: rawPr["baseRef"] as string,
      headRef: rawPr["headRef"] as string,
      title: rawPr["title"] as string,
      body: rawPr["body"] as string,
    };
  }

  // diff
  let diff: DecisionMaterializedDiff | null = null;
  if (obj["diff"] !== null) {
    const rawDiff = record(obj["diff"], ["patch", "files", "truncated"]);
    requireValue(typeof rawDiff["patch"] === "string", "expected patch string");
    strings(rawDiff["files"]);
    boolean(rawDiff["truncated"]);
    diff = {
      patch: rawDiff["patch"] as string,
      files: rawDiff["files"] as readonly string[],
      truncated: rawDiff["truncated"] as boolean,
    };
  }

  // ci
  let ci: DecisionMaterializedCi | null = null;
  if (obj["ci"] !== null) {
    const rawCi = record(obj["ci"], ["state", "summary", "checks"]);
    string(rawCi["state"]);
    requireValue(typeof rawCi["summary"] === "string", "expected CI summary string");
    const rawChecks = array(rawCi["checks"]);
    const checks: DecisionMaterializedCiCheck[] = [];
    for (const item of rawChecks) {
      const checkRecord = record(item, ["name", "status", "conclusion", "url"]);
      string(checkRecord["name"]);
      string(checkRecord["status"]);
      if (checkRecord["conclusion"] !== null) string(checkRecord["conclusion"]);
      if (checkRecord["url"] !== null) string(checkRecord["url"]);
      checks.push({
        name: checkRecord["name"] as string,
        status: checkRecord["status"] as string,
        conclusion: checkRecord["conclusion"] as string | null,
        url: checkRecord["url"] as string | null,
      });
    }
    ci = {
      state: rawCi["state"] as string,
      summary: rawCi["summary"] as string,
      checks,
    };
  }

  // repositoryInstructions
  let repositoryInstructions: string | null = null;
  if (obj["repositoryInstructions"] !== null) {
    requireValue(typeof obj["repositoryInstructions"] === "string", "expected repository instructions string");
    repositoryInstructions = obj["repositoryInstructions"] as string;
  }

  // previousReviews
  const rawReviews = array(obj["previousReviews"]);
  const previousReviews: DecisionReviewResult[] = [];
  for (const item of rawReviews) {
    const parsed = parseDecisionResult(item);
    requireValue(parsed.kind === "review", "previousReviews elements must be review results");
    previousReviews.push(parsed as DecisionReviewResult);
  }

  // unresolvedFindings
  const rawFindings = array(obj["unresolvedFindings"]);
  const unresolvedFindings: DecisionReviewFinding[] = [];
  for (const item of rawFindings) {
    const findingRecord = record(item, ["severity", "message", "location"]);
    oneOf(findingRecord["severity"], ["blocker", "suggestion"]);
    string(findingRecord["message"]);
    if (findingRecord["location"] !== null) string(findingRecord["location"]);
    unresolvedFindings.push({
      severity: findingRecord["severity"] as "blocker" | "suggestion",
      message: findingRecord["message"] as string,
      location: findingRecord["location"] as string | null,
    });
  }

  return {
    strategy: "materialized",
    workItem,
    repository: obj["repository"] as string,
    issue,
    plan,
    pullRequest,
    diff,
    ci,
    repositoryInstructions,
    previousReviews,
    unresolvedFindings,
  };
}

export function validateDecisionContextForTask(
  context: DecisionContextBundle,
  task: DecisionTask,
  session?: DecisionSession
): void {
  parseDecisionTask(task);
  parseDecisionContextBundle(context);

  if (session !== undefined) {
    parseDecisionSession(session);
    requireValue(task.sessionId === session.id, "task sessionId mismatch with session id");
    requireValue(
      context.workItem.provider === session.root.provider &&
      context.workItem.key === session.root.key,
      "context workItem mismatch with session root"
    );
  } else {
    const expectedRoot = parseDecisionSessionRootFromId(task.sessionId);
    requireValue(
      context.workItem.provider === expectedRoot.provider &&
      context.workItem.key === expectedRoot.key,
      "context workItem mismatch with task session root"
    );
  }

  const effectiveRoot = session !== undefined ? session.root : parseDecisionSessionRootFromId(task.sessionId);
  if (effectiveRoot.provider === "github") {
    const match = /^(.*)#([1-9][0-9]*)$/.exec(effectiveRoot.key);
    requireValue(match !== null, "invalid GitHub issue key in session root");
    const expectedRepo = match[1]!;
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
        context.repository === task.target.repository &&
        context.prNumber === task.target.prNumber &&
        context.headSha === task.target.headSha,
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
        context.pullRequest.repository === task.target.repository &&
        context.pullRequest.prNumber === task.target.prNumber &&
        context.pullRequest.headSha === task.target.headSha,
        "materialized review context pullRequest mismatch with task target"
      );
    }
  } else {
    // plan task
    if (context.strategy === "materialized") {
      requireValue(
        context.issue.repository === context.repository,
        "materialized plan context issue repository mismatch with context repository"
      );
    }
  }
}

export function parseDecisionExecutionRequest(value: unknown): DecisionExecutionRequest {
  requireValue(typeof value === "object" && value !== null, "expected execution request object");
  const obj = record(value, ["task", "session", "context"]);
  const task = parseDecisionTask(obj["task"]);
  const session = parseDecisionSession(obj["session"]);
  const context = parseDecisionContextBundle(obj["context"]);

  validateDecisionContextForTask(context, task, session);

  return { task, session, context };
}
