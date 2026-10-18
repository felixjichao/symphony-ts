/**
 * Concrete recovery-authority adapters for work-level reconciliation (NEST-137 / #147).
 *
 * Each adapter is the only place where a `WorkRecoveryDecision` becomes a mutation, and
 * every adapter delegates to a **port implemented by the authority that owns the state**.
 * The coordinator therefore never imports a Decision store, an orchestrator runtime map, or
 * a Delivery state file, and a missing port is reported as `unavailable` instead of being
 * replaced by a direct write.
 *
 * The ports are structural on purpose: `apps/cli` (or any composition root) can satisfy them
 * with the real authority without creating a production dependency from
 * `@symphony/orchestrator` to `@symphony/decision` or `@symphony/agent`.
 */
import type { SafeOwnershipFence, WorkKey } from "@symphony/domain";

import type { WorkRecoveryAuthority, WorkRecoveryOutcome, WorkRecoveryRequest } from "./work-continuity";

/** Orchestrator-side commit port: dispatch after the authority re-validates eligibility. */
export interface OrchestratorRecoveryPort {
  /**
   * Dispatch the work item's issue under the orchestrator's existing claim / running /
   * slot checks. Implementations MUST re-read the issue and MUST return `skipped` (not
   * throw) when the work item already has an owner.
   */
  dispatchWork(input: {
    readonly workKey: WorkKey;
    readonly expectedFence: SafeOwnershipFence;
    readonly idempotencyKey: string;
  }): Promise<WorkRecoveryOutcome>;
}

/**
 * Decision-side commit port: release one expired claim.
 *
 * Mirrors `DecisionService.releaseExpiredClaim` after NEST-137; `superseded` is a normal
 * race outcome (lease renewed / generation advanced) and must not be retried.
 */
export interface DecisionClaimRecoveryPort {
  releaseExpiredClaim(input: {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly expectedClaimGeneration: number;
  }): Promise<
    | { readonly kind: "released" }
    | { readonly kind: "not_expired" }
    | { readonly kind: "superseded"; readonly reason: string }
    | { readonly kind: "not_found" }
  >;
}

/** Delivery-side commit port: compensate one pending handoff under its own mutex. */
export interface DeliveryHandoffRecoveryPort {
  compensateHandoff(input: {
    readonly workKey: WorkKey;
    readonly handoffId: string;
    readonly expectedHeadSha: string | undefined;
    readonly idempotencyKey: string;
  }): Promise<WorkRecoveryOutcome>;
}

/** Adapter for orchestrator-owned stages (`coding`, and dispatch-after-reclaim). */
export function createOrchestratorRecoveryAuthority(
  port: OrchestratorRecoveryPort,
): WorkRecoveryAuthority {
  return {
    authority: "orchestrator",
    async recover(request: WorkRecoveryRequest): Promise<WorkRecoveryOutcome> {
      return await port.dispatchWork({
        workKey: request.workKey,
        expectedFence: request.recovery.expectedFence,
        idempotencyKey: request.idempotencyKey,
      });
    },
  };
}

/**
 * Adapter for Decision-owned stages (`planning`, `review`).
 *
 * A `dispatch` recovery means "the owner of this stage should pick the task up again".
 * The coordinator must never impersonate the Web executor, so the adapter only releases a
 * claim the Decision authority itself confirms is expired; the normal executor claims it
 * afterwards. When the expected action does not carry a task reference the adapter reports
 * `unavailable` rather than guessing a task.
 */
export function createDecisionRecoveryAuthority(
  port: DecisionClaimRecoveryPort,
): WorkRecoveryAuthority {
  return {
    authority: "decision",
    async recover(request: WorkRecoveryRequest): Promise<WorkRecoveryOutcome> {
      const taskRef = request.verdict.expectedAction?.taskRef;
      if (taskRef === undefined) {
        return {
          kind: "unavailable",
          reason: "decision recovery requires an observed task reference; none was available",
        };
      }
      const result = await port.releaseExpiredClaim({
        taskId: taskRef.taskId,
        expectedRevision: taskRef.revision,
        expectedClaimGeneration:
          request.verdict.owner?.fence.leaseGeneration ?? request.recovery.expectedFence.leaseGeneration ?? 0,
      });

      switch (result.kind) {
        case "released":
          return { kind: "applied", detail: `released expired claim on task ${taskRef.taskId}` };
        case "not_expired":
          return { kind: "skipped", reason: "claim is still live or already released" };
        case "superseded":
          return { kind: "refused", reason: result.reason };
        case "not_found":
          return { kind: "skipped", reason: `task ${taskRef.taskId} no longer exists` };
      }
    },
  };
}

/** Adapter for Delivery-owned stages (`delivery`, `repair`, `merge`). */
export function createDeliveryRecoveryAuthority(
  port: DeliveryHandoffRecoveryPort,
): WorkRecoveryAuthority {
  return {
    authority: "delivery",
    async recover(request: WorkRecoveryRequest): Promise<WorkRecoveryOutcome> {
      if (request.recovery.class === "retry") {
        return {
          kind: "unavailable",
          reason:
            "repair requires a new coding attempt; this reconciliation layer has no safe repair primitive and will not start one",
        };
      }
      if (request.recovery.class === "resume") {
        return {
          kind: "unavailable",
          reason:
            "delivery resume requires the delivery pipeline to be re-entered by its owning skill; no automatic resume primitive is wired",
        };
      }

      const handoffId = request.verdict.expectedAction?.handoffRef?.handoffId ?? null;
      if (handoffId === null) {
        return {
          kind: "unavailable",
          reason:
            "delivery compensation requires a concrete handoff id; recovery without one could duplicate a comment or label change",
        };
      }
      return await port.compensateHandoff({
        workKey: request.workKey,
        handoffId,
        expectedHeadSha: request.recovery.expectedFence.expectedHeadSha,
        idempotencyKey: request.idempotencyKey,
      });
    },
  };
}
