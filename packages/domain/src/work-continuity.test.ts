import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORK_CONTINUITY_POLICY,
  WORK_CONTINUITY_DIAGNOSES,
  WORK_RECOVERY_CLASSES,
  WORK_STAGES,
  deriveStageExpectation,
  deriveWorkContinuity,
  evaluateScheduledRecovery,
  evaluateWorkLiveness,
  isContinuationRelevant,
  recoveryClassForAction,
  requiresAutomaticRecovery,
  validateWorkContinuityObservation,
  workContinuityFingerprint,
  type WorkContinuityObservation,
  type WorkRecoveryClass,
} from "./index";
import { githubWorkKey } from "./operations-facts";

const NOW = 1_770_000_000_000;
const workKey = githubWorkKey("felixjichao", "symphony-ts", 147);

function baseObservation(
  overrides: Partial<WorkContinuityObservation> = {},
): WorkContinuityObservation {
  return {
    workKey,
    observedAt: NOW,
    active: true,
    stage: "coding",
    expectedAction: {
      action: "dispatch",
      description: "orchestrator should dispatch the coding attempt",
      authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
    },
    owner: {
      authority: "orchestrator",
      executor: "codex-agent",
      presence: "present",
      fence: { retryToken: "retry::1", hasLeaseToken: false },
    },
    liveness: {
      startedAt: NOW - 60_000,
      lastProgressAt: NOW - 5_000,
      progressSource: "codex_turn_completed",
    },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    sources: [
      { source: "tracker", status: "ok", observedAt: NOW },
      { source: "runtime", status: "ok", observedAt: NOW },
    ],
    requiredSources: ["tracker"],
    ...overrides,
  };
}

