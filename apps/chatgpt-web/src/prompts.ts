/**
 * ChatGPT prompt templates for bootstrap, task continuation, and durable rollover.
 */
import type {
  DecisionTask,
  DecisionReviewTask,
  DecisionContextBundle,
  DecisionMaterializedContext,
  DecisionConnectorContext,
} from "@symphony/domain/decision";

export const BOOTSTRAP_PROMPT = `You are acting as an Independent Decision Reviewer and Planner for the Symphony orchestration platform.

Your role:
1. When asked to evaluate an implementation plan, analyze the issue requirements, identify architectural risks, edge cases, and produce a structured, verifiable plan.
2. When asked to review a Pull Request, evaluate the code changes strictly against the repository requirements and the specified target HEAD SHA.
3. Strict verification rule: Never trust conversational memory or assume prior approvals carry over. Every review must inspect the fresh repository facts and current diff.
4. Output rule: Every response MUST conclude with a machine-readable JSON block wrapped in triple backticks with the language tag "symphony-result", like so:

\`\`\`symphony-result
{
  "schemaVersion": 1,
  "taskId": "<taskId>",
  "sessionId": "<sessionId>",
  "revision": <revision>,
  "kind": "plan" | "review",
  ...
}
\`\`\`

Acknowledge these instructions and confirm you are ready.`;

export function formatContinuationHeader(
  task: DecisionTask,
  previousReviewedSha?: string | null
): string {
  let header = `[Symphony Continuation — Session: ${task.sessionId}, Task: ${task.id}, Kind: ${task.kind}, Revision: ${task.revision}]\n`;
  if (task.kind === "review" && task.target) {
    header += `Target: ${task.target.repository} PR #${task.target.prNumber} @ ${task.target.headSha}\n`;
    if (previousReviewedSha) {
      header += `Previous reviewed HEAD was: ${previousReviewedSha}. This review evaluates current HEAD: ${task.target.headSha}.\n`;
    }
  }
  header += `Note: Do not reuse stale conversational assumptions. Strictly verify the current facts.\n\n`;
  return header;
}

export function formatPlanPrompt(
  task: DecisionTask,
  context: DecisionContextBundle
): string {
  let body = "";
  if (context.strategy === "materialized") {
    const mat = context as DecisionMaterializedContext;
    body += `Issue: ${mat.issue.repository} #${mat.issue.number} - ${mat.issue.title}\n\n`;
    body += `Description:\n${mat.issue.body}\n\n`;
    if (mat.repositoryInstructions) {
      body += `Repository Instructions:\n${mat.repositoryInstructions}\n\n`;
    }
  } else {
    const conn = context as DecisionConnectorContext;
    body += `WorkItem: ${conn.workItem.provider}:${conn.workItem.key}\n`;
    body += `Repository: ${conn.repository}\n\n`;
  }

  body += `Please formulate an implementation plan. Address scope, implementation slices, acceptance criteria, and risks.\n\n`;
  body += `Conclude your response with the following JSON envelope:\n\n`;
  body += `\`\`\`symphony-result\n`;
  body += `{\n`;
  body += `  "schemaVersion": 1,\n`;
  body += `  "taskId": "${task.id}",\n`;
  body += `  "sessionId": "${task.sessionId}",\n`;
  body += `  "revision": ${task.revision},\n`;
  body += `  "kind": "plan",\n`;
  body += `  "plan": "<summary of plan>",\n`;
  body += `  "acceptanceCriteria": ["<criteria 1>", "..."],\n`;
  body += `  "risks": ["<risk 1>", "..."],\n`;
  body += `  "clarifications": ["..."],\n`;
  body += `  "createdAtMs": ${Date.now()}\n`;
  body += `}\n`;
  body += `\`\`\`\n`;

  return body;
}

export interface ReviewPromptOptions {
  readonly previousReviewedSha?: string | null | undefined;
}

