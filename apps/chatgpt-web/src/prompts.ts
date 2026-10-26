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

/** Decision extension (§4, §17/§18): autonomous review-to-landing policy. */
const AUTONOMOUS_DECISION_POLICY = `Autonomous delivery policy:
- Reserve needs_human for unclear product intent requiring a human product decision. Identify the unresolved product question explicitly.
- Do not merge directly from ChatGPT Web. Return the structured verdict; the host owns the fenced merge operation.

`;

function evidenceFailureInstructions(task: DecisionTask): string {
  return `If repository facts, required verification evidence, or critical diff content cannot be recovered, do not emit a verdict. Instead conclude with this executor failure envelope (not a DecisionResult):
\`\`\`symphony-result
${JSON.stringify({ schemaVersion: 1, taskId: task.id, sessionId: task.sessionId, revision: task.revision,
    kind: task.kind, ...(task.kind === "review" ? { target: task.target } : {}),
    error: "evidence_unavailable", message: "<specific evidence/access failure and recovery needed>" }, null, 2)}
\`\`\`
The adapter submits an evidence_unavailable task failure. Delivery stops as an operational block without running code repair or spending its repair budget. Recovery must restore evidence/access before a new review; this is not a human product verdict. This failure envelope replaces the success envelope below.

`;
}

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
  "createdAtMs": <timestamp>,
  "kind": "plan" | "review",
  ...
}
\`\`\`

Strict v1 schema enforcement is active: unknown or misplaced fields will cause fail-closed rejection.
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
  let body = AUTONOMOUS_DECISION_POLICY + evidenceFailureInstructions(task);
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
    body += `Important connector instructions:\n`;
    body += `You have received connector references instead of full inlined context. You MUST fetch and inspect the actual repository instructions, issue description, and requirements. If facts cannot be verified or context is insufficient, do not mark the plan ready. Use "needs_clarification" for missing product requirements; report technical access or evidence failures as execution failures for recovery, not as a product decision.\n\n`;
  }

  body += `For missing product requirements during planning, use needs_clarification.\n`;
  body += `Please formulate an implementation plan. Address scope, implementation slices, acceptance criteria, and risks.\n\n`;
  body += `Verdict choices: "ready" (plan is complete and ready to execute), "needs_clarification" (missing requirements), or "needs_human" (unclear product intent requires a human product decision).\n`;
  body += `On successful task completion (otherwise use the executor failure envelope above), conclude strictly with the following JSON envelope (note: all plan fields MUST be nested inside "content", and no extra fields are allowed):\n\n`;
  body += `\`\`\`symphony-result\n`;
  body += `{\n`;
  body += `  "schemaVersion": 1,\n`;
  body += `  "taskId": "${task.id}",\n`;
  body += `  "sessionId": "${task.sessionId}",\n`;
  body += `  "revision": ${task.revision},\n`;
  body += `  "createdAtMs": ${Date.now()},\n`;
  body += `  "kind": "plan",\n`;
  body += `  "verdict": "ready",\n`;
  body += `  "content": {\n`;
  body += `    "plan": "<summary of plan>",\n`;
  body += `    "acceptanceCriteria": ["<criteria 1>", "..."],\n`;
  body += `    "risks": ["<risk 1>", "..."],\n`;
  body += `    "clarifications": ["..."]\n`;
  body += `  }\n`;
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
  let body = AUTONOMOUS_DECISION_POLICY + evidenceFailureInstructions(task);
  body += `An approve verdict authorizes the host delivery pipeline to merge the exact reviewed HEAD after its existing ownership, opt-in, CI and merge-safety checks pass; no additional human review is required.\n`;
  body += `Technical defects, test failures, and implementation gaps require changes_requested with actionable blocker findings so the coding agent can repair and return for review. Evidence/access failures use the executor failure envelope, never changes_requested.\n\n`;
  const target = task.target;
  body += `Please review the Pull Request for repository ${target.repository}, PR #${target.prNumber}.\n`;
  body += `Expected target HEAD SHA: ${target.headSha}\n`;
  if (options.previousReviewedSha) {
    body += `Previously reviewed HEAD SHA: ${options.previousReviewedSha}\n`;
    body += `Important: Prior approval or comments do NOT apply automatically. You MUST verify that changes since ${options.previousReviewedSha} meet all criteria.\n\n`;
  }

  if (context.strategy === "materialized") {
    const mat = context as DecisionMaterializedContext;
    body += `Issue: ${mat.issue.repository} #${mat.issue.number} - ${mat.issue.title}\n`;
    body += `Issue Description:\n${mat.issue.body}\n\n`;

    if (mat.repositoryInstructions) {
      body += `Repository Instructions:\n${mat.repositoryInstructions}\n\n`;
    }
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
        body += `Warning: Diff was truncated. Recover and inspect the missing critical changes; if unavailable, emit the evidence_unavailable executor failure envelope. Never approve an incomplete critical diff or request product clarification for missing technical evidence.\n\n`;
      }
    }
    if (mat.ci) {
      body += `CI State: ${mat.ci.state} (${mat.ci.summary})\n\n`;
    }
    if (mat.previousReviews && mat.previousReviews.length > 0) {
      body += `Previous Review History (${mat.previousReviews.length} rounds):\n`;
      for (const rev of mat.previousReviews) {
        body += `- Review Task ${rev.taskId} (rev ${rev.revision}, target ${rev.target.headSha}): verdict=${rev.verdict}, findings=${rev.findings.length}\n`;
        for (const f of rev.findings) {
          body += `  * [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}\n`;
        }
      }
      body += `\n`;
    }
    if (mat.unresolvedFindings && mat.unresolvedFindings.length > 0) {
      body += `Outstanding unresolved findings from previous rounds:\n`;
      for (const f of mat.unresolvedFindings) {
        body += `- [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}\n`;
      }
      body += `\n`;
    }
  } else {
    const conn = context as DecisionConnectorContext;
    body += `WorkItem: ${conn.workItem.provider}:${conn.workItem.key}\n`;
    body += `Repository: ${conn.repository}\n`;
    if (conn.prNumber) body += `PR: #${conn.prNumber}\n`;
    body += `\nImportant connector instructions:\n`;
    body += `You have received connector references instead of full inlined context. You MUST re-inspect and verify actual repository instructions, current issue description, PR diff, and CI facts. If facts cannot be verified or context is insufficient, you MUST NOT approve; use the evidence_unavailable executor failure envelope if the missing facts cannot be recovered.\n\n`;
  }

  body += `Evaluate the changes. Choose verdict: "approve" (ready to land), "changes_requested" (issues must be fixed), or "needs_human" (unclear product intent requires a human product decision).\n\n`;
  body += `On successful task completion (otherwise use the executor failure envelope above), conclude strictly with the following JSON envelope:\n`;
  body += `- Do NOT include a "comments" field at the root.\n`;
  body += `- Each finding in "findings" MUST only contain: "severity" ("blocker" or "suggestion"), "message" (string), and "location" (string like "path/to/file.ts:42" or null). Do NOT include "id", "file", or "line".\n`;
  body += `- Strict v1 schema validation will reject unknown or misspelled fields.\n\n`;
  body += `\`\`\`symphony-result\n`;
  body += `{\n`;
  body += `  "schemaVersion": 1,\n`;
  body += `  "taskId": "${task.id}",\n`;
  body += `  "sessionId": "${task.sessionId}",\n`;
  body += `  "revision": ${task.revision},\n`;
  body += `  "createdAtMs": ${Date.now()},\n`;
  body += `  "kind": "review",\n`;
  body += `  "target": {\n`;
  body += `    "repository": "${target.repository}",\n`;
  body += `    "prNumber": ${target.prNumber},\n`;
  body += `    "headSha": "${target.headSha}"\n`;
  body += `  },\n`;
  body += `  "verdict": "approve",\n`;
  body += `  "findings": [\n`;
  body += `    {\n`;
  body += `      "severity": "blocker",\n`;
  body += `      "message": "<finding description>",\n`;
  body += `      "location": "path/to/file.ts:42"\n`;
  body += `    }\n`;
  body += `  ]\n`;
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
    body += `- Issue Description:\n${mat.issue.body}\n\n`;
    if (mat.repositoryInstructions) {
      body += `- Repository Instructions:\n${mat.repositoryInstructions}\n\n`;
    }
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
    body += `- Important: Connector strategy active. Re-fetch repository instructions, issue description, and verification facts. If facts cannot be verified, do NOT approve.\n`;
  }

  body += `\nPlease acknowledge this handoff context and follow with the current task evaluation.\n\n`;
  return body;
}
