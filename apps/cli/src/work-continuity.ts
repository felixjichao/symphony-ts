import { RecoveryIncidentReporter } from "./recovery-reporter";
import { deliveryAuthorityBlock } from "./file-authority";
import { createHash } from "node:crypto";
import { FileWorkRecoveryStorage } from "./recovery-storage";
/** Composition of authoritative sources. No operations/read-model dependency. */
import fs from "node:fs";
import path from "node:path";
import { recoverDeliveryHandoff, runDeliverySkill } from "@symphony/agent";
import { githubDecisionRoot, decisionSessionId, parseDecisionSessionRootFromId, validateOwnershipFence, mapNativeRecoveryBlock,
  type Issue, type WorkKey, type WorkContinuityObservation, type WorkRecoveryRequest, type WorkRecoveryResult,
} from "@symphony/domain";
import { GitHubDeliveryService } from "@symphony/tracker";
import type { DecisionPlanningGate } from "@symphony/decision";
import { WorkContinuityCoordinator, isActiveState, issueRoutable, type OrchestratorAuthority } from "@symphony/orchestrator";
import type { EffectiveRuntimeController } from "./effective-runtime";
import { FileDeliveryStateStorage, withDeliveryAuthority } from "./delivery-skill-cli";
import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

export function createHostWorkContinuity(options: {
  controller: EffectiveRuntimeController;
  recovery?: ReturnType<typeof import("./host-recovery").createHostRecovery>;
  authority: OrchestratorAuthority;
  planningGate: DecisionPlanningGate | null;
  reviewGate?: import("@symphony/domain").DeliveryReviewGate | undefined;
  runner?: import("@symphony/agent").DeliveryGitGhRunner | undefined;
  resolveSession: (issue: Issue) => string | null;
  now: () => number;
  github?: Pick<GitHubDeliveryService, "observeWork"> | undefined;
  onObservation?: ((observation: WorkContinuityObservation) => void) | undefined;
}) {
  const { controller, authority, planningGate, resolveSession, now } = options;
  const identities = new Map<string, { key: WorkKey; issueId: string | null; workspace: string | null }>();
  const runner = options.runner ?? new DefaultDeliveryGitGhRunner(() => controller.current.excludeEnvNames);
  const add = (key: WorkKey, issueId: string | null, workspace: string | null) => {
    const id = decisionSessionId(key);
    const old = identities.get(id);
    identities.set(id, { key, issueId: issueId ?? old?.issueId ?? null, workspace: workspace ?? old?.workspace ?? null });
  };
  const read = async (key: WorkKey): Promise<{ observation: WorkContinuityObservation; issue: Issue | null }> => {
    const identity = identities.get(decisionSessionId(key));
    // Every union-only key still requires a current tracker observation. No cache-based ownership changes.
    const candidates = identity?.issueId
      ? await controller.current.adapter.fetchIssuesByIds([identity.issueId])
      : await controller.current.adapter.fetchIssuesByStates(controller.current.scheduling.policy.activeStates);
    const candidate = candidates.find(item => resolveSession(item) === decisionSessionId(key));
    const issue = candidate ? structuredClone(candidate) : undefined;
    const observedAt = now();
    const base: WorkContinuityObservation = { workKey: key, observedAt, version: "", active: false, stage: "coding",
      available: true, unavailableSources: [], expectedFence: {}, owner: null, blocked: null,
      externalWait: null, scheduled: null, contradictions: [] };
    if (!issue) return { observation: { ...base, available: false, unavailableSources: ["tracker_work_not_visible"] }, issue: null };
    const workspace = identity?.workspace ?? controller.current.workspaceManager.resolveWorkspacePath(issue.identifier);
    const delivery = new FileDeliveryStateStorage(path.join(workspace, ".symphony", "delivery-state.json")).readState();
    const decision = planningGate ? (await planningGate.continuityWork()).find(work => decisionSessionId(work.workKey) === decisionSessionId(key)) : undefined;
    options.recovery?.resumeAuthorizedRetry(authority, issue.id, key);
    const runtime = authority.continuityOwner(issue.id);
    const retryEvidence = authority.continuityRetryReferences().find(record => record.issueId === issue.id);
    // The original scheduler retains actual timer ownership (including due/in-flight refresh).
    let facts: WorkContinuityObservation = { ...base, active: isActiveState(issue.state, controller.current.scheduling.policy), owner: runtime,
      expectedFence: runtime?.fence ?? (retryEvidence?.token ? { retryToken: retryEvidence.token } : {}), scheduled: authority.continuitySchedule(issue.id),
      ...(retryEvidence ? { nativeRecovery: { attempts: retryEvidence.legacyRecoveryAttempts, epoch: 0, lastProgressAt: "unknown" as const, actions: [] } } : {}),
      ...(delivery?.isPaused && delivery.handoff?.handoffId ? { handoffRef: { handoffId: delivery.handoff.handoffId, headSha: delivery.handoff.headSha } } : {}),
      blocked: authority.continuityBlock(issue.id) ?? (delivery?.isPaused ? delivery.pauseReason ?? "delivery_paused" : null) };
    const pendingTasks = decision?.tasks.filter(t => t.status === "pending" || t.status === "claimed" || t.status === "running") ?? [];
    let github: Awaited<ReturnType<GitHubDeliveryService["observeWork"]>> | null = null;
    if (key.provider === "github") {
      const split = key.key.lastIndexOf("#");
      github = await (options.github ?? new GitHubDeliveryService()).observeWork({ repo: key.key.slice(0, split),
        issueNumber: Number(key.key.slice(split + 1)), workspaceKey: delivery?.workspaceKey ?? issue.identifier,
        headBranch: delivery?.continuation?.headBranch ?? delivery?.landing?.context.headBranch ?? delivery?.handoff?.headBranch ?? `symphony/${issue.identifier}`, baseBranch: delivery?.continuation?.baseBranch ?? delivery?.landing?.context.baseBranch ?? "main" });
    }
    const matchesTarget = (target: import("@symphony/domain").DecisionReviewTarget | null) => !!target && !!github?.pullRequest
      && target.headSha === github.pullRequest.headSha && target.prNumber === github.pullRequest.number
      && target.repository.toLowerCase() === key.key.slice(0, key.key.lastIndexOf("#")).toLowerCase();
    // Revisions only order tasks within a target. Other targets still participate in conflict checks.
    const matchingReviews = pendingTasks.filter(t => t.kind === "review" && matchesTarget(t.target));
    const task = (matchingReviews.length ? matchingReviews : pendingTasks.filter(t => t.kind === "plan"))
      .sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id))[0];
    if (pendingTasks.some(t => t.kind === "review" && !matchesTarget(t.target))) {
      facts = { ...facts, contradictions: ["decision_review_targets_stale_head"] };
    }
    if (delivery && `${delivery.repo.toLowerCase()}#${delivery.issueNumber}` !== key.key.toLowerCase()) {
      facts = { ...facts, contradictions: ["delivery_work_identity_mismatch"] };
    } else if (delivery?.isPaused && delivery.pendingCompensation) {
      facts = { ...facts, stage: "handoff", owner: null, expectedFence: {},
        handoffRef: delivery.handoff?.handoffId ? { handoffId: delivery.handoff.handoffId, headSha: delivery.handoff.headSha } : undefined };
    } else if (task && decision) {
      const fence = { leaseGeneration: task.claimGeneration, bindingGeneration: decision.bindingGeneration,
        ...(task.target ? { expectedHeadSha: task.target.headSha } : {}) };
      facts = { ...facts, stage: task.kind, expectedFence: fence, target: task.target ?? undefined, taskRef: { taskId: task.id, revision: task.revision },
        contradictions: runtime ? ["runtime_and_decision_ownership_overlap"] : facts.contradictions,
        nativeRecovery: { lastProgressAt: task.execution?.lastProgressAtMs ?? "unknown", attempts: Math.max(task.execution?.recoveryAttempts ?? 0, task.execution?.blocked?.recoveryCount ?? 0), epoch: task.execution?.recoveryEpoch ?? 0, actions: task.execution?.recoveryActions ?? [] },
        blocked: task.execution?.blocked ? `${task.execution.blocked.reason}: ${task.execution.blocked.unblock}` : facts.blocked,
        externalWait: !task.owner ? { system: "browser", condition: "enabled_configured_chatgpt_page_required" } : facts.externalWait,
        owner: task.owner && task.leaseExpiresAtMs !== null ? { id: task.owner, fence: { ...fence, bindingGeneration: task.claimBindingGeneration ?? decision.bindingGeneration },
          leaseExpiresAt: task.leaseExpiresAtMs, liveness: { startedAt: task.execution?.startedAtMs ?? task.createdAtMs, lastProgressAt: task.execution && task.execution.phase !== "claimed" && task.execution.phase !== "unknown" ? task.execution.lastProgressAtMs : "unknown", lastObservedAt: observedAt,
            ...(task.execution ? { deadlineAt: task.execution.deadlineAtMs } : {}) } } : null };
    } else if (planningGate && !runtime && !delivery?.isPaused) {
      const eligible = await planningGate.verifyPlanEligibility(decisionSessionId(key), { title: issue.title, body: issue.description ?? "" });
      if (!eligible.eligible) facts = { ...facts, stage: "plan", blocked: eligible.reason ?? "planning_admission_denied" };
    }
    // Merged is an authoritative stage boundary even while local executors remain.
    if (github?.pullRequest?.state === "merged" && facts.stage !== "handoff") {
      facts = { ...facts, stage: "merge",
        target: { repository: key.key.slice(0, key.key.lastIndexOf("#")), prNumber: github.pullRequest.number, headSha: github.pullRequest.headSha },
        externalWait: delivery?.landing?.phase === "intent" ? null : { system: "tracker", condition: "merged_pull_request_waiting_for_tracker_sync" },
        contradictions: runtime || pendingTasks.some(t => t.kind === "plan")
          ? [...facts.contradictions, "merged_pull_request_has_conflicting_executor"] : facts.contradictions };
    } else if (!delivery?.isPaused && !runtime && github?.pullRequest && !task) {
      const pr = github.pullRequest;
      facts = { ...facts, stage: "delivery", target: { repository: key.key.slice(0, key.key.lastIndexOf("#")), prNumber: pr.number, headSha: pr.headSha },
        expectedFence: { expectedHeadSha: pr.headSha } };
      if (pr.state === "closed") facts = { ...facts, blocked: "pull_request_closed_unmerged" };
      else if (pr.isDraft) facts = { ...facts, externalWait: { system: "human", condition: "publish_draft_pull_request" } };
      else if (!github.ci || github.ci.headSha !== pr.headSha) facts = { ...facts, available: false, unavailableSources: ["current_head_ci"] };
      else if (github.ci.status === "pending") facts = { ...facts, stage: "ci", externalWait: { system: "ci", condition: `checks_for_${pr.headSha}` } };
      else if (github.ci.status === "failure") facts = { ...facts, stage: "repair" };
      else {
        const review = decision?.tasks.filter(t => t.kind === "review" && matchesTarget(t.target) && t.status === "completed")
          .sort((a, b) => b.revision - a.revision)[0];
        facts = { ...facts, stage: review?.verdict === "changes_requested" ? "repair" : review?.verdict === "approve" ? "delivery" : "review",
          blocked: review?.verdict === "needs_human" ? "review_requires_human" : facts.blocked };
      }
    }
    if (!delivery?.isPaused && delivery?.mergeConflictRepair
      && delivery.mergeConflictRepair.phase !== "pushed" && !runtime && !task && github?.pullRequest?.state === "open") {
      facts = { ...facts, stage: "repair", externalWait: null };
    }
    if (delivery?.landing?.phase === "intent" && github?.pullRequest
      && (github.pullRequest.headSha !== delivery.landing.headSha || github.pullRequest.number !== delivery.landing.prNumber)) {
      facts = { ...facts, blocked: "landing_target_superseded: explicit authorization for current HEAD required" };
    }
    if (delivery?.continuation?.phase === "ready" && !delivery.continuation.optInLand
      && facts.stage === "delivery" && !facts.blocked) {
      facts = { ...facts, externalWait: { system: "human", condition: "explicit_merge_opt_in_required" } };
    }
    if (github?.issue.state === "closed" && facts.active) facts = { ...facts, available: false,
      unavailableSources: [...facts.unavailableSources, "remote_issue_closed_tracker_active"] };
    if (facts.stage !== "coding" && facts.scheduled?.kind === "retry") facts = { ...facts, scheduled: null,
      contradictions: [...facts.contradictions, "runtime_retry_conflicts_with_next_stage"] };
    if (pendingTasks.length > 1) facts = { ...facts, contradictions: [...facts.contradictions, "multiple_active_decision_tasks"] };
    if (facts.stage === "handoff" && (runtime || pendingTasks.length)) facts = { ...facts,
      contradictions: [...facts.contradictions, "delivery_and_execution_ownership_overlap"] };
    if (!issueRoutable(issue, controller.current.scheduling.policy) && !facts.blocked) facts = { ...facts, blocked: "tracker_admission_denied" };
    // Pin the initial snapshot and refresh the keyed tracker admission after remote I/O.
    const latestIssue = (await controller.current.adapter.fetchIssuesByIds([issue.id]))
      .find(item => item.id === issue.id && resolveSession(item) === decisionSessionId(key));
    if (!latestIssue || JSON.stringify(latestIssue) !== JSON.stringify(issue)) facts = { ...facts, available: false,
      unavailableSources: [...facts.unavailableSources, "tracker_changed_during_observation"] };
    // Remote reads may take time. Reject a mixed snapshot if native ownership or
    // pause state changed while HEAD/CI/planning facts were being collected.
    if (planningGate) {
      const latestDecision = (await planningGate.continuityWork()).find(work => decisionSessionId(work.workKey) === decisionSessionId(key));
      if (JSON.stringify(latestDecision) !== JSON.stringify(decision)) {
        facts = { ...facts, available: false, unavailableSources: [...facts.unavailableSources, "decision_changed_during_observation"] };
      }
    }
    const lockBlock = deliveryAuthorityBlock(path.join(workspace, ".symphony", "delivery-authority.lock"));
    if (lockBlock) facts = { ...facts, stage: delivery?.mergeConflictRepair && delivery.mergeConflictRepair.phase !== "pushed"
      && !delivery.isPaused ? "repair" : "delivery", blocked: lockBlock };
    const latestDelivery = new FileDeliveryStateStorage(path.join(workspace, ".symphony", "delivery-state.json")).readState();
    if (JSON.stringify(latestDelivery) !== JSON.stringify(delivery)) {
      facts = { ...facts, available: false, unavailableSources: [...facts.unavailableSources, "delivery_changed_during_observation"] };
    }
    const version = createHash("sha256").update(JSON.stringify({ issue, stage: facts.stage, blocked: facts.blocked, fence: facts.expectedFence,
      github, execution: task?.execution, owner: facts.owner?.id, lease: facts.owner?.leaseExpiresAt, task: facts.taskRef, delivery,
      policy: controller.current.scheduling.policy, config: controller.current.serviceConfig })).digest("hex");
    const nativeBlock = mapNativeRecoveryBlock(facts.blocked?.split(":")[0] ?? "");
    const normalized = { ...facts, version, ...(nativeBlock ? { nativeBlock } : {}) };
    const observation = options.recovery?.observe(normalized) ?? normalized;
    options.onObservation?.(observation);
    return { observation, issue };
  };
  const observe = async (key: WorkKey) => (await read(key)).observation;
  const reporter = options.recovery ? new RecoveryIncidentReporter(options.recovery.ledger, runner, process.cwd()) : null;
  const coordinator = new WorkContinuityCoordinator({
    reportIncidents: async canCommit => {
      try { await reporter?.publish(async incident => {
        const fresh = await observe(incident.workKey);
        return fresh.available && fresh.active && (fresh.recoveryIncidentId === incident.id || options.recovery?.isNativeIncident(fresh, incident.id) === true);
      }, canCommit); } catch { /* Durable local report remains available; no recursive incidents. */ }
    },
    recoveryStorage: new FileWorkRecoveryStorage(path.join(controller.current.serviceConfig.workspace.root, ".symphony-host", "recovery.json")),
    canCommitRecovery: request => options.recovery?.canCommit(request) ?? true,
    onRefused: request => options.recovery?.refused(request),
    onUnverified: (request, current) => options.recovery?.unverified(request, current),
    authorizeRecovery: (request, current) => options.recovery?.authorize(request, current) ?? true,
    canResumeRecovery(request, current) {
      if (current.recoveryIncidentId) return false;
      if (request.action === "reclaim") return current.stage === request.stage && !!current.owner
        && current.taskRef?.taskId === request.taskRef?.taskId && current.taskRef?.revision === request.taskRef?.revision
        && current.owner.leaseExpiresAt === request.leaseExpiresAt && current.observedAt >= (request.leaseExpiresAt ?? Infinity);
      const identity = identities.get(decisionSessionId(request.workKey));
      if (request.action === "compensate") {
        if (!identity?.workspace || !request.handoffRef) return false;
        const state = new FileDeliveryStateStorage(path.join(identity.workspace, ".symphony", "delivery-state.json")).readState();
        return !!state?.isPaused && !!state.pendingCompensation
          && state.handoff?.handoffId === request.handoffRef.handoffId && state.handoff.headSha === request.handoffRef.headSha;
      }
      return request.action === "dispatch" && !current.blocked && current.contradictions.length === 0
        && ["review", "delivery", "repair", "ci", "merge"].includes(current.stage);
    },
    async isRecoveryResolved(request) {
      if (request.action === "reclaim" && request.taskRef && planningGate) {
        const work = (await planningGate.continuityWork()).find(w => decisionSessionId(w.workKey) === decisionSessionId(request.workKey));
        const task = work?.tasks.find(t => t.id === request.taskRef?.taskId);
        if (!work || !task) return false; // disappearing/unreadable records are not completion evidence
        return task.status !== "claimed" && task.status !== "running"
          || task.revision !== request.taskRef.revision || task.claimGeneration !== request.fence.leaseGeneration
          || work.bindingGeneration !== request.fence.bindingGeneration || task.leaseExpiresAtMs !== request.leaseExpiresAt;
      }
      if (request.action === "dispatch") {
        const identity = identities.get(decisionSessionId(request.workKey));
        if (identity?.workspace) {
          const state = new FileDeliveryStateStorage(path.join(identity.workspace, ".symphony", "delivery-state.json")).readState();
          if (state && `${state.repo.toLowerCase()}#${state.issueNumber}` === request.workKey.key.toLowerCase()) {
            if (state.isPaused && state.handoff?.handoffId) return true;
            if (state.landing?.phase === "observed" && state.landing.headSha === request.fence.expectedHeadSha) return true;
            const c = state.continuation;
            if (c && c.headSha === request.fence.expectedHeadSha && c.phase === "ready") return true;
            if (c && c.headSha === request.fence.expectedHeadSha && c.reviewTaskId && planningGate) {
              const work = (await planningGate.continuityWork()).find(w => decisionSessionId(w.workKey) === decisionSessionId(request.workKey));
              const task = work?.tasks.find(t => t.id === c.reviewTaskId);
              if (task?.kind === "review" && task.revision === c.reviewRevision && task.target?.headSha === c.headSha
                && task.target.prNumber === c.prNumber) return true;
            }
          }
        }
      }
      const identity = identities.get(decisionSessionId(request.workKey));
      if (request.action === "compensate" && request.handoffRef && identity?.workspace) {
        const state = new FileDeliveryStateStorage(path.join(identity.workspace, ".symphony", "delivery-state.json")).readState();
        if (!state || `${state.repo.toLowerCase()}#${state.issueNumber}` !== request.workKey.key.toLowerCase()) return false;
        return state.pendingCompensation === false || !!state.handoff?.handoffId
          && (state.handoff.handoffId !== request.handoffRef.handoffId || state.handoff.headSha !== request.handoffRef.headSha);
      }
      return false;
    },
    async listWork() {
      for (const budget of options.recovery?.ledger.list() ?? []) if (budget.incident) add(budget.incident.workKey, null, null);
      const issues = await controller.current.adapter.fetchIssuesByStates(controller.current.scheduling.policy.activeStates);
      for (const issue of issues) {
        const id = resolveSession(issue);
        if (id) {
          add(parseDecisionSessionRootFromId(id), issue.id, controller.current.workspaceManager.resolveWorkspacePath(issue.identifier));
        }
      }
      for (const retry of authority.continuityRetryReferences()) {
        if (retry.workKey) add(retry.workKey, retry.issueId, null);
        const match = retry.url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
        if (match?.[1] && match[2] && match[3]) add(githubDecisionRoot(match[1], match[2], Number(match[3])), retry.issueId, null);
      }
      for (const issue of authority.continuityIssues()) {
        const id = resolveSession(issue);
        if (id) add(parseDecisionSessionRootFromId(id), issue.id, null);
      }
      if (planningGate) {
        try { for (const work of await planningGate.continuityWork()) add(work.workKey, null, null); }
        catch { /* active tracker keys remain scannable; per-work reads fail closed */ }
      }
      const root = controller.current.serviceConfig.workspace.root;
      if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const workspace = path.join(root, entry.name);
          const file = path.join(workspace, ".symphony", "delivery-state.json");
          try {
            const delivery = new FileDeliveryStateStorage(file).readState();
            if (delivery) add({ provider: "github", key: `${delivery.repo.toLowerCase()}#${delivery.issueNumber}` }, null, workspace);
          } catch { /* a corrupt workspace cannot hide other active work */ }
        }
      }
      return [...identities.values()].map(item => item.key);
    },
    observe,
    async recover(request: WorkRecoveryRequest, canCommit): Promise<WorkRecoveryResult> {
      let mutationMayHaveStarted = false;
      try {
        const fresh = await observe(request.workKey);
        if (!canCommit()) return "stopped";
        if (fresh.recoveryIncidentId || fresh.version !== request.version || !fresh.available || fresh.stage !== request.stage) return "stale";
        if (request.action === "reclaim" && request.taskRef && planningGate) {
          const work = (await planningGate.continuityWork()).find(w => decisionSessionId(w.workKey) === decisionSessionId(request.workKey));
          const task = work?.tasks.find(t => t.id === request.taskRef?.taskId);
          if (!canCommit()) return "stopped";
          if (!work || !task || task.leaseExpiresAtMs === null) return "stale";
          mutationMayHaveStarted = true;
          return await planningGate.reclaimExpiredClaim({ taskId: request.taskRef.taskId, revision: request.taskRef.revision,
            claimGeneration: request.fence.leaseGeneration ?? -1, bindingGeneration: request.fence.bindingGeneration ?? -1,
            leaseExpiresAtMs: fresh.owner?.leaseExpiresAt ?? -1 }) ? "applied" : "stale";
        }
        const identity = identities.get(decisionSessionId(request.workKey));
        if (request.action === "compensate" && identity?.workspace) {
          return await withDeliveryAuthority(identity.workspace, async () => {
            const locked = await observe(request.workKey);
            if (!canCommit()) return "stopped";
            if (locked.version !== request.version) return "stale";
            const storage = new FileDeliveryStateStorage(path.join(identity.workspace!, ".symphony", "delivery-state.json"), true);
            const delivery = storage.readState();
            if (!delivery?.handoff?.handoffId || !delivery.isPaused || !delivery.pendingCompensation) return "unsupported";
            if (request.handoffRef && request.handoffRef.handoffId !== delivery.handoff.handoffId) return "stale";
            mutationMayHaveStarted = true;
            const result = await recoverDeliveryHandoff({ cwd: identity.workspace!, repo: delivery.repo,
              issueNumber: delivery.issueNumber, workspaceKey: delivery.workspaceKey, stateStorage: storage, runner });
            return result.success ? "applied" : "unverified";
          });
        }
        if (request.action === "dispatch" && identity?.workspace
          && (options.reviewGate || request.stage === "merge")
          && ["review", "delivery", "repair", "ci", "merge"].includes(request.stage)) {
          return await withDeliveryAuthority(identity.workspace, async () => {
            const locked = await read(request.workKey);
            if (!canCommit()) return "stopped";
            if (locked.observation.version !== request.version || !locked.observation.available
              || locked.observation.blocked || locked.observation.owner || !locked.issue) return "stale";
            const storage = new FileDeliveryStateStorage(path.join(identity.workspace!, ".symphony", "delivery-state.json"), true);
            const delivery = storage.readState();
            if (delivery?.isPaused) return "stale";
            let plan: import("@symphony/domain").DecisionMaterializedPlan | undefined;
            if (planningGate) {
              const eligibility = await planningGate.verifyPlanEligibility(decisionSessionId(request.workKey),
                { title: locked.issue.title, body: locked.issue.description ?? "" });
              if (!eligibility.eligible || !canCommit()) return "stale";
              const record = await planningGate.getLatestPlan(decisionSessionId(request.workKey));
              if (record?.result?.verdict === "ready") plan = { taskId: record.taskId, revision: record.revision,
                ...record.result.content, clarifications: record.requirements.clarifications };
            }
            if (request.stage === "merge" && delivery?.landing?.phase === "intent") {
              const { FileLandingIntentStorage, createNativeDeliveryService } = await import("./landing-storage");
              mutationMayHaveStarted = true;
              const intent = delivery.landing;
              const pr = await createNativeDeliveryService().readPr(intent.context, { prNumber: intent.prNumber });
              if (!canCommit()) return "stopped";
              if (pr.state !== "MERGED" || pr.headSha !== intent.headSha || !pr.mergeCommitSha || !pr.mergedAt) return "stale";
              new FileLandingIntentStorage(identity.workspace!, true).write({ ...intent, phase: "observed", mergeCommitSha: pr.mergeCommitSha, mergedAt: pr.mergedAt });
              return "applied";
            }
            const saved = delivery?.continuation;
            const split = request.workKey.key.lastIndexOf("#");
            mutationMayHaveStarted = true;
            await runDeliverySkill({ cwd: identity.workspace!, runner, stateStorage: storage,
              repo: request.workKey.key.slice(0, split), issueNumber: Number(request.workKey.key.slice(split + 1)),
              workspaceKey: delivery?.workspaceKey ?? locked.issue.identifier,
              headBranch: saved?.headBranch ?? delivery?.landing?.context.headBranch ?? `symphony/${locked.issue.identifier}`,
              baseBranch: saved?.baseBranch ?? delivery?.landing?.context.baseBranch ?? "main",
              optInLand: saved?.optInLand ?? delivery?.landing?.optIn ?? false,
              requiredChecks: saved?.requiredChecks, readyLabel: saved?.readyLabel,
              maxRepairAttempts: saved?.maxRepairAttempts, maxWaitSeconds: saved?.maxWaitSeconds,
              repairCommand: saved?.repairCommand, validationCommand: saved?.validationCommand,
              validationTimeoutMs: saved?.validationTimeoutMs,
              reviewGate: options.reviewGate, canCommit, plan, resumeStageOnly: true, yieldOnWait: true });
            return "applied";
          });
        }
        // Coding is admitted by the normal dispatch loop; browser/repair/merge recovery
        // requires a safe native primitive. Diagnosis must not substitute replaying a command.
        return "unsupported";
      } catch (error) {
        // Reclaim is one atomic local Decision transaction. Exact unchanged claim
        // readback proves no mutation, unlike a subprocess/Send/merge timeout.
        if (mutationMayHaveStarted && request.action === "reclaim") {
          try {
            const after = await observe(request.workKey);
            if (after.available && !after.blocked && after.taskRef?.taskId === request.taskRef?.taskId
              && after.taskRef?.revision === request.taskRef?.revision
              && after.owner?.leaseExpiresAt === request.leaseExpiresAt
              && validateOwnershipFence(request.fence, after.expectedFence).valid) return "failed";
          } catch { /* Missing readback never proves that a mutation failed. */ }
        }
        if (!mutationMayHaveStarted) return "stale"; // certified no commit, including lock acquisition failure
        throw error;
      }
    },
  });
  return {
    coordinator,
    /** A launch reads the sources itself; observations from a previous scan never grant admission. */
    async refreshDispatch(issue: Issue): Promise<Issue | null> {
      const id = resolveSession(issue);
      if (!id) return issue; // continuity currently supports mapped work roots only
      const key = parseDecisionSessionRootFromId(id);
      add(key, issue.id, controller.current.workspaceManager.resolveWorkspacePath(issue.identifier));
      const current = await read(key);
      const f = current.observation;
      if (!f.available) throw new Error("Continuity dispatch observation unavailable");
      if (coordinator.hasUnverifiedRecovery(key)) return null;
      return f.active && f.stage === "coding" && !f.blocked && !f.externalWait
        && !f.owner && f.contradictions.length === 0 ? current.issue : null;
    },
  };
}