export function formatReviewPrompt(
  task: DecisionReviewTask,
  context: DecisionContextBundle,
  options: ReviewPromptOptions = {}
): string {
  let body = "";
  const target = task.target;
  body += `Please review the Pull Request for repository ${target.repository}, PR #${target.prNumber}.\n`;
  body += `Expected target HEAD SHA: ${target.headSha}\n`;
  if (options.previousReviewedSha) {
    body += `Previously reviewed HEAD SHA: ${options.previousReviewedSha}\n`;
    body += `Important: Prior approval or comments do NOT apply automatically. You MUST verify that changes since ${options.previousReviewedSha} meet all criteria.\n\n`;
  }

  if (context.strategy === "materialized") {
    const mat = context as DecisionMaterializedContext;
    if (mat.plan) {
      body += `Approved Plan (Task ${mat.plan.taskId}, rev ${mat.plan.revision}):\n${mat.plan.plan}\n\n`;
      body += `Acceptance criteria:\n${mat.plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n`;
    }
    if (mat.pullRequest) {
      body += `PR Title: ${mat.pullRequest.title}\n`;
      body += `PR Description:\n${mat.pullRequest.body}\n\n`;
    }
    if (mat.diff) {
      body += `Diff (files: ${mat.diff.files.join(", ")}):\n\`\`\`diff\n${mat.diff.patch}\n\`\`\`\n\n`;
      if (mat.diff.truncated) {
        body += `Warning: Diff was truncated. Inspect carefully or request clarification if critical changes are missing.\n\n`;
      }
    }
    if (mat.ci) {
      body += `CI State: ${mat.ci.state} (${mat.ci.summary})\n\n`;
    }
    if (mat.unresolvedFindings && mat.unresolvedFindings.length > 0) {
      body += `Outstanding unresolved findings from previous rounds:\n`;
      for (const f of mat.unresolvedFindings) {
        body += `- [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}\n`;
      }
      body += `\n`;
    }
  }

  body += `Evaluate the changes. Choose verdict: "approve" (ready to land), "changes_requested" (issues must be fixed), or "needs_human" (requires manual attention).\n\n`;
  body += `Conclude your response with the following JSON envelope:\n\n`;
  body += `\`\`\`symphony-result\n`;
  body += `{\n`;
  body += `  "schemaVersion": 1,\n`;
  body += `  "taskId": "${task.id}",\n`;
  body += `  "sessionId": "${task.sessionId}",\n`;
  body += `  "revision": ${task.revision},\n`;
  body += `  "kind": "review",\n`;
  body += `  "target": {\n`;
  body += `    "repository": "${target.repository}",\n`;
  body += `    "prNumber": ${target.prNumber},\n`;
  body += `    "headSha": "${target.headSha}"\n`;
  body += `  },\n`;
  body += `  "verdict": "approve" | "changes_requested" | "needs_human",\n`;
  body += `  "comments": "<overall review comments>",\n`;
  body += `  "findings": [\n`;
  body += `    {\n`;
  body += `      "id": "finding-1",\n`;
  body += `      "severity": "blocker" | "warning" | "note",\n`;
  body += `      "message": "<finding description>",\n`;
  body += `      "file": "path/to/file",\n`;
  body += `      "line": 42\n`;
  body += `    }\n`;
  body += `  ],\n`;
  body += `  "createdAtMs": ${Date.now()}\n`;
  body += `}\n`;
  body += `\`\`\`\n`;

  return body;
}

export function formatHandoffPrompt(
  task: DecisionTask,
  context: DecisionContextBundle,
  newGeneration: number
): string {
  let body = `[Symphony Session Rollover — Session: ${task.sessionId}, Generation: ${newGeneration}]\n`;
  body += `The previous ChatGPT conversation became unusable or was reset. This new conversation is re-bound to the same session lifecycle.\n\n`;
  body += `Durable handoff context:\n`;

  if (context.strategy === "materialized") {
    const mat = context as DecisionMaterializedContext;
    body += `- WorkItem / Issue: ${mat.issue.repository} #${mat.issue.number} - ${mat.issue.title}\n`;
    if (mat.plan) {
      body += `- Approved Plan:\n${mat.plan.plan}\n`;
    }
    if (mat.pullRequest) {
      body += `- Current PR: #${mat.pullRequest.prNumber} (${mat.pullRequest.headSha})\n`;
    }
    if (mat.previousReviews && mat.previousReviews.length > 0) {
      body += `- Previous reviews: ${mat.previousReviews.length} rounds. Latest verdict: ${mat.previousReviews[mat.previousReviews.length - 1]?.verdict}\n`;
    }
    if (mat.unresolvedFindings && mat.unresolvedFindings.length > 0) {
      body += `- Unresolved findings (${mat.unresolvedFindings.length}):\n`;
      for (const f of mat.unresolvedFindings) {
        body += `  * [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}\n`;
      }
    }
  } else {
    const conn = context as DecisionConnectorContext;
    body += `- WorkItem: ${conn.workItem.provider}:${conn.workItem.key}\n`;
    body += `- Repository: ${conn.repository}\n`;
    if (conn.prNumber) body += `- PR: #${conn.prNumber} @ ${conn.headSha ?? "unknown"}\n`;
  }

  body += `\nPlease acknowledge this handoff context and follow with the current task evaluation.\n\n`;
  return body;
}
