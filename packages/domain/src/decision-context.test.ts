import { describe, expect, it } from "vitest";
import {
  githubDecisionRoot,
  decisionSessionId,
  decisionTaskId,
  parseDecisionContextBundle,
  validateDecisionContextForTask,
  parseDecisionExecutionRequest,
  DecisionAdapterError,
  type DecisionTask,
  type DecisionSession,
  type DecisionConnectorContext,
  type DecisionMaterializedContext,
} from "./index";

const root = githubDecisionRoot("owner", "repo", 42);
const sessionId = decisionSessionId(root);

const baseSession: DecisionSession = {
  schemaVersion: 1,
  id: sessionId,
  root,
  status: "active",
  binding: null,
  bindingGeneration: 0,
  createdAtMs: 1000,
  updatedAtMs: 1000,
};

const planTask: DecisionTask = {
  schemaVersion: 1,
  id: decisionTaskId({ sessionId, kind: "plan", revision: 1 }),
  sessionId,
  kind: "plan",
  revision: 1,
  status: "pending",
  lease: null,
  claimGeneration: 0,
  lastClaimToken: null,
  createdAtMs: 1000,
  updatedAtMs: 1000,
};

const reviewTask: DecisionTask = {
  schemaVersion: 1,
  id: decisionTaskId({
    sessionId,
    kind: "review",
    revision: 1,
    target: {
      repository: "owner/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
  }),
  sessionId,
  kind: "review",
  revision: 1,
  status: "pending",
  lease: null,
  claimGeneration: 0,
  lastClaimToken: null,
  target: {
    repository: "owner/repo",
    prNumber: 42,
    headSha: "0123456789abcdef0123456789abcdef01234567",
  },
  createdAtMs: 1000,
  updatedAtMs: 1000,
};

describe("Decision Context Strategies", () => {
  it("parses valid connector context and validates for plan and review tasks", () => {
    const connectorContext: DecisionConnectorContext = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };

    const parsed = parseDecisionContextBundle(connectorContext);
    expect(parsed).toEqual(connectorContext);

    // Validates cleanly against review task
    expect(() => validateDecisionContextForTask(parsed, reviewTask)).not.toThrow();
  });

  it("fails closed on connector context review target mismatch", () => {
    const wrongShaContext: DecisionConnectorContext = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: 42,
      headSha: "ffffffffffffffffffffffffffffffffffffffff",
    };
    expect(() => validateDecisionContextForTask(wrongShaContext, reviewTask)).toThrow(
      /connector review context repository\/prNumber\/headSha mismatch/
    );

    const wrongPrContext: DecisionConnectorContext = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: 99,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };
    expect(() => validateDecisionContextForTask(wrongPrContext, reviewTask)).toThrow(
      /connector review context repository\/prNumber\/headSha mismatch/
    );

    const wrongRepoContext: DecisionConnectorContext = {
      strategy: "connector",
      workItem: root,
      repository: "other/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };
    expect(() => validateDecisionContextForTask(wrongRepoContext, reviewTask)).toThrow(
      /connector review context repository\/prNumber\/headSha mismatch/
    );
  });

  it("parses valid materialized context and validates for review task", () => {
    const materializedContext: DecisionMaterializedContext = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 42,
        title: "Test Issue",
        body: "Fix the bug",
      },
      plan: {
        taskId: planTask.id,
        revision: 1,
        plan: "Step 1: do thing",
        acceptanceCriteria: ["it works"],
        risks: ["none"],
        clarifications: [],
      },
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        baseRef: "main",
        headRef: "feat/42",
        title: "PR 42",
        body: "Closes #42",
      },
      diff: {
        patch: "diff --git a/file b/file...",
        files: ["file.ts"],
        truncated: false,
      },
      ci: {
        state: "success",
        summary: "All checks passed",
        checks: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
            url: "https://ci.example.com/1",
          },
        ],
      },
      repositoryInstructions: "Follow AGENTS.md rules",
      previousReviews: [],
      unresolvedFindings: [],
    };

    const parsed = parseDecisionContextBundle(materializedContext);
    expect(parsed.strategy).toBe("materialized");
    expect(() => validateDecisionContextForTask(parsed, reviewTask)).not.toThrow();
  });

  it("fails closed when materialized context lacks pullRequest or mismatches target for review task", () => {
    const contextWithoutPr: DecisionMaterializedContext = {
      strategy: "materialized",
      workItem: root,
      repository: "owner/repo",
      issue: {
        repository: "owner/repo",
        number: 42,
        title: "Test Issue",
        body: "Fix the bug",
      },
      plan: null,
      pullRequest: null,
      diff: null,
      ci: null,
      repositoryInstructions: null,
      previousReviews: [],
      unresolvedFindings: [],
    };

    expect(() => validateDecisionContextForTask(contextWithoutPr, reviewTask)).toThrow(
      /must include pullRequest metadata/
    );

    const contextWithMismatchedPr: DecisionMaterializedContext = {
      ...contextWithoutPr,
      pullRequest: {
        repository: "owner/repo",
        prNumber: 42,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        baseRef: "main",
        headRef: "feat/42",
        title: "PR 42",
        body: "Closes #42",
      },
    };

    expect(() => validateDecisionContextForTask(contextWithMismatchedPr, reviewTask)).toThrow(
      /materialized review context pullRequest mismatch/
    );
  });

  it("rejects unknown fields in context objects", () => {
    const badContext = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      extraUnknownField: "not allowed",
    };

    expect(() => parseDecisionContextBundle(badContext)).toThrow(/missing or unknown field/);
  });

  it("parses and validates DecisionExecutionRequest", () => {
    const connectorContext: DecisionConnectorContext = {
      strategy: "connector",
      workItem: root,
      repository: "owner/repo",
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    };

    const request = parseDecisionExecutionRequest({
      task: reviewTask,
      session: baseSession,
      context: connectorContext,
    });

    expect(request.task.id).toBe(reviewTask.id);
    expect(request.session.id).toBe(baseSession.id);

    // Mismatched session id throws
    const otherSession: DecisionSession = {
      ...baseSession,
      id: "github:other/repo#99",
      root: githubDecisionRoot("other", "repo", 99),
    };
    expect(() =>
      parseDecisionExecutionRequest({
        task: reviewTask,
        session: otherSession,
        context: connectorContext,
      })
    ).toThrow(/task sessionId mismatch/);
  });
});

