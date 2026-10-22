/** Host composition for native recovery policy; Operations/Dashboard never own actions. */
import { AGENT_ERROR_CODES } from "@symphony/agent";
import { createHash } from "node:crypto";
import { sanitizeOwnershipFence, validateOwnershipFence, recoveryScope, type RecoveryContext, type RecoveryFailure, type RecoveryPolicy,
  type WorkContinuityObservation, type WorkRecoveryRequest } from "@symphony/domain";
import { reserveRecovery, refundRecovery, beginRecoveryEpoch, type RetryScheduleRequest } from "@symphony/orchestrator";
import { FileRecoveryLedger } from "./recovery-ledger";

export function createHostRecovery(ledger: FileRecoveryLedger, policy: () => RecoveryPolicy, now: () => number) {
  const invocationId = (request: WorkRecoveryRequest) => request.invocationId ?? createHash("sha256").update(JSON.stringify([request.workKey, request.stage, request.action, request.taskRef, request.handoffRef, request.fence, request.leaseExpiresAt])).digest("hex");
  const reservations = new Map<string, { scope: string; epoch: number }>();
  const unblock = "Inspect native task/conversation/subprocess receipts; resolve the cause; authorize this exact incident with symphony recovery authorize";
  const targetFor = (f: WorkContinuityObservation) => JSON.stringify([f.taskRef ?? null, f.target ?? null, f.handoffRef ?? null, f.nativeRecovery?.epoch ?? 0]);
  const contextFor = (f: WorkContinuityObservation, failure: RecoveryFailure): RecoveryContext => ({
    workKey: f.workKey, expectedAction: f.stage === "coding" ? "coding:retry" : `${f.stage}:recover`,
    target: failure.classification === "auth_required" || failure.classification === "irrecoverable_binding"
      ? `infrastructure:${f.nativeRecovery?.epoch ?? 0}` : f.stage === "coding" ? "runtime" : targetFor(f), owner: f.owner?.id ?? null,
    fence: sanitizeOwnershipFence(f.expectedFence), lastProgressAt: f.owner?.liveness.lastProgressAt ?? f.nativeRecovery?.lastProgressAt ?? "unknown", failure, unblock,
  });
  const blockClass = (reason: string): RecoveryFailure["classification"] => {
    if (reason.startsWith("auth_required")) return "auth_required";
    if (reason.startsWith("invariant_violation") || reason === "invalid_workspace_cwd") return "invariant_violation";
    if (reason.startsWith("irrecoverable_binding")) return "irrecoverable_binding";
    if (reason.includes("unverified") || reason.includes("unknown")) return "outcome_unknown";
    return "human_required";
  };
  return {
    ledger,
    resumeAuthorizedRetry(authority: import("@symphony/orchestrator").OrchestratorAuthority, issueId: string, workKey: import("@symphony/domain").WorkKey): void {
      const budget = ledger.list().find(b => b.scope === recoveryScope({ workKey, expectedAction: "coding:retry" }));
      if (!budget || budget.incident) return;
      const reviewed = ledger.incidents().find(i => i.expectedAction === "coding:retry" && recoveryScope(i) === budget.scope
        && i.epoch + 1 === budget.epoch && i.fence.retryToken);
      if (reviewed?.fence.retryToken) authority.releaseAuthorizedRetry(issueId, reviewed.fence.retryToken);
    },
    blocked(workKey: import("@symphony/domain").WorkKey): boolean {
      return ledger.list().some(b => b.scope === recoveryScope({ workKey, expectedAction: "coding:retry" }) && b.incident !== null);
    },
    authorizeRetry(request: RetryScheduleRequest, invocation: string, workKey: import("@symphony/domain").WorkKey): boolean {
      // AgentError codes are stable. Arbitrary thrown messages never enter the fingerprint/report.
      const code = request.error ?? "worker_failure";
      const nonRetryable = /^(auth_required|human_required|approval_required|turn_input_required|invalid_workspace_cwd|invariant_violation|irrecoverable_binding)(:|$)/.test(code);
      const reason = (AGENT_ERROR_CODES as readonly string[]).includes(code) ? code : request.reason ?? "manual_retry";
      const failure: RecoveryFailure = { classification: nonRetryable ? blockClass(code) : "recoverable", reason };
      const context: RecoveryContext = { workKey, expectedAction: "coding:retry", target: "runtime", owner: request.owner ?? "orchestrator",
        fence: request.fence ?? sanitizeOwnershipFence({}), lastProgressAt: request.lastProgressAt ?? "unknown", failure, unblock };
      return !reserveRecovery({ ledger, context, policy: policy(), invocation, priorAttempts: Math.max(0, request.attempt - 1), strategies: ["retry"], now: now() }).incident;
    },
    authorize(request: WorkRecoveryRequest, f: WorkContinuityObservation): boolean {
      // Coding dispatch is owned by the worker authority; unsupported primitives are never charged.
      if (f.stage === "coding" || !["reclaim", "compensate", "dispatch"].includes(request.action)) return true;
      const context = contextFor(f, { classification: "recoverable", reason: request.action === "reclaim" ? "execution_lease_expired" : "incomplete_stage" });
      const budget = reserveRecovery({ ledger, context, policy: policy(), invocation: invocationId(request),
        strategies: [request.action === "dispatch" ? "resume" : request.action === "reclaim" ? "reclaim" : "compensate"], now: now() });
      reservations.set(invocationId(request), { scope: budget.scope, epoch: budget.epoch });
      return !budget.incident;
    },
    canCommit(request: WorkRecoveryRequest): boolean {
      const reservation = reservations.get(invocationId(request));
      if (!reservation) return request.stage === "coding";
      return ledger.list().some(b => b.scope === reservation.scope && b.epoch === reservation.epoch
        && !b.incident && b.invocations.includes(invocationId(request)));
    },
    refused(request: WorkRecoveryRequest): void {
      const reservation = reservations.get(invocationId(request));
      if (reservation) refundRecovery(ledger, reservation.scope, invocationId(request), reservation.epoch);
      reservations.delete(invocationId(request));
    },
    unverified(request: WorkRecoveryRequest, f: WorkContinuityObservation): void {
      const reservation = reservations.get(invocationId(request));
      if (reservation && !ledger.list().some(b => b.scope === reservation.scope && b.epoch === reservation.epoch)) return;
      if (request.stage !== f.stage || JSON.stringify(request.handoffRef) !== JSON.stringify(f.handoffRef)
        || request.taskRef?.taskId !== f.taskRef?.taskId || request.taskRef?.revision !== f.taskRef?.revision
        || request.fence.expectedHeadSha !== f.expectedFence.expectedHeadSha
        || request.fence.leaseGeneration !== f.expectedFence.leaseGeneration
        || request.fence.bindingGeneration !== f.expectedFence.bindingGeneration) return;
      const context = contextFor(f, { classification: "outcome_unknown", reason: "recovery_outcome_unverified" });
      reserveRecovery({ ledger, context, policy: policy(), invocation: invocationId(request), strategies: [], now: now() });
    },
    observe(f: WorkContinuityObservation): WorkContinuityObservation {
      if (!f.available || !f.active) return f;
      const context = contextFor(f, { classification: "recoverable", reason: "incomplete_stage" });
      const invariant = f.contradictions[0] ?? (f.owner && !validateOwnershipFence(f.expectedFence, f.owner.fence).valid ? "stale_or_conflicting_owner_fence" : null);
      if (invariant) {
        reserveRecovery({ ledger, context: contextFor(f, { classification: "invariant_violation", reason: invariant }),
          policy: policy(), invocation: createHash("sha256").update(JSON.stringify([context.target, f.contradictions])).digest("hex"), strategies: [], now: now() });
      }
      const budget = ledger.list().find(b => b.scope === recoveryScope(context) && (b.target === context.target || b.target === `infrastructure:${f.nativeRecovery?.epoch ?? 0}`));
      if (budget?.incident?.failure.classification === "invariant_violation" && !invariant && !f.blocked) {
        ledger.transact(budget.scope, latest => {
          if (!latest) throw new Error("Missing invariant block");
          return latest.incident?.id === budget.incident!.id ? beginRecoveryEpoch(latest) : latest;
        });
        return f;
      }
      if (budget?.incident) return { ...f, recoveryIncidentId: budget.incident.id, blocked: `${budget.incident.blockedReason}: ${budget.incident.unblock}` };
      // Native blocked facts are durable and reconstruct the incident after a block/outbox crash.
      if (f.blocked && /auth_required|human_required|approval_required|invariant_violation|recovery_exhausted|irrecoverable_binding|unverified/.test(f.blocked)) {
        const classification = f.blocked.startsWith("recovery_exhausted") ? "recoverable" : blockClass(f.blocked);
        const evidence = contextFor(f, { classification, reason: classification === "recoverable" ? "recovery_exhausted" : classification });
        reserveRecovery({ ledger, context: evidence, policy: policy(), invocation: createHash("sha256").update(JSON.stringify([context.target, f.blocked])).digest("hex"), strategies: [], priorAttempts: f.nativeRecovery?.attempts ?? 0, priorActions: f.nativeRecovery?.actions ?? [], now: now() });
      }
      return f;
    },
  };
}
