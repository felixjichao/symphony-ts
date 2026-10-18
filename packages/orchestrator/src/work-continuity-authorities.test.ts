import { describe, expect, it } from "vitest";

import {
  deriveWorkContinuity,
  githubWorkKey,
  type WorkContinuityObservation,
} from "@symphony/domain";

import {
  createDecisionRecoveryAuthority,
  createDeliveryRecoveryAuthority,
  createOrchestratorRecoveryAuthority,
} from "./index";
import type { WorkRecoveryRequest } from "./index";

const NOW = 1_770_000_000_000;
const workKey = githubWorkKey("felixjichao", "symphony-ts", 147);

function verdictFor(
  overrides: Partial<WorkContinuityObservation> = {},
): ReturnType<typeof deriveWorkContinuity> {
  return deriveWorkContinuity({
    workKey,
    observedAt: NOW,
    active: true,
    stage: "coding",
    expectedAction: {
      action: "dispatch",
      description: "dispatch coding",
      authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
    },
    owner: null,
    liveness: { startedAt: NOW - 60_000, lastProgressAt: "unknown" },
    scheduledRecovery: null,
    externalWait: null,
    blocked: null,
    sources: [{ source: "tracker", status: "ok", observedAt: NOW }],
    requiredSources: ["tracker"],
    fence: { retryToken: "retry::a", hasLeaseToken: false },
    ...overrides,
  });
}

function request(verdict: ReturnType<typeof deriveWorkContinuity>): WorkRecoveryRequest {
  return {
    workKey,
    recovery: verdict.recovery!,
    verdict,
    idempotencyKey: "fp-1",
  };
}

describe("Recovery authority adapters", () => {
  it("forwards the expected fence and idempotency key to the orchestrator port", async () => {
    const calls: unknown[] = [];
    const adapter = createOrchestratorRecoveryAuthority({
      dispatchWork: async (input) => {
        calls.push(input);
        return { kind: "applied", detail: "dispatched" };
      },
    });

    const verdict = verdictFor();
    const outcome = await adapter.recover(request(verdict));

    expect(adapter.authority).toBe("orchestrator");
    expect(outcome.kind).toBe("applied");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workKey,
      expectedFence: { retryToken: "retry::a" },
      idempotencyKey: "fp-1",
    });
  });

  it("maps a released Decision claim to applied", async () => {
    const calls: unknown[] = [];
    const adapter = createDecisionRecoveryAuthority({
      releaseExpiredClaim: async (input) => {
        calls.push(input);
        return { kind: "released" };
      },
    });

    const verdict = verdictFor({
      stage: "review",
      expectedAction: {
        action: "dispatch",
        description: "claim review",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: "task-9", revision: 4 },
      },
      owner: {
        authority: "decision",
        presence: "present",
        fence: { leaseGeneration: 7, hasLeaseToken: true },
      },
      liveness: { startedAt: NOW - 600_000, lastProgressAt: "unknown", deadlineAt: NOW - 1 },
    });

    expect(verdict.diagnosis).toBe("stranded");
    const outcome = await adapter.recover(request(verdict));

    expect(outcome.kind).toBe("applied");
    expect(calls[0]).toEqual({
      taskId: "task-9",
      expectedRevision: 4,
      expectedClaimGeneration: 7,
    });
  });

  it("reports a superseded Decision claim as refused", async () => {
    const adapter = createDecisionRecoveryAuthority({
      releaseExpiredClaim: async () => ({ kind: "superseded", reason: "generation advanced" }),
    });
    const verdict = verdictFor({
      stage: "planning",
      expectedAction: {
        action: "dispatch",
        description: "claim plan",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: "task-1", revision: 1 },
      },
    });

    const outcome = await adapter.recover(request(verdict));
    expect(outcome).toEqual({ kind: "refused", reason: "generation advanced" });
  });

  it("reports a live Decision claim as skipped rather than retrying", async () => {
    const adapter = createDecisionRecoveryAuthority({
      releaseExpiredClaim: async () => ({ kind: "not_expired" }),
    });
    const verdict = verdictFor({
      stage: "planning",
      expectedAction: {
        action: "dispatch",
        description: "claim plan",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: "task-1", revision: 1 },
      },
    });

    const outcome = await adapter.recover(request(verdict));
    expect(outcome.kind).toBe("skipped");
  });

  it("refuses to invent a Decision task reference", async () => {
    const adapter = createDecisionRecoveryAuthority({
      releaseExpiredClaim: async () => ({ kind: "released" }),
    });
    const verdict = verdictFor({
      stage: "planning",
      expectedAction: {
        action: "dispatch",
        description: "dispatch planning",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
      },
    });

    const outcome = await adapter.recover(request(verdict));
    expect(outcome.kind).toBe("unavailable");
  });

  it("forwards a concrete handoff id to the Delivery port", async () => {
    const calls: unknown[] = [];
    const adapter = createDeliveryRecoveryAuthority({
      compensateHandoff: async (input) => {
        calls.push(input);
        return { kind: "applied" };
      },
    });
    const target = {
      repository: "felixjichao/symphony-ts",
      prNumber: 153,
      headSha: "b".repeat(40),
    };
    const verdict = verdictFor({
      stage: "delivery",
      expectedAction: {
        action: "compensate",
        description: "compensate handoff h-1",
        authority: { kind: "internal", authority: "delivery" },
        target,
        handoffRef: { handoffId: "h-1" },
      },
      fence: { expectedHeadSha: target.headSha, hasLeaseToken: false },
    });

    const outcome = await adapter.recover(request(verdict));

    expect(outcome.kind).toBe("applied");
    expect(calls[0]).toMatchObject({
      workKey,
      handoffId: "h-1",
      expectedHeadSha: target.headSha,
      idempotencyKey: "fp-1",
    });
  });

  it("refuses Delivery compensation without a handoff id", async () => {
    const adapter = createDeliveryRecoveryAuthority({
      compensateHandoff: async () => ({ kind: "applied" }),
    });
    const verdict = verdictFor({
      stage: "delivery",
      expectedAction: {
        action: "resume",
        description: "resume delivery",
        authority: { kind: "internal", authority: "delivery" },
      },
    });

    const outcome = await adapter.recover(request(verdict));
    expect(outcome.kind).toBe("unavailable");
  });

  it("only exposes the authority names the coordinator routes on", () => {
    const noopOrchestrator = createOrchestratorRecoveryAuthority({
      dispatchWork: async () => ({ kind: "applied" }),
    });
    const noopDecision = createDecisionRecoveryAuthority({
      releaseExpiredClaim: async () => ({ kind: "released" }),
    });
    const noopDelivery = createDeliveryRecoveryAuthority({
      compensateHandoff: async () => ({ kind: "applied" }),
    });
    expect([noopOrchestrator.authority, noopDecision.authority, noopDelivery.authority]).toEqual([
      "orchestrator",
      "decision",
      "delivery",
    ]);
  });
});