describe("DecisionAdapterError", () => {
  it("derives suggestedAction and retryable from error code", () => {
    const transientErr = new DecisionAdapterError({
      code: "execution_failed",
      message: "Network timeout connecting to external executor",
    });
    expect(transientErr.code).toBe("execution_failed");
    expect(transientErr.retryable).toBe(true);
    expect(transientErr.suggestedAction).toBe("retry");
    expect(transientErr.details["suggestedAction"]).toBe("retry");

    const brokenBindingErr = new DecisionAdapterError({
      code: "binding_broken",
      message: "External chat thread deleted",
      observedGeneration: 3,
    });
    expect(brokenBindingErr.code).toBe("binding_broken");
    expect(brokenBindingErr.retryable).toBe(false);
    expect(brokenBindingErr.suggestedAction).toBe("rebind");
    expect(brokenBindingErr.observedGeneration).toBe(3);
    expect(brokenBindingErr.details["observedGeneration"]).toBe(3);

    const humanErr = new DecisionAdapterError({
      code: "human_required",
      message: "Cloudflare captcha challenged",
    });
    expect(humanErr.code).toBe("human_required");
    expect(humanErr.retryable).toBe(false);
    expect(humanErr.suggestedAction).toBe("human_intervention");

    const malformedErr = new DecisionAdapterError({
      code: "malformed_output",
      message: "No symphony-result fence found",
    });
    expect(malformedErr.code).toBe("malformed_output");
    expect(malformedErr.retryable).toBe(false);
    expect(malformedErr.suggestedAction).toBe("fail_closed");
  });
});
