/**
 * @symphony/orchestrator — Work-level liveness and stranded-state reconciliation (NEST-131 / GitHub #147).
 *
 * Implements work-level continuity derivation, liveness evaluation, stranded condition detection,
 * and bounded recovery coordination across stage boundaries (planning, coding, CI, review, repair, delivery, merge).
 *
 * Key invariants:
 * 1. Thin coordinator: orchestrator coordinates but does NOT introduce a monolithic workflow engine.
 * 2. Original authorities retain exclusive mutation control (Orchestrator for workers/retries, Decision for claims, Delivery for handoffs).
 * 3. Reconciliation protocol: observe -> derive -> re-observe right before action -> delegate to authority -> re-observe post-action.
 * 4. Idempotent: repeated runs over unchanged facts produce no duplicate side-effects.
 * 5. Fail-safe: temporary source observation failures do not mutate ownership.
 */

import {
  validateContinuityDescriptor,
  type BlockedReasonDetails,
  type ExecutionContinuityDescriptor,
  type ExpectedNextAction,
  type LivenessMetadata,
  type RecoveryProposal,
  type SafeOwnershipFence,
  type UtcTimestampMs,
  type WorkContinuityAnalysis,
  type WorkItemFacts,
  type WorkKey,
} from "@symphony/domain";

// ---------------------------------------------------------------------------
// 1. Pure Derivation Logic
// ---------------------------------------------------------------------------

export interface DeriveWorkContinuityOptions {
  readonly planningEnabled?: boolean | undefined;
  readonly defaultStallTimeoutMs?: number | undefined;
}

/**
 * Checks whether two recovery proposals specify the same action and targets.
 */
export function isSameRecoveryProposal(a: RecoveryProposal, b: RecoveryProposal): boolean {
  if (a.kind !== b.kind || a.authority !== b.authority) {
    return false;
  }
  switch (a.kind) {
    case "decision_release_expired_claim": {
      const bProp = b as typeof a;
      return (
        a.taskId === bProp.taskId &&
        a.revision === bProp.revision &&
        a.claimGeneration === bProp.claimGeneration &&
        a.bindingGeneration === bProp.bindingGeneration
      );
    }
    case "decision_dispatch_plan": {
      const bProp = b as typeof a;
      return a.sessionId === bProp.sessionId;
    }
    case "decision_dispatch_review": {
      const bProp = b as typeof a;
      return (
        a.sessionId === bProp.sessionId &&
        a.target.headSha === bProp.target.headSha &&
        a.target.prNumber === bProp.target.prNumber &&
        a.target.repository === bProp.target.repository
      );
    }
    case "orchestrator_dispatch":
    case "orchestrator_retry":
    case "orchestrator_stop_stalled": {
      const bProp = b as typeof a;
      return a.issueId === bProp.issueId;
    }
    case "delivery_compensate": {
      const bProp = b as typeof a;
      return a.handoffId === bProp.handoffId;
    }
    case "delivery_resume_repair": {
      const bProp = b as typeof a;
      return (
        a.target.headSha === bProp.target.headSha &&
        a.target.prNumber === bProp.target.prNumber &&
        a.target.repository === bProp.target.repository
      );
    }
  }
}

/**
 * Pure function deriving work-level continuity condition, expected action, owner,
 * liveness, and bounded recovery proposal from authoritative cross-source facts.
 */
