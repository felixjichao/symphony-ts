import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CONTINUITY_SCOPES,
  CONTINUITY_STATES,
  FAILURE_CATEGORIES,
  FAILURE_REASONS,
  OWNERSHIP_FENCE_DIMENSIONS,
  RECOVERY_ACTIONS,
  CanonicalStageDescriptors,
  isTerminalContinuityState,
  isActiveContinuityState,
  mapDecisionAdapterFailure,
  mapDeliveryFailure,
  mapDeliveryHandoffReason,
  mapOrchestratorFailure,
  mapWebDriverFailure,
  sanitizeOwnershipFence,
  validateActionAuthority,
  validateContinuityDescriptor,
  validateOwnershipFence,
  type ExecutionContinuityDescriptor,
  type OwnershipFence,
  type OwnershipFenceDimension,
} from "./index";
import { githubWorkKey } from "./operations-facts";

describe("Execution Continuity Contracts", () => {
  it("classifies evidence failures explicitly without treating generic execution errors as safe retries", () => {
    expect(mapDecisionAdapterFailure({ code: "evidence_unavailable", message: "Missing diff" })).toMatchObject({
      mapped: true, diagnostic: { category: "recoverable", reason: "evidence_unavailable", suggestedAction: "retry" },
    });
    expect(mapDecisionAdapterFailure({ code: "execution_failed", message: "Unknown" }).mapped).toBe(false);
  });

  const dummyWorkKey = githubWorkKey("felixjichao", "symphony-ts", 146);
  const now = 1770000000000;

  describe("Enumerations and State Predicates", () => {
    it("defines the minimal set of continuity scopes", () => {
      expect(CONTINUITY_SCOPES).toEqual(["work", "task", "attempt", "binding"]);
    });

    it("defines the provider-neutral continuity states", () => {
      expect(CONTINUITY_STATES).toEqual([
        "running",
        "retry_queued",
        "recovering",
        "blocked",
        "completed",
        "released",
      ]);
    });

    it("distinguishes blocked as first-class non-terminal state", () => {
      expect(isTerminalContinuityState("blocked")).toBe(false);
      expect(isTerminalContinuityState("completed")).toBe(true);
      expect(isTerminalContinuityState("released")).toBe(true);
      expect(isTerminalContinuityState("running")).toBe(false);
      expect(isTerminalContinuityState("retry_queued")).toBe(false);
      expect(isTerminalContinuityState("recovering")).toBe(false);
    });

    it("identifies active continuity states", () => {
      expect(isActiveContinuityState("running")).toBe(true);
      expect(isActiveContinuityState("retry_queued")).toBe(true);
      expect(isActiveContinuityState("recovering")).toBe(true);
      expect(isActiveContinuityState("blocked")).toBe(false);
      expect(isActiveContinuityState("completed")).toBe(false);
      expect(isActiveContinuityState("released")).toBe(false);
    });

    it("defines standard recovery actions", () => {
      expect(RECOVERY_ACTIONS).toContain("none");
      expect(RECOVERY_ACTIONS).toContain("dispatch");
      expect(RECOVERY_ACTIONS).toContain("resume");
      expect(RECOVERY_ACTIONS).toContain("retry");
      expect(RECOVERY_ACTIONS).toContain("rebind");
      expect(RECOVERY_ACTIONS).toContain("reclaim");
      expect(RECOVERY_ACTIONS).toContain("compensate");
      expect(RECOVERY_ACTIONS).toContain("await_external");
      expect(RECOVERY_ACTIONS).toContain("require_human");
    });

    it("defines failure categories and concrete reasons", () => {
      expect(FAILURE_CATEGORIES).toEqual([
        "transient",
        "recoverable",
        "blocked_external",
        "superseded",
        "invariant_violation",
      ]);
      expect(FAILURE_REASONS).toContain("network_timeout");
      expect(FAILURE_REASONS).toContain("bridge_unavailable");
      expect(FAILURE_REASONS).toContain("stale_binding");
      expect(FAILURE_REASONS).toContain("stale_claim");
      expect(FAILURE_REASONS).toContain("navigation_lost");
      expect(FAILURE_REASONS).toContain("process_stalled");
      expect(FAILURE_REASONS).toContain("incomplete_handoff");
      expect(FAILURE_REASONS).toContain("auth_required");
      expect(FAILURE_REASONS).toContain("human_required");
      expect(FAILURE_REASONS).toContain("stale_head");
      expect(FAILURE_REASONS).toContain("stale_task");
      expect(FAILURE_REASONS).toContain("stale_generation");
      expect(FAILURE_REASONS).toContain("conflicting_owner");
      expect(FAILURE_REASONS).toContain("impossible_transition");
      expect(FAILURE_REASONS).toContain("ci_checks_pending");
      expect(FAILURE_REASONS).toContain("unmapped");
    });

    it("validates action authority structures directly", () => {
      expect(validateActionAuthority({ kind: "internal", authority: "delivery" })).toEqual({
        valid: true,
      });
      expect(validateActionAuthority({ kind: "internal", authority: "   " })).toEqual({
        valid: false,
        reason: "Internal action authority must specify a non-empty authority name",
      });
      expect(validateActionAuthority(null)).toEqual({
        valid: false,
        reason: "Action authority must be an object",
      });
    });
  });

  describe("Multi-dimensional Ownership Fencing", () => {
    const baseFence: OwnershipFence = {
      lifecycleGeneration: 3,
      reconciliationEpoch: 5,
      leaseGeneration: 2,
      bindingGeneration: 4,
      expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      retryToken: "token-attempt-3",
      leaseToken: "secret-lease-uuid-xyz",
    };

    it("exports all 7 ownership fence dimensions", () => {
      const dimensions: readonly OwnershipFenceDimension[] = OWNERSHIP_FENCE_DIMENSIONS;
      expect(dimensions).toHaveLength(7);
      expect(dimensions).toContain("lifecycleGeneration");
      expect(dimensions).toContain("reconciliationEpoch");
      expect(dimensions).toContain("leaseGeneration");
      expect(dimensions).toContain("bindingGeneration");
      expect(dimensions).toContain("expectedHeadSha");
      expect(dimensions).toContain("retryToken");
      expect(dimensions).toContain("leaseToken");
    });

    it("sanitizes ownership fence for safe public observation", () => {
      const sanitized = sanitizeOwnershipFence(baseFence);
      expect(sanitized.hasLeaseToken).toBe(true);
      expect("leaseToken" in sanitized).toBe(false);
      expect(sanitized.lifecycleGeneration).toBe(3);
      expect(sanitized.expectedHeadSha).toBe(baseFence.expectedHeadSha);

      const emptySanitized = sanitizeOwnershipFence({});
      expect(emptySanitized.hasLeaseToken).toBe(false);
    });

    it("validates exact-match continuation credentials across all applicable dimensions", () => {
      const candidate: OwnershipFence = { ...baseFence };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(true);
    });

    it("fails closed when candidate lacks required authoritative dimensions", () => {
      const current: OwnershipFence = {
        leaseToken: "current",
        bindingGeneration: 4,
        expectedHeadSha: "new",
      };
      const candidate: OwnershipFence = {};
      const result = validateOwnershipFence(current, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason.startsWith("missing_")).toBe(true);
      }
    });

    it("rejects candidate with missing lifecycleGeneration", () => {
      const { lifecycleGeneration: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_lifecycle_generation");
    });

    it("rejects candidate with missing reconciliationEpoch", () => {
      const { reconciliationEpoch: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_reconciliation_epoch");
    });

    it("rejects candidate with missing leaseGeneration", () => {
      const { leaseGeneration: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_lease_generation");
    });

    it("rejects candidate with missing bindingGeneration", () => {
      const { bindingGeneration: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_binding_generation");
    });

    it("rejects candidate with missing expectedHeadSha", () => {
      const { expectedHeadSha: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_expected_head_sha");
    });

    it("rejects candidate with missing retryToken", () => {
      const { retryToken: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_retry_token");
    });

    it("rejects candidate with missing leaseToken", () => {
      const { leaseToken: _, ...candidate } = baseFence;
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("missing_lease_token");
    });

    it("rejects superseded lifecycle generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        lifecycleGeneration: 2,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("superseded_lifecycle_generation");
      }
    });

    it("rejects ahead / overshot lifecycle generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        lifecycleGeneration: 4,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_lifecycle_generation");
      }
    });

    it("rejects superseded reconciliation epoch", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        reconciliationEpoch: 4,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("superseded_reconciliation_epoch");
      }
    });

    it("rejects ahead / overshot reconciliation epoch", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        reconciliationEpoch: 6,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_reconciliation_epoch");
      }
    });

    it("rejects superseded lease generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        leaseGeneration: 1,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("superseded_lease_generation");
      }
    });

    it("rejects ahead / overshot lease generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        leaseGeneration: 3,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_lease_generation");
      }
    });

    it("rejects superseded binding generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        bindingGeneration: 3,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("superseded_binding_generation");
      }
    });

    it("rejects ahead / overshot binding generation", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        bindingGeneration: 5,
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_binding_generation");
      }
    });

    it("rejects stale HEAD SHA", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        expectedHeadSha: "old-sha-0000000000000000000000000000000000",
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("stale_head_sha");
      }
    });

    it("rejects conflicting retry token", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        retryToken: "different-retry-token",
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_retry_token");
      }
    });

    it("rejects conflicting lease token", () => {
      const candidate: OwnershipFence = {
        ...baseFence,
        leaseToken: "wrong-lease-token",
      };
      const result = validateOwnershipFence(baseFence, candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("conflicting_lease_token");
      }
    });

    it("honors explicitly requested applicableDimensions", () => {
      const current: OwnershipFence = {
        bindingGeneration: 4,
        leaseToken: "tok-1",
        retryToken: "ret-1",
      };
      const candidate: OwnershipFence = { bindingGeneration: 4 };
      expect(validateOwnershipFence(current, candidate, ["bindingGeneration"]).valid).toBe(true);

      const failedResult = validateOwnershipFence(current, candidate, ["leaseToken"]);
      expect(failedResult.valid).toBe(false);
      if (!failedResult.valid) {
        expect(failedResult.reason).toBe("missing_lease_token");
      }
    });

    describe("fail-closed on dual-sided missing dimensions", () => {
      it.each([
        ["lifecycleGeneration", "missing_lifecycle_generation"],
        ["reconciliationEpoch", "missing_reconciliation_epoch"],
        ["leaseGeneration", "missing_lease_generation"],
        ["bindingGeneration", "missing_binding_generation"],
        ["expectedHeadSha", "missing_expected_head_sha"],
        ["retryToken", "missing_retry_token"],
        ["leaseToken", "missing_lease_token"],
      ] as const)("rejects dual-sided missing %s with %s", (dimension, expectedReason) => {
        const result = validateOwnershipFence({}, {}, [dimension]);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
          expect(result.details).toContain(`Both authoritative fence and candidate are missing required ${dimension}`);
        }
      });
    });

    describe("fail-closed on authoritative-missing dimensions", () => {
      const sampleValues: Record<OwnershipFenceDimension, OwnershipFence> = {
        lifecycleGeneration: { lifecycleGeneration: 3 },
        reconciliationEpoch: { reconciliationEpoch: 5 },
        leaseGeneration: { leaseGeneration: 2 },
        bindingGeneration: { bindingGeneration: 4 },
        expectedHeadSha: { expectedHeadSha: "sha-1234567890abcdef1234567890abcdef" },
        retryToken: { retryToken: "ret-1" },
        leaseToken: { leaseToken: "tok-1" },
      };

      it.each([
        ["lifecycleGeneration", "missing_authoritative_lifecycle_generation"],
        ["reconciliationEpoch", "missing_authoritative_reconciliation_epoch"],
        ["leaseGeneration", "missing_authoritative_lease_generation"],
        ["bindingGeneration", "missing_authoritative_binding_generation"],
        ["expectedHeadSha", "missing_authoritative_expected_head_sha"],
        ["retryToken", "missing_authoritative_retry_token"],
        ["leaseToken", "missing_authoritative_lease_token"],
      ] as const)("rejects candidate-provided but authoritative-missing %s with %s", (dimension, expectedReason) => {
        const candidate = sampleValues[dimension];
        const result = validateOwnershipFence({}, candidate, [dimension]);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
        }
      });

      it("rejects multi-dimension fence when authoritative lacks one of the required dimensions", () => {
        const current: OwnershipFence = { leaseGeneration: 2 };
        const candidate: OwnershipFence = { leaseGeneration: 2 };
        const result = validateOwnershipFence(current, candidate, ["leaseGeneration", "leaseToken"]);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("missing_lease_token");
        }
      });

      it("rejects candidate providing extra dimension when authoritative fence has none (inferred dimensions)", () => {
        const current: OwnershipFence = { leaseGeneration: 2 };
        const candidate: OwnershipFence = { leaseGeneration: 2, leaseToken: "tok-1" };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("missing_authoritative_lease_token");
        }
      });
    });

    describe("safe non-negative integer validation for numeric generation/epoch dimensions", () => {
      it.each([
        ["lifecycleGeneration", "conflicting_lifecycle_generation"],
        ["reconciliationEpoch", "conflicting_reconciliation_epoch"],
        ["leaseGeneration", "conflicting_lease_generation"],
        ["bindingGeneration", "conflicting_binding_generation"],
      ] as const)("rejects NaN candidate %s with %s", (dimension, expectedReason) => {
        const current: OwnershipFence = { [dimension]: 4 };
        const candidate: OwnershipFence = { [dimension]: Number.NaN };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
          expect(result.details).toContain("Candidate has invalid non-integer or negative");
        }
      });

      it.each([
        ["lifecycleGeneration", "conflicting_lifecycle_generation"],
        ["reconciliationEpoch", "conflicting_reconciliation_epoch"],
        ["leaseGeneration", "conflicting_lease_generation"],
        ["bindingGeneration", "conflicting_binding_generation"],
      ] as const)("rejects negative candidate %s with %s", (dimension, expectedReason) => {
        const current: OwnershipFence = { [dimension]: 4 };
        const candidate: OwnershipFence = { [dimension]: -1 };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
        }
      });

      it.each([
        ["lifecycleGeneration", "conflicting_lifecycle_generation"],
        ["reconciliationEpoch", "conflicting_reconciliation_epoch"],
        ["leaseGeneration", "conflicting_lease_generation"],
        ["bindingGeneration", "conflicting_binding_generation"],
      ] as const)("rejects non-integer float candidate %s with %s", (dimension, expectedReason) => {
        const current: OwnershipFence = { [dimension]: 4 };
        const candidate: OwnershipFence = { [dimension]: 4.5 };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
        }
      });

      it.each([
        ["lifecycleGeneration", "conflicting_lifecycle_generation"],
        ["reconciliationEpoch", "conflicting_reconciliation_epoch"],
        ["leaseGeneration", "conflicting_lease_generation"],
        ["bindingGeneration", "conflicting_binding_generation"],
      ] as const)("rejects Infinity candidate %s with %s", (dimension, expectedReason) => {
        const current: OwnershipFence = { [dimension]: 4 };
        const candidate: OwnershipFence = { [dimension]: Number.POSITIVE_INFINITY };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(expectedReason);
        }
      });

      it("rejects authoritative fence with NaN bindingGeneration", () => {
        const current: OwnershipFence = { bindingGeneration: Number.NaN };
        const candidate: OwnershipFence = { bindingGeneration: 4 };
        const result = validateOwnershipFence(current, candidate);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe("conflicting_binding_generation");
          expect(result.details).toContain("Authoritative fence has invalid non-integer or negative");
        }
      });
    });
  });

  describe("Subsystem Failure Taxonomy Mappings", () => {
    describe("Decision Adapter Failures", () => {
      it("maps binding_broken to recoverable / stale_binding / rebind", () => {
        const result = mapDecisionAdapterFailure({
          code: "binding_broken",
          message: "WebSocket connection dropped",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("recoverable");
        expect(result.diagnostic.reason).toBe("stale_binding");
        expect(result.diagnostic.suggestedAction).toBe("rebind");
      });

      it("maps human_required to blocked_external / human_required / require_human", () => {
        const result = mapDecisionAdapterFailure({
          code: "human_required",
          message: "Operator CAPTCHA required",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("blocked_external");
        expect(result.diagnostic.reason).toBe("human_required");
        expect(result.diagnostic.suggestedAction).toBe("require_human");
      });

      it("returns unmapped for bare revision_mismatch without authoritative superseded proof", () => {
        const result = mapDecisionAdapterFailure({
          code: "revision_mismatch",
          message: "Result revision 2 did not match task revision 1",
          details: { expectedRevision: 1, actualRevision: 2 },
        });
        expect(result.mapped).toBe(false);
        if (!result.mapped) {
          expect(result.gapReason).toContain("does not prove task is superseded");
          expect(result.diagnostic.category).toBe("invariant_violation");
          expect(result.diagnostic.reason).toBe("unmapped");
        }
      });

      it("maps revision_mismatch to superseded when authoritative proof is present", () => {
        const result = mapDecisionAdapterFailure({
          code: "revision_mismatch",
          message: "Task revision 1 is superseded",
          details: { taskSuperseded: true },
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("superseded");
        expect(result.diagnostic.reason).toBe("stale_generation");
        expect(result.diagnostic.suggestedAction).toBe("none");
      });

      it("maps task_mismatch when superseded evidence is present", () => {
        const result = mapDecisionAdapterFailure({
          code: "task_mismatch",
          message: "Task superseded",
          details: { superseded: true },
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("superseded");
        expect(result.diagnostic.reason).toBe("stale_task");
      });

      it("returns unmapped for task_mismatch without status context", () => {
        const result = mapDecisionAdapterFailure({
          code: "task_mismatch",
          message: "Task mismatch without context",
        });
        expect(result.mapped).toBe(false);
        if (!result.mapped) {
          expect(result.gapReason).toContain("task_mismatch requires contextual comparison");
          expect(result.diagnostic.reason).toBe("unmapped");
        }
      });

      it("returns unmapped for target_mismatch when only output extraction differs without authoritative proof", () => {
        const result = mapDecisionAdapterFailure({
          code: "target_mismatch",
          message: "Review result filled wrong HEAD SHA",
          details: {
            expectedHeadSha: "sha-old",
            actualHeadSha: "sha-wrong-output",
          },
        });
        expect(result.mapped).toBe(false);
        if (!result.mapped) {
          expect(result.gapReason).toContain("does not prove GitHub HEAD changed");
          expect(result.diagnostic.category).toBe("invariant_violation");
          expect(result.diagnostic.reason).toBe("unmapped");
        }
      });

      it("maps target_mismatch to superseded / stale_head when authoritative HEAD changed", () => {
        const result = mapDecisionAdapterFailure({
          code: "target_mismatch",
          message: "Review target HEAD changed on GitHub",
          details: {
            expectedHeadSha: "sha-old",
            authoritativeHeadSha: "sha-new",
          },
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("superseded");
        expect(result.diagnostic.reason).toBe("stale_head");
        expect(result.diagnostic.suggestedAction).toBe("none");
      });

      it("maps target_mismatch with PR difference to invariant_violation / impossible_transition", () => {
        const result = mapDecisionAdapterFailure({
          code: "target_mismatch",
          message: "PR mismatch",
          details: {
            expectedPrNumber: 10,
            actualPrNumber: 11,
          },
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("invariant_violation");
        expect(result.diagnostic.reason).toBe("impossible_transition");
      });

      it("returns explicit unmapped for generic execution_failed and malformed_output without guessing transient", () => {
        const failedResult = mapDecisionAdapterFailure({
          code: "execution_failed",
          message: "Some unknown internal error",
        });
        expect(failedResult.mapped).toBe(false);
        if (!failedResult.mapped) {
          expect(failedResult.gapReason).toContain("must not be blindly defaulted to transient");
        }

        const malformedResult = mapDecisionAdapterFailure({
          code: "malformed_output",
          message: "Invalid JSON from LLM",
        });
        expect(malformedResult.mapped).toBe(false);
        if (!malformedResult.mapped) {
          expect(malformedResult.gapReason).toContain("cannot determine transient vs permanent");
        }
      });

      it("maps unsupported strategy or task kind to invariant_violation", () => {
        const result = mapDecisionAdapterFailure({
          code: "unsupported_task_kind",
          message: "Invalid task kind",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("invariant_violation");
      });
    });

    describe("Delivery Failures and Handoffs", () => {
      it("maps network and timeout errors to transient / network_timeout", () => {
        const netResult = mapDeliveryFailure({
          code: "network_failure",
          message: "GitHub API timeout",
        });
        expect(netResult.mapped).toBe(true);
        expect(netResult.diagnostic.category).toBe("transient");
        expect(netResult.diagnostic.reason).toBe("network_timeout");
        expect(netResult.diagnostic.suggestedAction).toBe("retry");

        const rateResult = mapDeliveryFailure({
          code: "rate_limited",
          message: "Secondary rate limit encountered",
        });
        expect(rateResult.mapped).toBe(true);
        expect(rateResult.diagnostic.category).toBe("transient");
        expect(rateResult.diagnostic.suggestedAction).toBe("await_external");
      });

      it("maps auth failure to blocked_external / auth_required / require_human", () => {
        const authResult = mapDeliveryFailure({
          code: "auth_failure",
          message: "Bad credentials for repository",
        });
        expect(authResult.mapped).toBe(true);
        expect(authResult.diagnostic.category).toBe("blocked_external");
        expect(authResult.diagnostic.reason).toBe("auth_required");
        expect(authResult.diagnostic.suggestedAction).toBe("require_human");
      });

      it("maps head_changed to superseded / stale_head / none", () => {
        const headResult = mapDeliveryFailure({
          code: "head_changed",
          message: "Remote branch updated with new commit",
        });
        expect(headResult.mapped).toBe(true);
        expect(headResult.diagnostic.category).toBe("superseded");
        expect(headResult.diagnostic.reason).toBe("stale_head");
        expect(headResult.diagnostic.suggestedAction).toBe("none");
      });

      it("maps ownership refusal with multiple markers to invariant_violation / conflicting_owner", () => {
        const multiResult = mapDeliveryFailure({
          code: "ownership_refusal",
          message: "Conflicting multiple markers found in PR body",
          details: { reason: "conflicting_multiple_markers_found" },
        });
        expect(multiResult.mapped).toBe(true);
        expect(multiResult.diagnostic.category).toBe("invariant_violation");
        expect(multiResult.diagnostic.reason).toBe("conflicting_owner");
      });

      it("maps checks_waiting to blocked_external / ci_checks_pending / await_external", () => {
        const waitResult = mapDeliveryFailure({
          code: "checks_waiting",
          message: "CI suites in progress",
        });
        expect(waitResult.mapped).toBe(true);
        expect(waitResult.diagnostic.category).toBe("blocked_external");
        expect(waitResult.diagnostic.reason).toBe("ci_checks_pending");
        expect(waitResult.diagnostic.reason).not.toBe("auth_required");
        expect(waitResult.diagnostic.suggestedAction).toBe("await_external");
      });

      it("maps delivery handoff reasons correctly", () => {
        const budgetResult = mapDeliveryHandoffReason({
          reason: "budget_exhausted",
          details: "Max repairs reached",
        });
        expect(budgetResult.mapped).toBe(true);
        expect(budgetResult.diagnostic.category).toBe("blocked_external");
        expect(budgetResult.diagnostic.suggestedAction).toBe("require_human");

        const foreignConflict = mapDeliveryHandoffReason({
          reason: "foreign_pr_conflict",
          details: "PR belongs to another task",
        });
        expect(foreignConflict.mapped).toBe(true);
        expect(foreignConflict.diagnostic.category).toBe("invariant_violation");
        expect(foreignConflict.diagnostic.reason).toBe("conflicting_owner");

        const reconcilResult = mapDeliveryHandoffReason({
          reason: "reconciliation_needed",
          details: "Handoff paused state must be reconciled",
        });
        expect(reconcilResult.mapped).toBe(true);
        expect(reconcilResult.diagnostic.category).toBe("recoverable");
        expect(reconcilResult.diagnostic.reason).toBe("incomplete_handoff");
        expect(reconcilResult.diagnostic.suggestedAction).toBe("compensate");
      });
    });

    describe("Web Driver Failures", () => {
      it("maps navigation_lost to recoverable / navigation_lost / rebind", () => {
        const result = mapWebDriverFailure({
          errorKind: "navigation_lost",
          message: "Page navigated away unexpectedly",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("recoverable");
        expect(result.diagnostic.reason).toBe("navigation_lost");
        expect(result.diagnostic.suggestedAction).toBe("rebind");
      });

      it("maps bridge_unavailable to transient / bridge_unavailable / retry", () => {
        const result = mapWebDriverFailure({
          errorKind: "bridge_unavailable",
          message: "Connection refused to localhost:8765",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("transient");
        expect(result.diagnostic.reason).toBe("bridge_unavailable");
        expect(result.diagnostic.suggestedAction).toBe("retry");
      });

      it("maps checkpoint_mismatch to superseded / stale_generation / none", () => {
        const result = mapWebDriverFailure({
          errorKind: "checkpoint_mismatch",
          message: "Checkpoint belongs to older generation",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("superseded");
        expect(result.diagnostic.reason).toBe("stale_generation");
      });

      it("records explicit gap for unknown web error kind", () => {
        const result = mapWebDriverFailure({
          errorKind: "mysterious_dom_error",
          message: "Something broke",
        });
        expect(result.mapped).toBe(false);
        if (!result.mapped) {
          expect(result.gapReason).toContain("unknown web driver error kind");
        }
      });
    });

    describe("Orchestrator Failures", () => {
      it("maps process_stalled to recoverable / process_stalled / retry", () => {
        const result = mapOrchestratorFailure({
          failureKind: "process_stalled",
          message: "No progress events recorded within stall_timeout_ms",
        });
        expect(result.mapped).toBe(true);
        expect(result.diagnostic.category).toBe("recoverable");
        expect(result.diagnostic.reason).toBe("process_stalled");
        expect(result.diagnostic.suggestedAction).toBe("retry");
      });

      it("maps stale_generation and cancelled_by_reconciliation to superseded", () => {
        const genResult = mapOrchestratorFailure({
          failureKind: "stale_generation",
          message: "Attempt generation superseded",
        });
        expect(genResult.mapped).toBe(true);
        expect(genResult.diagnostic.category).toBe("superseded");

        const cancelResult = mapOrchestratorFailure({
          failureKind: "cancelled_by_reconciliation",
          message: "Issue state reconciled as terminal",
        });
        expect(cancelResult.mapped).toBe(true);
        expect(cancelResult.diagnostic.category).toBe("superseded");
      });

      it("maps retry_limit to blocked_external / human_required / require_human", () => {
        const limitResult = mapOrchestratorFailure({
          failureKind: "retry_limit",
          message: "Max orchestrator retry attempts exceeded",
        });
        expect(limitResult.mapped).toBe(true);
        expect(limitResult.diagnostic.category).toBe("blocked_external");
        expect(limitResult.diagnostic.suggestedAction).toBe("require_human");
      });
    });
  });

  describe("Execution Continuity Descriptors & Invariant Validation", () => {
    it("validates all canonical stage descriptors", () => {
      const planning = CanonicalStageDescriptors.createPlanningDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 5000,
        sessionId: "sess-1",
        taskId: "task-1",
        revision: 1,
        bindingGeneration: 1,
      });
      expect(validateContinuityDescriptor(planning)).toEqual({ valid: true });

      const coding = CanonicalStageDescriptors.createCodingDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 10000,
        attempt: 1,
        retryToken: "rt-1",
        lifecycleGeneration: 1,
      });
      expect(validateContinuityDescriptor(coding)).toEqual({ valid: true });

      const ciWait = CanonicalStageDescriptors.createCiWaitingDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 20000,
        prNumber: 42,
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
      });
      expect(validateContinuityDescriptor(ciWait)).toEqual({ valid: true });

      const reviewClaim = CanonicalStageDescriptors.createReviewClaimDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 5000,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
        taskId: "rev-task-1",
        revision: 1,
      });
      expect(validateContinuityDescriptor(reviewClaim)).toEqual({ valid: true });

      const repair = CanonicalStageDescriptors.createRepairDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 3000,
        attempt: 2,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
        retryToken: "rt-2",
      });
      expect(validateContinuityDescriptor(repair)).toEqual({ valid: true });

      const deliveryResume = CanonicalStageDescriptors.createDeliveryResumeDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 8000,
        handoffId: "handoff-xyz",
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
      });
      expect(validateContinuityDescriptor(deliveryResume)).toEqual({ valid: true });

      const merge = CanonicalStageDescriptors.createMergeConfirmationDescriptor({
        workKey: dummyWorkKey,
        observedAt: now,
        startedAt: now - 1000,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
      });
      expect(validateContinuityDescriptor(merge)).toEqual({ valid: true });
      expect(merge.liveness.lastProgressAt).toBe("unknown");
    });

    it("merge confirmation descriptor does not conflate repeated observations with progress (defaults to unknown)", () => {
      const obs1 = CanonicalStageDescriptors.createMergeConfirmationDescriptor({
        workKey: dummyWorkKey,
        observedAt: 2,
        startedAt: 1,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
      });
      const obs2 = CanonicalStageDescriptors.createMergeConfirmationDescriptor({
        workKey: dummyWorkKey,
        observedAt: 3,
        startedAt: 1,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
      });
      expect(obs1.liveness.lastProgressAt).toBe("unknown");
      expect(obs2.liveness.lastProgressAt).toBe("unknown");
      expect(obs1.liveness.lastObservedAt).toBe(2);
      expect(obs2.liveness.lastObservedAt).toBe(3);

      const withProgress = CanonicalStageDescriptors.createMergeConfirmationDescriptor({
        workKey: dummyWorkKey,
        observedAt: 3,
        startedAt: 1,
        lastProgressAt: 2,
        target: { repository: "felixjichao/symphony-ts", prNumber: 42, headSha: "abcdef1234567890abcdef1234567890abcdef12" },
      });
      expect(withProgress.liveness.lastProgressAt).toBe(2);
      expect(withProgress.liveness.lastObservedAt).toBe(3);
    });

    it("enforces Invariant 1: active state must specify expectedNextAction", () => {
      const invalidActive: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "work",
        state: "running",
        expectedAction: null,
        liveness: { startedAt: now - 1000, lastProgressAt: "unknown", lastObservedAt: now },
        fence: { hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(invalidActive);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.invariant).toBe(1);
        expect(result.reason).toContain("must specify an expectedNextAction");
      }
    });

    it("enforces Invariant 2: expected action must have a non-empty authority", () => {
      const emptyInternalAuthority: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "task",
        state: "running",
        expectedAction: {
          action: "dispatch",
          description: "No authority specified",
          authority: { kind: "internal", authority: "   " },
        },
        liveness: { startedAt: now - 1000, lastProgressAt: "unknown", lastObservedAt: now },
        fence: { hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(emptyInternalAuthority);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.invariant).toBe(2);
        expect(result.reason).toContain("must specify a non-empty authority name");
      }
    });

    it("enforces Invariant 3: blocked state requires blockedDetails", () => {
      const missingBlockedDetails: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "work",
        state: "blocked",
        expectedAction: {
          action: "await_external",
          description: "Waiting for CI",
          authority: { kind: "external", system: "ci", condition: "green" },
        },
        liveness: { startedAt: now - 1000, lastProgressAt: "unknown", lastObservedAt: now },
        fence: { hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(missingBlockedDetails);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.invariant).toBe(3);
        expect(result.reason).toContain("must provide blockedDetails");
      }
    });

    it("enforces Invariant 3: rejects blocked state with blank reason, blank unblockCondition, or invalid authority", () => {
      const reproducedReviewerCase: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "work",
        state: "blocked",
        expectedAction: null,
        blockedDetails: {
          reason: "",
          waitingOn: { kind: "internal", authority: "" },
          unblockCondition: "",
          blockedAt: 2,
        },
        liveness: { startedAt: 1, lastProgressAt: "unknown", lastObservedAt: 2 },
        fence: { hasLeaseToken: false },
      };
      const res1 = validateContinuityDescriptor(reproducedReviewerCase);
      expect(res1.valid).toBe(false);
      if (!res1.valid) {
        expect(res1.invariant).toBe(3);
        expect(res1.reason).toContain("blockedDetails must specify a non-empty reason");
      }

      const blankUnblockCase: ExecutionContinuityDescriptor = {
        ...reproducedReviewerCase,
        blockedDetails: {
          ...reproducedReviewerCase.blockedDetails!,
          reason: "ci_checks_pending",
          unblockCondition: "   ",
        },
      };
      const res2 = validateContinuityDescriptor(blankUnblockCase);
      expect(res2.valid).toBe(false);
      if (!res2.valid) {
        expect(res2.invariant).toBe(3);
        expect(res2.reason).toContain("blockedDetails must specify a non-empty unblockCondition");
      }

      const invalidWaitingOnCase: ExecutionContinuityDescriptor = {
        ...reproducedReviewerCase,
        blockedDetails: {
          ...reproducedReviewerCase.blockedDetails!,
          reason: "ci_checks_pending",
          unblockCondition: "CI checks green",
          waitingOn: { kind: "internal", authority: "   " },
        },
      };
      const res3 = validateContinuityDescriptor(invalidWaitingOnCase);
      expect(res3.valid).toBe(false);
      if (!res3.valid) {
        expect(res3.invariant).toBe(3);
        expect(res3.reason).toContain("Internal action authority must specify a non-empty authority name");
      }
    });

    it("enforces Invariant 4: retry_queued state must specify a re-evaluating recovery action", () => {
      const invalidRetryAction: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "attempt",
        state: "retry_queued",
        expectedAction: {
          action: "none", // invalid: retry_queued requires retry, reclaim, resume, or rebind!
          description: "Blind waiting",
          authority: { kind: "internal", authority: "orchestrator" },
        },
        liveness: { startedAt: now - 1000, lastProgressAt: "unknown", lastObservedAt: now },
        fence: { hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(invalidRetryAction);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.invariant).toBe(4);
        expect(result.reason).toContain("re-evaluating recovery action");
      }
    });

    it("enforces Invariant 5: fencing generations and epochs cannot be negative", () => {
      const negativeFence: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "work",
        state: "completed",
        expectedAction: null,
        liveness: { startedAt: now - 1000, lastProgressAt: now, lastObservedAt: now },
        fence: { lifecycleGeneration: -1, hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(negativeFence);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.invariant).toBe(5);
        expect(result.reason).toContain("cannot be negative");
      }
    });

    it("enforces liveness timestamps cannot be in the future of lastObservedAt", () => {
      const futureStarted: ExecutionContinuityDescriptor = {
        workKey: dummyWorkKey,
        scope: "work",
        state: "completed",
        expectedAction: null,
        liveness: { startedAt: now + 5000, lastProgressAt: "unknown", lastObservedAt: now },
        fence: { hasLeaseToken: false },
      };
      const result = validateContinuityDescriptor(futureStarted);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain("cannot be in the future of lastObservedAt");
      }
    });
  });

  describe("Architectural and Boundary Invariants", () => {
    it("ensures execution continuity contracts are pure domain definitions without Node I/O or UI framework dependencies", () => {
      const fileUrl = new URL("./execution-continuity.ts", import.meta.url);
      const source = readFileSync(fileUrl, "utf8");
      const ast = ts.createSourceFile("execution-continuity.ts", source, ts.ScriptTarget.Latest, true);

      let importCount = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
          importCount++;
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            // Must strictly import from sibling relative domain files only
            expect(node.moduleSpecifier.text.startsWith("./")).toBe(true);
            expect(node.moduleSpecifier.text).not.toContain("node:");
            expect(node.moduleSpecifier.text).not.toContain("react");
            expect(node.moduleSpecifier.text).not.toContain("vue");
          }
        }
        if (ts.isCallExpression(node)) {
          if (ts.isIdentifier(node.expression)) {
            expect(["fetch", "setTimeout", "setInterval", "queueMicrotask", "eval"]).not.toContain(
              node.expression.text,
            );
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(ast);
      expect(importCount).toBeGreaterThan(0);
      expect(source).not.toContain("window");
      expect(source).not.toContain("document");
    });
  });
});