describe("Work-level continuity contracts", () => {
  it("defines provider-neutral diagnoses, stages, and recovery classes", () => {
    expect(WORK_CONTINUITY_DIAGNOSES).toEqual([
      "healthy",
      "awaiting_external",
      "blocked",
      "retry_scheduled",
      "stranded",
      "contradictory",
      "observation_unavailable",
      "terminal",
    ]);
    expect(WORK_STAGES).toEqual([
      "planning",
      "coding",
      "ci",
      "review",
      "repair",
      "delivery",
      "merge",
    ]);
    expect(WORK_RECOVERY_CLASSES).toContain("reclaim");
    expect(WORK_RECOVERY_CLASSES).not.toContain("none" as WorkRecoveryClass);
  });

  it("treats a valid active owner with fresh progress as healthy and never reclaims it", () => {
    const verdict = deriveWorkContinuity(baseObservation());

    expect(verdict.diagnosis).toBe("healthy");
    expect(verdict.recovery).toBeNull();
    expect(verdict.strandedReason).toBeNull();
    expect(requiresAutomaticRecovery(verdict)).toBe(false);
    expect(verdict.liveness.measured).toBe(true);
    expect(verdict.liveness.deadlineExceeded).toBe(false);
  });

  it("does not treat heartbeat-only ownership as measured progress", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        liveness: { startedAt: NOW - 600_000, lastProgressAt: "unknown" },
      }),
    );

    expect(verdict.liveness.measured).toBe(false);
    expect(verdict.liveness.lastProgressAt).toBe("unknown");
    expect(verdict.liveness.elapsedSinceProgressMs).toBeNull();
    // Missing progress evidence is not failure: the live owner keeps ownership.
    expect(verdict.diagnosis).toBe("healthy");
    expect(verdict.recovery).toBeNull();
  });

  it("detects an active work item with no owner as stranded with the expected authority", () => {
    const verdict = deriveWorkContinuity(baseObservation({ owner: null }));

    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("missing_owner");
    expect(verdict.recovery).not.toBeNull();
    expect(verdict.recovery?.class).toBe("dispatch");
    expect(verdict.recovery?.authority).toBe("orchestrator");
    expect(verdict.recovery?.requiresReobserve).toBe(true);
    expect(requiresAutomaticRecovery(verdict)).toBe(true);
  });

  it("derives the next action and owner for an unowned review stage", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        stage: "review",
        expectedAction: {
          action: "dispatch",
          description: "claim the review task",
          authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        },
        owner: null,
      }),
    );

    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("missing_owner");
    expect(verdict.recovery?.authority).toBe("decision");
    expect(verdict.recovery?.class).toBe("dispatch");
  });

  it("treats an explicitly observed external wait as legitimate, not stranded", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        stage: "ci",
        owner: null,
        externalWait: {
          authority: {
            kind: "external",
            system: "github-actions",
            condition: "required_checks_completed",
          },
          since: NOW - 120_000,
        },
      }),
    );

    expect(verdict.diagnosis).toBe("awaiting_external");
    expect(verdict.strandedReason).toBeNull();
    expect(verdict.recovery).toBeNull();
  });

  it("treats a human-owned next action as external waiting, not stranded", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: null,
        expectedAction: {
          action: "require_human",
          description: "operator must confirm",
          authority: { kind: "human", role: "operator", instruction: "confirm merge" },
        },
      }),
    );

    expect(verdict.diagnosis).toBe("awaiting_external");
    expect(verdict.recovery).toBeNull();
  });

  it("never auto-retries explicitly blocked work", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: null,
        blocked: {
          reason: "human_required",
          waitingOn: { kind: "human", role: "owner", instruction: "approve budget" },
          unblockCondition: "operator approves",
          blockedAt: NOW - 60_000,
        },
      }),
    );

    expect(verdict.diagnosis).toBe("blocked");
    expect(verdict.recovery).toBeNull();
    expect(requiresAutomaticRecovery(verdict)).toBe(false);
  });

  it("does not duplicate an already scheduled retry", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: null,
        scheduledRecovery: {
          kind: "retry",
          authority: "orchestrator",
          scheduledAt: NOW - 1_000,
          dueAt: NOW + 9_000,
          credential: "retry::issue::7",
        },
      }),
    );

    expect(verdict.diagnosis).toBe("retry_scheduled");
    expect(verdict.recovery).toBeNull();
    expect(verdict.scheduledRecovery?.due).toBe(false);
    expect(verdict.scheduledRecovery?.overdue).toBe(false);
  });

  it("keeps a due or overdue retry scheduled instead of enqueueing a second one", () => {
    const due = evaluateScheduledRecovery(
      {
        kind: "retry",
        authority: "orchestrator",
        scheduledAt: NOW - 20_000,
        dueAt: NOW - 1,
        credential: "retry::issue::8",
      },
      NOW,
    );
    expect(due.due).toBe(true);
    expect(due.overdue).toBe(false);

    const overdue = evaluateScheduledRecovery(
      {
        kind: "retry",
        authority: "orchestrator",
        scheduledAt: NOW - 120_000,
        dueAt: NOW - 60_000,
        credential: "retry::issue::8",
      },
      NOW,
    );
    expect(overdue.due).toBe(true);
    expect(overdue.overdue).toBe(true);

    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: null,
        scheduledRecovery: {
          kind: "retry",
          authority: "orchestrator",
          scheduledAt: NOW - 120_000,
          dueAt: NOW - 60_000,
          credential: "retry::issue::8",
        },
      }),
    );
    expect(verdict.diagnosis).toBe("retry_scheduled");
    expect(verdict.recovery).toBeNull();
  });

  it("fails safe when a required source is unavailable", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: null,
        sources: [
          { source: "tracker", status: "unavailable", observedAt: NOW, reason: "rate_limited" },
          { source: "runtime", status: "ok", observedAt: NOW },
        ],
        requiredSources: ["tracker"],
      }),
    );

    expect(verdict.diagnosis).toBe("observation_unavailable");
    expect(verdict.recovery).toBeNull();
    expect(requiresAutomaticRecovery(verdict)).toBe(false);
    expect(verdict.detail).toContain("rate_limited");
    // Observation failure must not be reported as "no owner".
    expect(verdict.strandedReason).toBeNull();
  });

  it("ignores an unavailable non-required source", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        sources: [
          { source: "tracker", status: "ok", observedAt: NOW },
          { source: "delivery", status: "unavailable", observedAt: NOW, reason: "no_state" },
        ],
        requiredSources: ["tracker"],
      }),
    );

    expect(verdict.diagnosis).toBe("healthy");
  });

  it("reports contradictory facts without selecting an owner", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        contradictions: [
          { code: "multiple_owners", message: "two executors claim the same lease" },
        ],
      }),
    );

    expect(verdict.diagnosis).toBe("contradictory");
    expect(verdict.recovery).toBeNull();
    expect(verdict.contradictions.map((c) => c.code)).toContain("multiple_owners");
  });

  it("treats active work with no derivable next action as contradictory", () => {
    const verdict = deriveWorkContinuity(baseObservation({ expectedAction: null, owner: null }));

    expect(verdict.diagnosis).toBe("contradictory");
    expect(verdict.contradictions.map((c) => c.code)).toContain("missing_expected_action");
    expect(verdict.recovery).toBeNull();
  });

  it("detects an unobservable owner as stranded", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        owner: {
          authority: "orchestrator",
          presence: "absent",
          fence: { hasLeaseToken: false },
        },
      }),
    );

    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("owner_not_observable");
    expect(verdict.recovery?.authority).toBe("orchestrator");
  });

  it("detects a progress deadline overrun as stranded with a bounded recovery", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        liveness: {
          startedAt: NOW - 600_000,
          lastProgressAt: NOW - 400_000,
          deadlineAt: NOW - 100_000,
        },
      }),
    );

    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("owner_progress_timeout");
    expect(verdict.liveness.deadlineExceeded).toBe(true);
    expect(verdict.recovery?.class).toBe("dispatch");
  });

  it("uses a strict threshold at the deadline boundary", () => {
    expect(
      evaluateWorkLiveness(
        { startedAt: NOW - 10, lastProgressAt: "unknown", deadlineAt: NOW },
        NOW,
      ).deadlineExceeded,
    ).toBe(false);
    expect(
      evaluateWorkLiveness(
        { startedAt: NOW - 10, lastProgressAt: "unknown", deadlineAt: NOW - 1 },
        NOW,
      ).deadlineExceeded,
    ).toBe(true);
  });

  it("supports an opt-in progress timeout without inventing progress", () => {
    const policy = { ...DEFAULT_WORK_CONTINUITY_POLICY, progressTimeoutMs: 10_000 };
    const exceeded = evaluateWorkLiveness(
      { startedAt: NOW - 60_000, lastProgressAt: NOW - 11_000 },
      NOW,
      policy,
    );
    expect(exceeded.deadlineExceeded).toBe(true);

    const unknown = evaluateWorkLiveness(
      { startedAt: NOW - 60_000, lastProgressAt: "unknown" },
      NOW,
      policy,
    );
    expect(unknown.measured).toBe(false);
    expect(unknown.deadlineExceeded).toBe(false);
  });

  it("treats an owner from a different stage authority as stranded", () => {
    const verdict = deriveWorkContinuity(
      baseObservation({
        stage: "review",
        owner: {
          authority: "orchestrator",
          presence: "present",
          fence: { hasLeaseToken: false },
        },
        expectedAction: {
          action: "dispatch",
          description: "claim review",
          authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        },
      }),
    );

    expect(verdict.diagnosis).toBe("stranded");
    expect(verdict.strandedReason).toBe("owner_stage_mismatch");
    expect(verdict.recovery?.authority).toBe("decision");
  });

  it("treats inactive tracks as terminal", () => {
    const verdict = deriveWorkContinuity(baseObservation({ active: false }));
    expect(verdict.diagnosis).toBe("terminal");
    expect(verdict.recovery).toBeNull();
    expect(isContinuationRelevant(verdict)).toBe(false);
  });

  it("maps every recovery action to a bounded recovery class", () => {
    expect(recoveryClassForAction("dispatch")).toBe("dispatch");
    expect(recoveryClassForAction("resume")).toBe("resume");
    expect(recoveryClassForAction("retry")).toBe("retry");
    expect(recoveryClassForAction("rebind")).toBe("rebind");
    expect(recoveryClassForAction("reclaim")).toBe("reclaim");
    expect(recoveryClassForAction("compensate")).toBe("compensate");
    expect(recoveryClassForAction("await_external")).toBe("await_external");
    expect(recoveryClassForAction("require_human")).toBe("require_human");
    expect(recoveryClassForAction("none")).toBeNull();
  });

  it("produces a stable fingerprint for identical facts and a different one when facts change", () => {
    const first = deriveWorkContinuity(baseObservation({ owner: null }));
    const second = deriveWorkContinuity(baseObservation({ owner: null }));
    expect(workContinuityFingerprint(first)).toBe(workContinuityFingerprint(second));

    const changed = deriveWorkContinuity(
      baseObservation({
        owner: null,
        expectedAction: {
          action: "compensate",
          description: "compensate handoff",
          authority: { kind: "internal", authority: "delivery" },
        },
      }),
    );
    expect(workContinuityFingerprint(first)).not.toBe(workContinuityFingerprint(changed));
  });

  it("is idempotent for repeated derivation over unchanged facts", () => {
    const observation = baseObservation({ owner: null });
    const results = Array.from({ length: 5 }, () => deriveWorkContinuity(observation));
    const fingerprints = new Set(results.map((verdict) => workContinuityFingerprint(verdict)));
    expect(fingerprints.size).toBe(1);
    expect(results.every((verdict) => verdict.diagnosis === "stranded")).toBe(true);
  });

  it("validates observations before derivation", () => {
    expect(validateWorkContinuityObservation(baseObservation()).valid).toBe(true);
    expect(
      validateWorkContinuityObservation(baseObservation({ requiredSources: [] })).valid,
    ).toBe(false);
    expect(
      validateWorkContinuityObservation(
        baseObservation({
          scheduledRecovery: {
            kind: "retry",
            authority: "orchestrator",
            scheduledAt: NOW,
            dueAt: NOW + 1,
            credential: "",
          },
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateWorkContinuityObservation(
        baseObservation({
          liveness: { startedAt: NOW + 1, lastProgressAt: "unknown" },
        }),
      ).valid,
    ).toBe(false);
  });
});

describe("Work stage expectation derivation", () => {
  const target = {
    repository: "felixjichao/symphony-ts",
    prNumber: 153,
    headSha: "a".repeat(40),
  };

  it("derives planning dispatch before a task exists", () => {
    const expectation = deriveStageExpectation({ kind: "planning", task: null });
    expect(expectation.stage).toBe("planning");
    expect(expectation.expectedAction.action).toBe("dispatch");
    expect(expectation.expectedAction.authority).toEqual({
      kind: "internal",
      authority: "decision",
      executor: "chatgpt-web",
    });
  });

  it("derives a task-scoped claim for a pending planning task", () => {
    const expectation = deriveStageExpectation({
      kind: "planning",
      task: { taskId: "task-1", revision: 3, status: "pending", claimGeneration: 0 },
    });
    expect(expectation.expectedAction.taskRef).toEqual({ taskId: "task-1", revision: 3 });
    expect(expectation.expectedAction.action).toBe("dispatch");
  });

  it("does not ask for a second dispatch while a planning claim is live", () => {
    const expectation = deriveStageExpectation({
      kind: "planning",
      task: { taskId: "task-1", revision: 3, status: "running", claimGeneration: 2 },
    });
    expect(expectation.expectedAction.action).toBe("none");
    expect(expectation.expectedAction.taskRef?.taskId).toBe("task-1");
  });

  it("derives coding dispatch versus a live coding attempt", () => {
    expect(deriveStageExpectation({ kind: "coding", running: false }).expectedAction.action).toBe(
      "dispatch",
    );
    expect(deriveStageExpectation({ kind: "coding", running: true }).expectedAction.action).toBe(
      "none",
    );
  });

  it("derives an explicit CI external wait", () => {
    const expectation = deriveStageExpectation({
      kind: "ci",
      prNumber: 153,
      headSha: target.headSha,
    });
    expect(expectation.expectedAction.action).toBe("await_external");
    expect(expectation.expectedAction.authority.kind).toBe("external");
    expect(expectation.expectedAction.description).toContain("PR #153");
  });

  it("derives a review claim scoped to the exact HEAD target", () => {
    const expectation = deriveStageExpectation({
      kind: "review",
      task: { taskId: "task-2", revision: 1, status: "pending", claimGeneration: 0 },
      target,
    });
    expect(expectation.stage).toBe("review");
    expect(expectation.expectedAction.action).toBe("dispatch");
    expect(expectation.expectedAction.target).toEqual(target);
    expect(expectation.expectedAction.authority.kind).toBe("internal");
  });

  it("derives repair and delivery actions under the Delivery authority", () => {
    expect(deriveStageExpectation({ kind: "repair", target }).expectedAction.action).toBe("retry");
    expect(
      deriveStageExpectation({ kind: "delivery", handoffId: null, target }).expectedAction.action,
    ).toBe("resume");

    const compensation = deriveStageExpectation({
      kind: "delivery",
      handoffId: "handoff-9",
      target,
    });
    expect(compensation.expectedAction.action).toBe("compensate");
    expect(compensation.expectedAction.handoffRef).toEqual({ handoffId: "handoff-9" });
  });

  it("derives merge verification without a recovery action", () => {
    const expectation = deriveStageExpectation({ kind: "merge", target });
    expect(expectation.stage).toBe("merge");
    expect(expectation.expectedAction.action).toBe("none");
    expect(expectation.expectedAction.target).toEqual(target);
  });
});

describe("Work-level continuity boundary invariants", () => {
  it("stays a pure domain module: sibling imports only, no Node I/O, no timers", () => {
    const source = readFileSync(new URL("./work-continuity.ts", import.meta.url), "utf8");
    const ast = ts.createSourceFile("work-continuity.ts", source, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          expect(node.moduleSpecifier.text.startsWith("./")).toBe(true);
          expect(node.moduleSpecifier.text).not.toContain("node:");
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        expect(["fetch", "setTimeout", "setInterval", "queueMicrotask"]).not.toContain(
          node.expression.text,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  });
});