export function deriveWorkContinuity(
  facts: WorkItemFacts,
  now: UtcTimestampMs,
  options?: DeriveWorkContinuityOptions,
): WorkContinuityAnalysis {
  const { workKey } = facts;
  const planningEnabled = options?.planningEnabled ?? true;

  // 1. Fail-safe on observation failure
  if (facts.sourceFreshness?.github === "unavailable") {
    const liveness: LivenessMetadata = {
      startedAt: now,
      lastProgressAt: "unknown",
      lastObservedAt: now,
    };
    const fence: SafeOwnershipFence = { hasLeaseToken: false };
    const expectedAction: ExpectedNextAction = {
      action: "await_external",
      description: "GitHub / tracker source unavailable; waiting for source recovery",
      authority: {
        kind: "external",
        system: "tracker",
        condition: "source_available",
      },
      requiredEvidence: ["source_available"],
    };
    const descriptor: ExecutionContinuityDescriptor = {
      workKey,
      scope: "work",
      state: "blocked",
      expectedAction,
      liveness,
      fence,
      blockedDetails: {
        reason: "source_unavailable",
        waitingOn: {
          kind: "external",
          system: "tracker",
          condition: "source_available",
        },
        unblockCondition: "Tracker returns healthy responses",
        blockedAt: now,
      },
    };
    return {
      workKey,
      stage: "coding",
      condition: "observation_unavailable",
      expectedAction,
      currentOwner: null,
      liveness,
      fence,
      descriptor,
      sourceFreshness: { github: "unavailable" },
    };
  }

  // 2. Completed states: closed issue or merged PR
  if (facts.github?.issue.state === "closed" || facts.github?.pullRequest?.state === "merged") {
    const liveness: LivenessMetadata = {
      startedAt: now,
      lastProgressAt: now,
      lastObservedAt: now,
    };
    const fence: SafeOwnershipFence = {
      hasLeaseToken: false,
      expectedHeadSha: facts.github?.pullRequest?.headSha,
    };
    const descriptor: ExecutionContinuityDescriptor = {
      workKey,
      scope: "work",
      state: "completed",
      expectedAction: null,
      liveness,
      fence,
    };
    return {
      workKey,
      stage: "completed",
      condition: "completed",
      expectedAction: null,
      currentOwner: null,
      liveness,
      fence,
      descriptor,
    };
  }

  // 3. Delivery Paused / Handoff Compensation
  if (facts.delivery?.isPaused) {
    const liveness: LivenessMetadata = {
      startedAt: now,
      lastProgressAt: now,
      lastObservedAt: now,
    };
    const fence: SafeOwnershipFence = {
      hasLeaseToken: false,
      expectedHeadSha: facts.github?.pullRequest?.headSha,
    };

    if (facts.delivery.pendingCompensation) {
      const expectedAction: ExpectedNextAction = {
        action: "compensate",
        description: `Compensating delivery handoff state for handoff ${facts.delivery.handoff?.handoffId ?? "unknown"}`,
        authority: { kind: "internal", authority: "delivery" },
        requiredEvidence: ["persisted_paused_state", "remote_label_status", "comment_verified"],
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "work",
        state: "recovering",
        expectedAction,
        liveness,
        fence,
      };
      const recoveryProposal: RecoveryProposal = {
        kind: "delivery_compensate",
        authority: "delivery",
        handoffId: facts.delivery.handoff?.handoffId,
      };
      return {
        workKey,
        stage: "delivery_compensate",
        condition: "stranded",
        strandedReason: "delivery_handoff_pending_compensation",
        expectedAction,
        currentOwner: { kind: "internal", authority: "delivery" },
        liveness,
        fence,
        recoveryProposal,
        descriptor,
      };
    }

    // Paused with compensation completed -> legitimate human block (e.g. max repairs exceeded)
    const pauseInstruction = facts.delivery.pauseReason ?? "Delivery paused for manual intervention";
    const expectedAction: ExpectedNextAction = {
      action: "require_human",
      description: pauseInstruction,
      authority: { kind: "human", role: "operator", instruction: pauseInstruction },
      requiredEvidence: ["operator_intervention"],
    };
    const blockedDetails: BlockedReasonDetails = {
      reason: "human_required",
      waitingOn: { kind: "human", role: "operator", instruction: pauseInstruction },
      unblockCondition: "Operator resolves delivery pause or updates PR",
      blockedAt: now,
    };
    const descriptor: ExecutionContinuityDescriptor = {
      workKey,
      scope: "work",
      state: "blocked",
      expectedAction,
      liveness,
      fence,
      blockedDetails,
    };
    return {
      workKey,
      stage: "repair",
      condition: "blocked",
      expectedAction,
      currentOwner: { kind: "human", role: "operator", instruction: pauseInstruction },
      liveness,
      fence,
      blockedDetails,
      descriptor,
    };
  }

  // Extract repo and issue id
  const parts = workKey.key.split("#");
  const repository = parts[0] ?? "";
  const rawIssueNum = parts[1] ? Number(parts[1]) : 0;
  const issueId = rawIssueNum > 0 ? `GH-${rawIssueNum}` : workKey.key;
  const sessionId = `${workKey.provider}-${repository.replace("/", "-")}-${rawIssueNum}`;

  // 4. PR lifecycle stages: CI wait, review, repair, merge
  if (facts.github?.pullRequest && facts.github.pullRequest.state === "open") {
    const pr = facts.github.pullRequest;
    const reviewTarget = {
      repository,
      prNumber: pr.number,
      headSha: pr.headSha,
    };

    // 4.1 CI Waiting Stage
    if (facts.github.ci?.status === "pending") {
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = {
        hasLeaseToken: false,
        expectedHeadSha: pr.headSha,
      };
      const expectedAction: ExpectedNextAction = {
        action: "await_external",
        description: `Waiting for GitHub CI checks completion on PR #${pr.number}`,
        authority: {
          kind: "external",
          system: "github-actions",
          condition: "required_checks_completed_and_green",
        },
        requiredEvidence: ["pr_open", "head_sha_matched", "checks_pending"],
      };
      const blockedDetails: BlockedReasonDetails = {
        reason: "ci_checks_pending",
        waitingOn: {
          kind: "external",
          system: "github-actions",
          condition: "required_checks_completed_and_green",
        },
        unblockCondition: "All required check suites conclude with success",
        blockedAt: now,
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "work",
        state: "blocked",
        expectedAction,
        liveness,
        fence,
        blockedDetails,
      };
      return {
        workKey,
        stage: "ci_wait",
        condition: "external_wait",
        expectedAction,
        currentOwner: {
          kind: "external",
          system: "github-actions",
          condition: "required_checks_completed_and_green",
        },
        liveness,
        fence,
        blockedDetails,
        descriptor,
      };
    }

    // 4.2 CI Failed -> Needs Repair
    if (facts.github.ci?.status === "failure") {
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: now,
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = {
        hasLeaseToken: false,
        expectedHeadSha: pr.headSha,
      };
      const expectedAction: ExpectedNextAction = {
        action: "retry",
        description: `CI failed on PR #${pr.number} at HEAD ${pr.headSha.slice(0, 10)}; repair turn needed`,
        authority: { kind: "internal", authority: "delivery", executor: "codex-agent" },
        target: reviewTarget,
        requiredEvidence: ["ci_failed"],
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "attempt",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      const recoveryProposal: RecoveryProposal = {
        kind: "delivery_resume_repair",
        authority: "delivery",
        target: reviewTarget,
      };
      return {
        workKey,
        stage: "repair",
        condition: "stranded",
        strandedReason: "ci_failed_needs_repair",
        expectedAction,
        currentOwner: { kind: "internal", authority: "delivery" },
        liveness,
        fence,
        recoveryProposal,
        descriptor,
      };
    }

    // 4.3 CI is Success -> Review or Merge
    if (facts.github.ci?.status === "success") {
      const revTask = facts.decision?.latestReviewTask;
      const isMatchingHead = revTask && revTask.target.headSha === pr.headSha;

      if (isMatchingHead && revTask) {
        // If approved -> Merge stage
        if (revTask.verdict === "approve") {
          const liveness: LivenessMetadata = {
            startedAt: now,
            lastProgressAt: now,
            lastObservedAt: now,
          };
          const fence: SafeOwnershipFence = {
            hasLeaseToken: false,
            expectedHeadSha: pr.headSha,
          };
          const expectedAction: ExpectedNextAction = {
            action: "none",
            description: `Executing squash-merge and verifying merged state for PR #${pr.number}`,
            authority: { kind: "internal", authority: "delivery" },
            target: reviewTarget,
            requiredEvidence: ["exact_head_approved", "ci_all_green", "mergeable"],
          };
          const descriptor: ExecutionContinuityDescriptor = {
            workKey,
            scope: "work",
            state: "running",
            expectedAction,
            liveness,
            fence,
          };
          return {
            workKey,
            stage: "merge",
            condition: "making_progress",
            expectedAction,
            currentOwner: { kind: "internal", authority: "delivery" },
            liveness,
            fence,
            descriptor,
          };
        }

        // If changes requested -> Repair stage
        if (revTask.verdict === "changes_requested") {
          const liveness: LivenessMetadata = {
            startedAt: now,
            lastProgressAt: now,
            lastObservedAt: now,
          };
          const fence: SafeOwnershipFence = {
            hasLeaseToken: false,
            expectedHeadSha: pr.headSha,
          };

          // Check if repair worker is already running or retry scheduled
          if (facts.orchestrator?.isRunning) {
            const expectedAction: ExpectedNextAction = {
              action: "none",
              description: "Repair agent active in workspace executing review feedback",
              authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
              target: reviewTarget,
            };
            const descriptor: ExecutionContinuityDescriptor = {
              workKey,
              scope: "attempt",
              state: "running",
              expectedAction,
              liveness,
              fence,
            };
            return {
              workKey,
              stage: "repair",
              condition: "making_progress",
              expectedAction,
              currentOwner: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
              liveness,
              fence,
              descriptor,
            };
          }

          if (facts.orchestrator?.retryScheduled) {
            const expectedAction: ExpectedNextAction = {
              action: "retry",
              description: "Repair retry scheduled in orchestrator queue",
              authority: { kind: "internal", authority: "orchestrator" },
              target: reviewTarget,
            };
            const descriptor: ExecutionContinuityDescriptor = {
              workKey,
              scope: "attempt",
              state: "retry_queued",
              expectedAction,
              liveness,
              fence,
            };
            return {
              workKey,
              stage: "repair",
              condition: "retry_scheduled",
              expectedAction,
              currentOwner: { kind: "internal", authority: "orchestrator" },
              liveness,
              fence,
              descriptor,
            };
          }

          // No repair worker running -> Stranded!
          const expectedAction: ExpectedNextAction = {
            action: "retry",
            description: "Re-observing review findings and re-executing repair turn",
            authority: { kind: "internal", authority: "delivery", executor: "codex-agent" },
            target: reviewTarget,
            requiredEvidence: ["review_verdict_changes_requested"],
          };
          const descriptor: ExecutionContinuityDescriptor = {
            workKey,
            scope: "attempt",
            state: "running",
            expectedAction,
            liveness,
            fence,
          };
          const recoveryProposal: RecoveryProposal = {
            kind: "delivery_resume_repair",
            authority: "delivery",
            target: reviewTarget,
          };
          return {
            workKey,
            stage: "repair",
            condition: "stranded",
            strandedReason: "review_changes_requested_needs_repair",
            expectedAction,
            currentOwner: { kind: "internal", authority: "delivery" },
            liveness,
            fence,
            recoveryProposal,
            descriptor,
          };
        }

        // If needs_human
        if (revTask.verdict === "needs_human") {
          const liveness: LivenessMetadata = {
            startedAt: now,
            lastProgressAt: "unknown",
            lastObservedAt: now,
          };
          const fence: SafeOwnershipFence = {
            hasLeaseToken: false,
            expectedHeadSha: pr.headSha,
          };
          const expectedAction: ExpectedNextAction = {
            action: "require_human",
            description: "Review verdict requires human intervention",
            authority: { kind: "human", role: "reviewer", instruction: "Resolve manual review required" },
          };
          const blockedDetails: BlockedReasonDetails = {
            reason: "human_required",
            waitingOn: { kind: "human", role: "reviewer", instruction: "Resolve manual review required" },
            unblockCondition: "Human reviewer approves or clarifies",
            blockedAt: now,
          };
          const descriptor: ExecutionContinuityDescriptor = {
            workKey,
            scope: "task",
            state: "blocked",
            expectedAction,
            liveness,
            fence,
            blockedDetails,
          };
          return {
            workKey,
            stage: "review",
            condition: "blocked",
            expectedAction,
            currentOwner: { kind: "human", role: "reviewer", instruction: "Resolve manual review required" },
            liveness,
            fence,
            blockedDetails,
            descriptor,
          };
        }

        // Review task claimed or running
        if (revTask.status === "claimed" || revTask.status === "running") {
          const lease = revTask.lease;
          const isExpired = lease !== null && lease !== undefined && now >= lease.expiresAtMs;

          if (isExpired) {
            const liveness: LivenessMetadata = {
              startedAt: now,
              lastProgressAt: "unknown",
              lastObservedAt: now,
            };
            const fence: SafeOwnershipFence = {
              hasLeaseToken: true,
              expectedHeadSha: pr.headSha,
              leaseGeneration: lease?.generation,
              bindingGeneration: facts.decision?.bindingGeneration,
            };
            const expectedAction: ExpectedNextAction = {
              action: "reclaim",
              description: `Release expired lease on review task ${revTask.taskId}`,
              authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
              target: reviewTarget,
              taskRef: { taskId: revTask.taskId, revision: revTask.revision },
            };
            const descriptor: ExecutionContinuityDescriptor = {
              workKey,
              scope: "task",
              state: "running",
              expectedAction,
              liveness,
              fence,
            };
            const recoveryProposal: RecoveryProposal = {
              kind: "decision_release_expired_claim",
              authority: "decision",
              taskId: revTask.taskId,
              revision: revTask.revision,
              claimGeneration: revTask.claimGeneration ?? lease?.generation,
              bindingGeneration: facts.decision?.bindingGeneration,
            };
            return {
              workKey,
              stage: "review",
              condition: "stranded",
              strandedReason: "review_task_lease_expired",
              expectedAction,
              currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
              liveness,
              fence,
              recoveryProposal,
              descriptor,
            };
          }

          // Lease is alive and valid
          const liveness: LivenessMetadata = {
            startedAt: now,
            lastProgressAt: "unknown",
            lastObservedAt: now,
          };
          const fence: SafeOwnershipFence = {
            hasLeaseToken: true,
            expectedHeadSha: pr.headSha,
            leaseGeneration: lease?.generation,
            bindingGeneration: facts.decision?.bindingGeneration,
          };
          const expectedAction: ExpectedNextAction = {
            action: "none",
            description: "Executing Decision review task via Web Agent Bridge",
            authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            target: reviewTarget,
            taskRef: { taskId: revTask.taskId, revision: revTask.revision },
          };
          const descriptor: ExecutionContinuityDescriptor = {
            workKey,
            scope: "task",
            state: "running",
            expectedAction,
            liveness,
            fence,
          };
          return {
            workKey,
            stage: "review",
            condition: "making_progress",
            expectedAction,
            currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            liveness,
            fence,
            descriptor,
          };
        }

        // Review task is pending
        if (revTask.status === "pending") {
          const liveness: LivenessMetadata = {
            startedAt: now,
            lastProgressAt: "unknown",
            lastObservedAt: now,
          };
          const fence: SafeOwnershipFence = {
            hasLeaseToken: false,
            expectedHeadSha: pr.headSha,
          };
          const expectedAction: ExpectedNextAction = {
            action: "dispatch",
            description: `Review task pending claim by Web executor for PR #${pr.number}`,
            authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            target: reviewTarget,
            taskRef: { taskId: revTask.taskId, revision: revTask.revision },
          };
          const descriptor: ExecutionContinuityDescriptor = {
            workKey,
            scope: "task",
            state: "running",
            expectedAction,
            liveness,
            fence,
          };
          return {
            workKey,
            stage: "review",
            condition: "making_progress",
            expectedAction,
            currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
            liveness,
            fence,
            descriptor,
          };
        }
      }

      // No review task exists for current HEAD -> Stranded!
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = {
        hasLeaseToken: false,
        expectedHeadSha: pr.headSha,
      };
      const expectedAction: ExpectedNextAction = {
        action: "dispatch",
        description: `Dispatch review task for PR #${pr.number} at HEAD ${pr.headSha.slice(0, 10)}`,
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        target: reviewTarget,
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "task",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      const recoveryProposal: RecoveryProposal = {
        kind: "decision_dispatch_review",
        authority: "decision",
        target: reviewTarget,
        sessionId,
      };
      return {
        workKey,
        stage: "review",
        condition: "stranded",
        strandedReason: "review_task_missing_for_current_head",
        expectedAction,
        currentOwner: { kind: "internal", authority: "decision" },
        liveness,
        fence,
        recoveryProposal,
        descriptor,
      };
    }
  }

  // 5. Pre-PR stages: Planning or Coding
  const planTask = facts.decision?.latestPlanTask;

  if (planningEnabled) {
    if (!planTask) {
      // Planning task does not exist -> Stranded!
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = { hasLeaseToken: false };
      const expectedAction: ExpectedNextAction = {
        action: "dispatch",
        description: `Dispatch planning task for issue ${issueId}`,
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "task",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      const recoveryProposal: RecoveryProposal = {
        kind: "decision_dispatch_plan",
        authority: "decision",
        sessionId,
      };
      return {
        workKey,
        stage: "planning",
        condition: "stranded",
        strandedReason: "plan_task_missing",
        expectedAction,
        currentOwner: { kind: "internal", authority: "decision" },
        liveness,
        fence,
        recoveryProposal,
        descriptor,
      };
    }

    if (planTask.verdict === "needs_clarification" || planTask.verdict === "needs_human") {
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = { hasLeaseToken: false };
      const expectedAction: ExpectedNextAction = {
        action: "require_human",
        description: "Planning task requires human clarification",
        authority: { kind: "human", role: "operator", instruction: "Resolve planning clarifications" },
      };
      const blockedDetails: BlockedReasonDetails = {
        reason: "human_required",
        waitingOn: { kind: "human", role: "operator", instruction: "Resolve planning clarifications" },
        unblockCondition: "Operator provides requirements clarifications",
        blockedAt: now,
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "task",
        state: "blocked",
        expectedAction,
        liveness,
        fence,
        blockedDetails,
      };
      return {
        workKey,
        stage: "planning",
        condition: "blocked",
        expectedAction,
        currentOwner: { kind: "human", role: "operator", instruction: "Resolve planning clarifications" },
        liveness,
        fence,
        blockedDetails,
        descriptor,
      };
    }

    if (planTask.status === "claimed" || planTask.status === "running") {
      const lease = planTask.lease;
      const isExpired = lease !== null && lease !== undefined && now >= lease.expiresAtMs;

      if (isExpired) {
        const liveness: LivenessMetadata = {
          startedAt: now,
          lastProgressAt: "unknown",
          lastObservedAt: now,
        };
        const fence: SafeOwnershipFence = {
          hasLeaseToken: true,
          leaseGeneration: lease?.generation,
          bindingGeneration: facts.decision?.bindingGeneration,
        };
        const expectedAction: ExpectedNextAction = {
          action: "reclaim",
          description: `Release expired claim on planning task ${planTask.taskId}`,
          authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
          taskRef: { taskId: planTask.taskId, revision: planTask.revision },
        };
        const descriptor: ExecutionContinuityDescriptor = {
          workKey,
          scope: "task",
          state: "running",
          expectedAction,
          liveness,
          fence,
        };
        const recoveryProposal: RecoveryProposal = {
          kind: "decision_release_expired_claim",
          authority: "decision",
          taskId: planTask.taskId,
          revision: planTask.revision,
          claimGeneration: planTask.claimGeneration ?? lease?.generation,
          bindingGeneration: facts.decision?.bindingGeneration,
        };
        return {
          workKey,
          stage: "planning",
          condition: "stranded",
          strandedReason: "plan_task_lease_expired",
          expectedAction,
          currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
          liveness,
          fence,
          recoveryProposal,
          descriptor,
        };
      }

      // Valid lease
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = {
        hasLeaseToken: true,
        leaseGeneration: lease?.generation,
        bindingGeneration: facts.decision?.bindingGeneration,
      };
      const expectedAction: ExpectedNextAction = {
        action: "none",
        description: "Executing planning task via Web Agent Bridge",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: planTask.taskId, revision: planTask.revision },
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "task",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      return {
        workKey,
        stage: "planning",
        condition: "making_progress",
        expectedAction,
        currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        liveness,
        fence,
        descriptor,
      };
    }

    if (planTask.status === "pending") {
      const liveness: LivenessMetadata = {
        startedAt: now,
        lastProgressAt: "unknown",
        lastObservedAt: now,
      };
      const fence: SafeOwnershipFence = { hasLeaseToken: false };
      const expectedAction: ExpectedNextAction = {
        action: "dispatch",
        description: "Waiting for executor to claim planning task",
        authority: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        taskRef: { taskId: planTask.taskId, revision: planTask.revision },
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "task",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      return {
        workKey,
        stage: "planning",
        condition: "making_progress",
        expectedAction,
        currentOwner: { kind: "internal", authority: "decision", executor: "chatgpt-web" },
        liveness,
        fence,
        descriptor,
      };
    }
  }

  // 6. Coding Stage (plan is ready or not required, no PR yet)
  if (facts.orchestrator?.isRunning) {
    const isStalled = facts.orchestrator.isStalled;
    const liveness: LivenessMetadata = {
      startedAt: now,
      lastProgressAt: facts.orchestrator.lastProgressAt ?? now,
      lastObservedAt: now,
      attempt: facts.orchestrator.attempt ?? 1,
    };
    const fence: SafeOwnershipFence = {
      hasLeaseToken: false,
      retryToken: facts.orchestrator.attemptToken,
      lifecycleGeneration: facts.orchestrator.lifecycleGeneration,
      reconciliationEpoch: facts.orchestrator.reconciliationEpoch,
    };

    if (isStalled) {
      const expectedAction: ExpectedNextAction = {
        action: "reclaim",
        description: `Stop stalled coding worker for issue ${issueId}`,
        authority: { kind: "internal", authority: "orchestrator" },
      };
      const descriptor: ExecutionContinuityDescriptor = {
        workKey,
        scope: "attempt",
        state: "running",
        expectedAction,
        liveness,
        fence,
      };
      const recoveryProposal: RecoveryProposal = {
        kind: "orchestrator_stop_stalled",
        authority: "orchestrator",
        issueId,
      };
      return {
        workKey,
        stage: "coding",
        condition: "stranded",
        strandedReason: "worker_stalled",
        expectedAction,
        currentOwner: { kind: "internal", authority: "orchestrator" },
        liveness,
        fence,
        recoveryProposal,
        descriptor,
      };
    }

    // Active working coding agent
    const expectedAction: ExpectedNextAction = {
      action: "none",
      description: "Coding agent active in workspace executing issue prompt",
      authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
    };
    const descriptor: ExecutionContinuityDescriptor = {
      workKey,
      scope: "attempt",
      state: "running",
      expectedAction,
      liveness,
      fence,
    };
    return {
      workKey,
      stage: "coding",
      condition: "making_progress",
      expectedAction,
      currentOwner: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
      liveness,
      fence,
      descriptor,
    };
  }

  // Check retry scheduled
  if (facts.orchestrator?.retryScheduled) {
    const retry = facts.orchestrator.retryScheduled;
    const liveness: LivenessMetadata = {
      startedAt: now,
      lastProgressAt: now,
      lastObservedAt: now,
      attempt: retry.attempt,
    };
    const fence: SafeOwnershipFence = { hasLeaseToken: false };
    const expectedAction: ExpectedNextAction = {
      action: "retry",
      description: `Retry scheduled in orchestrator queue (in ${retry.retryInMs}ms)`,
      authority: { kind: "internal", authority: "orchestrator" },
    };
    const descriptor: ExecutionContinuityDescriptor = {
      workKey,
      scope: "attempt",
      state: "retry_queued",
      expectedAction,
      liveness,
      fence,
    };
    return {
      workKey,
      stage: "coding",
      condition: "retry_scheduled",
      expectedAction,
      currentOwner: { kind: "internal", authority: "orchestrator" },
      liveness,
      fence,
      descriptor,
    };
  }

  // Issue is open, ready for coding, but no active worker and no scheduled retry -> Stranded!
  const liveness: LivenessMetadata = {
    startedAt: now,
    lastProgressAt: "unknown",
    lastObservedAt: now,
  };
  const fence: SafeOwnershipFence = { hasLeaseToken: false };
  const expectedAction: ExpectedNextAction = {
    action: "dispatch",
    description: `Dispatch coding worker for ready issue ${issueId}`,
    authority: { kind: "internal", authority: "orchestrator", executor: "codex-agent" },
  };
  const descriptor: ExecutionContinuityDescriptor = {
    workKey,
    scope: "attempt",
    state: "running",
    expectedAction,
    liveness,
    fence,
  };
  const recoveryProposal: RecoveryProposal = {
    kind: "orchestrator_dispatch",
    authority: "orchestrator",
    issueId,
  };
  return {
    workKey,
    stage: "coding",
    condition: "stranded",
    strandedReason: "coding_worker_missing",
    expectedAction,
    currentOwner: { kind: "internal", authority: "orchestrator" },
    liveness,
    fence,
    recoveryProposal,
    descriptor,
  };
}

// ---------------------------------------------------------------------------
// 2. Recovery Delegation Authorities & Coordinator
// ---------------------------------------------------------------------------

export interface RecoveryAuthorities {
  readonly orchestrator?: {
    dispatch(issueId: string): Promise<boolean> | boolean;
    stopStalled(issueId: string): Promise<void>;
  } | undefined;
  readonly decision?: {
    releaseExpiredClaim(params: {
      taskId: string;
      expectedRevision?: number | undefined;
      expectedClaimGeneration?: number | undefined;
      expectedBindingGeneration?: number | undefined;
    }): Promise<{ released: boolean; reason?: string | undefined }>;
  } | undefined;
  readonly delivery?: {
    compensateHandoff(params: {
      workKey: WorkKey;
      expectedHandoffId?: string | undefined;
    }): Promise<{ success: boolean; error?: string | undefined }>;
    resumeRepair?(params: {
      workKey: WorkKey;
      target: { repository: string; prNumber: number; headSha: string };
    }): Promise<{ success: boolean; error?: string | undefined }>;
  } | undefined;
}

export interface WorkContinuityItemResult {
  readonly workKey: WorkKey;
  readonly analysis?: WorkContinuityAnalysis | undefined;
  readonly recoveryExecuted: boolean;
  readonly recoveryOutcome?: unknown | undefined;
  readonly error?: string | undefined;
}

export interface WorkContinuityReconciliationResult {
  readonly reconciledCount: number;
  readonly recoveredCount: number;
  readonly items: readonly WorkContinuityItemResult[];
}

export interface WorkContinuityCoordinatorOptions {
  readonly clock?: (() => UtcTimestampMs) | undefined;
  readonly factsReader: (workKey: WorkKey) => Promise<WorkItemFacts>;
  readonly activeWorkKeysSource: () => Promise<readonly WorkKey[]>;
  readonly authorities: RecoveryAuthorities;
  readonly deriveOptions?: DeriveWorkContinuityOptions | undefined;
  readonly log?: ((msg: string) => void) | undefined;
}

export class WorkContinuityCoordinator {
  private stopping = false;
  private readonly clock: () => UtcTimestampMs;

  constructor(private readonly options: WorkContinuityCoordinatorOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  public get isStopping(): boolean {
    return this.stopping;
  }

  public stop(): void {
    this.stopping = true;
  }

  /**
   * Performs one cycle of work continuity reconciliation:
   * observe authoritative facts -> derive -> if stranded: re-observe -> delegate recovery -> re-observe post-action.
   */
  public async reconcile(workKeys?: readonly WorkKey[]): Promise<WorkContinuityReconciliationResult> {
    if (this.stopping) {
      return { reconciledCount: 0, recoveredCount: 0, items: [] };
    }

    let targetKeys: readonly WorkKey[];
    try {
      targetKeys = workKeys ?? (await this.options.activeWorkKeysSource());
    } catch (err) {
      this.options.log?.(`[work-continuity] Failed to fetch active work keys: ${String(err)}`);
      return { reconciledCount: 0, recoveredCount: 0, items: [] };
    }

    const items: WorkContinuityItemResult[] = [];
    let recoveredCount = 0;

    for (const key of targetKeys) {
      if (this.stopping) {
        break;
      }

      try {
        // Step A: Observe authoritative facts
        const facts = await this.options.factsReader(key);

        // Step B: Pure derivation
        const analysis = deriveWorkContinuity(facts, this.clock(), this.options.deriveOptions);

        // Validate generated descriptor adheres to invariants
        const validation = validateContinuityDescriptor(analysis.descriptor);
        if (!validation.valid) {
          this.options.log?.(
            `[work-continuity] Invariant ${validation.invariant} violation for ${key.key}: ${validation.reason}`,
          );
        }

        // Step C: If stranded and recovery proposed, execute bounded delegation
        if (analysis.condition === "stranded" && analysis.recoveryProposal) {
          // Re-observe right before action to eliminate race conditions
          const preActionFacts = await this.options.factsReader(key);
          const preActionAnalysis = deriveWorkContinuity(preActionFacts, this.clock(), this.options.deriveOptions);

          if (
            preActionAnalysis.condition === "stranded" &&
            preActionAnalysis.recoveryProposal &&
            isSameRecoveryProposal(analysis.recoveryProposal, preActionAnalysis.recoveryProposal)
          ) {
            this.options.log?.(
              `[work-continuity] Delegating recovery '${analysis.recoveryProposal.kind}' for ${key.key}`,
            );
            const outcome = await this.delegateRecovery(key, preActionAnalysis.recoveryProposal);

            // Re-observe post-action
            const postActionFacts = await this.options.factsReader(key);
            const postActionAnalysis = deriveWorkContinuity(
              postActionFacts,
              this.clock(),
              this.options.deriveOptions,
            );

            items.push({
              workKey: key,
              analysis: postActionAnalysis,
              recoveryExecuted: true,
              recoveryOutcome: outcome,
            });
            recoveredCount++;
            continue;
          } else {
            this.options.log?.(
              `[work-continuity] State converged or changed before recovery execution for ${key.key}; recovery cancelled`,
            );
          }
        }

        items.push({
          workKey: key,
          analysis,
          recoveryExecuted: false,
        });
      } catch (err) {
        this.options.log?.(`[work-continuity] Error reconciling ${key.key}: ${String(err)}`);
        items.push({
          workKey: key,
          recoveryExecuted: false,
          error: String(err),
        });
      }
    }

    return {
      reconciledCount: items.length,
      recoveredCount,
      items,
    };
  }

  private async delegateRecovery(workKey: WorkKey, proposal: RecoveryProposal): Promise<unknown> {
    const { authorities } = this.options;
    switch (proposal.kind) {
      case "decision_release_expired_claim": {
        if (!authorities.decision) {
          throw new Error("Decision authority adapter not configured for release_expired_claim");
        }
        return await authorities.decision.releaseExpiredClaim({
          taskId: proposal.taskId,
          expectedRevision: proposal.revision,
          expectedClaimGeneration: proposal.claimGeneration,
          expectedBindingGeneration: proposal.bindingGeneration,
        });
      }

      case "orchestrator_stop_stalled": {
        if (!authorities.orchestrator) {
          throw new Error("Orchestrator authority adapter not configured for stop_stalled");
        }
        await authorities.orchestrator.stopStalled(proposal.issueId);
        return { stopped: true };
      }

      case "orchestrator_dispatch": {
        if (!authorities.orchestrator) {
          throw new Error("Orchestrator authority adapter not configured for dispatch");
        }
        return await authorities.orchestrator.dispatch(proposal.issueId);
      }

      case "delivery_compensate": {
        if (!authorities.delivery) {
          throw new Error("Delivery authority adapter not configured for compensate");
        }
        return await authorities.delivery.compensateHandoff({
          workKey,
          expectedHandoffId: proposal.handoffId,
        });
      }

      case "delivery_resume_repair": {
        if (!authorities.delivery?.resumeRepair) {
          // If no resumeRepair method, treat as diagnostic
          return { supported: false, message: "Delivery resume repair delegated" };
        }
        return await authorities.delivery.resumeRepair({
          workKey,
          target: proposal.target,
        });
      }

      default:
        return { unsupported: true, proposal };
    }
  }
}
