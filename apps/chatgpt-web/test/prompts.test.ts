import { describe, it, expect } from "vitest";
import {
  BOOTSTRAP_PROMPT,
  formatContinuationHeader,
  formatPlanPrompt,
  formatReviewPrompt,
  formatHandoffPrompt,
} from "../src/prompts";
import type { DecisionPlanTask, DecisionReviewTask, DecisionContextBundle } from "@symphony/domain/decision";

describe("Prompt formatting and engineering", () => {
  const planTask: DecisionPlanTask = {
    schemaVersion: 1,
    id: "github%3Aowner%2Frepo%231:plan:1",
    sessionId: "github:owner/repo#1",
    kind: "plan",
    revision: 1,
    status: "pending",
    lease: null,
    claimGeneration: 0,
    lastClaimToken: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };

  const reviewTask: DecisionReviewTask = {
    schemaVersion: 1,
    id: "github%3Aowner%2Frepo%231:review:1:owner%2Frepo:42:1111111111111111111111111111111111111111",
    sessionId: "github:owner/repo#1",
    kind: "review",
    revision: 1,
    target: {
      repository: "owner/repo",
      prNumber: 42,
      headSha: "1111111111111111111111111111111111111111",
    },
    status: "pending",
    lease: null,
    claimGeneration: 0,
    lastClaimToken: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };

  it("includes required instructions in BOOTSTRAP_PROMPT", () => {
    expect(BOOTSTRAP_PROMPT).toContain("Independent Decision Reviewer and Planner");
    expect(BOOTSTRAP_PROMPT).toContain("symphony-result");
    expect(BOOTSTRAP_PROMPT).toContain("Strict verification rule");
  });

  it("formats continuation header and notes previous reviewed SHA", () => {
    const header = formatContinuationHeader(reviewTask, "0000000000000000000000000000000000000000");
    expect(header).toContain("[Symphony Continuation");
    expect(header).toContain("Previous reviewed HEAD was: 0000000000000000000000000000000000000000");
    expect(header).toContain("current HEAD: 1111111111111111111111111111111111111111");
  });

  it("formats plan prompt with materialized context", () => {
    const context: DecisionContextBundle = {
      strategy: "materialized",
      workItem: { provider: "github", key: "owner/repo#1" },
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Support ChatGPT Web",
        body: "Detailed description of requirements",
      },
      plan: null,
      pullRequest: null,
      diff: null,
      ci: null,
      repositoryInstructions: "Follow TypeScript strict mode",
      previousReviews: [],
      unresolvedFindings: [],
    };

    const prompt = formatPlanPrompt(planTask, context);
    expect(prompt).toContain("Issue: owner/repo #1 - Support ChatGPT Web");
    expect(prompt).toContain("Detailed description of requirements");
    expect(prompt).toContain("Follow TypeScript strict mode");
    expect(prompt).toContain('"kind": "plan"');
    expect(prompt).toContain("symphony-result");
  });

  it("formats review prompt with strict SHA binding and unresolved findings", () => {
    const context: DecisionContextBundle = {
      strategy: "materialized",
      workItem: { provider: "github", key: "owner/repo#1" },
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Support ChatGPT Web",
        body: "Issue body",
      },
      plan: {
        taskId: planTask.id,
        revision: 1,
        plan: "Approved architectural plan",
        acceptanceCriteria: ["Acceptance 1"],
        risks: ["Risk 1"],
        clarifications: [],
      },
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: "1111111111111111111111111111111111111111",
        baseRef: "main",
        headRef: "feat/chatgpt-web",
        title: "PR Title",
        body: "PR Description",
      },
      diff: {
        patch: "+ console.log('hello')",
        files: ["src/index.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "All checks passed",
        checks: [{ name: "gate", status: "completed", conclusion: "success", url: null }],
      },
      repositoryInstructions: null,
      previousReviews: [],
      unresolvedFindings: [
        { severity: "blocker", message: "Missing error handler", location: "src/driver.ts:42" },
      ],
    };

    const prompt = formatReviewPrompt(reviewTask, context, {
      previousReviewedSha: "0000000000000000000000000000000000000000",
    });

    expect(prompt).toContain("Expected target HEAD SHA: 1111111111111111111111111111111111111111");
    expect(prompt).toContain("Previously reviewed HEAD SHA: 0000000000000000000000000000000000000000");
    expect(prompt).toContain("Diff (files: src/index.ts)");
    expect(prompt).toContain("+ console.log('hello')");
    expect(prompt).toContain("CI State: success");
    expect(prompt).toContain("- [blocker] src/driver.ts:42: Missing error handler");
    expect(prompt).toContain('"kind": "review"');
  });

  it("formats handoff prompt carrying forward review context for rebind/rollover", () => {
    const context: DecisionContextBundle = {
      strategy: "materialized",
      workItem: { provider: "github", key: "owner/repo#1" },
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Issue",
        body: "Body",
      },
      plan: {
        taskId: planTask.id,
        revision: 1,
        plan: "Plan text",
        acceptanceCriteria: [],
        risks: [],
        clarifications: [],
      },
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: "1111111111111111111111111111111111111111",
        baseRef: "main",
        headRef: "feat",
        title: "PR",
        body: "PR body",
      },
      diff: null,
      ci: null,
      repositoryInstructions: null,
      previousReviews: [],
      unresolvedFindings: [
        { severity: "suggestion", message: "Add comment", location: "src/file.ts" },
      ],
    };

    const handoff = formatHandoffPrompt(reviewTask, context, 2);
    expect(handoff).toContain("[Symphony Session Rollover — Session: github:owner/repo#1, Generation: 2]");
    expect(handoff).toContain("- Current PR: #42 (1111111111111111111111111111111111111111)");
    expect(handoff).toContain("* [suggestion] src/file.ts: Add comment");
  });

  it("produces valid JSON result templates that parse with parseDecisionResult", async () => {
    const { parseDecisionResult } = await import("@symphony/domain/decision");
    const { extractDecisionResultFromOutput } = await import("@symphony/decision/adapter");

    const context: DecisionContextBundle = {
      strategy: "materialized",
      workItem: { provider: "github", key: "owner/repo#1" },
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 1,
        title: "Issue",
        body: "Body",
      },
      plan: null,
      pullRequest: null,
      diff: null,
      ci: null,
      repositoryInstructions: null,
      previousReviews: [],
      unresolvedFindings: [],
    };

    const planPrompt = formatPlanPrompt(planTask, context);
    // Extract the symphony-result block from the prompt itself:
    const extractedPlan = extractDecisionResultFromOutput(planPrompt, planTask);
    expect(extractedPlan.kind).toBe("plan");
    expect(extractedPlan.verdict).toBe("ready");
    expect(parseDecisionResult(extractedPlan)).toEqual(extractedPlan);

    const reviewPrompt = formatReviewPrompt(reviewTask, context);
    const extractedReview = extractDecisionResultFromOutput(reviewPrompt, reviewTask);
    expect(extractedReview.kind).toBe("review");
    expect(extractedReview.verdict).toBe("approve");
    expect(parseDecisionResult(extractedReview)).toEqual(extractedReview);
  });
});
