/** Composition of authoritative sources. No operations/read-model dependency. */
import fs from "node:fs";
import path from "node:path";
import { recoverDeliveryHandoff } from "@symphony/agent";
import { githubDecisionRoot, decisionSessionId, parseDecisionSessionRootFromId,
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
  authority: OrchestratorAuthority;
  planningGate: DecisionPlanningGate | null;
  resolveSession: (issue: Issue) => string | null;
  now: () => number;
  github?: Pick<GitHubDeliveryService, "observeWork"> | undefined;
  onObservation?: ((observation: WorkContinuityObservation) => void) | undefined;
}) {
  const { controller, authority, planningGate, resolveSession, now } = options;
  const identities = new Map<string, { key: WorkKey; issueId: string | null; workspace: string | null }>();
  const runner = new DefaultDeliveryGitGhRunner();
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
    const issue = candidates.find(item => resolveSession(item) === decisionSessionId(key));
    const observedAt = now();
    const base: WorkContinuityObservation = { workKey: key, observedAt, version: "", active: false, stage: "coding",
      available: true, unavailableSources: [], expectedFence: {}, owner: null, blocked: null,
      externalWait: null, scheduled: null, contradictions: [] };
    if (!issue) return { observation: { ...base, available: false, unavailableSources: ["tracker_work_not_visible"] }, issue: null };
    const workspace = identity?.workspace ?? controller.current.workspaceManager.resolveWorkspacePath(issue.identifier);
    const delivery = new FileDeliveryStateStorage(path.join(workspace, ".symphony", "delivery-state.json")).readState();
    const decision = planningGate ? (await planningGate.continuityWork()).find(work => decisionSessionId(work.workKey) === decisionSessionId(key)) : undefined;
    const runtime = authority.continuityOwner(issue.id);
    // The original scheduler retains actual timer ownership (including due/in-flight refresh).
    let facts: WorkContinuityObservation = { ...base, active: isActiveState(issue.state, controller.current.scheduling.policy), owner: runtime,
      expectedFence: runtime?.fence ?? {}, scheduled: authority.continuitySchedule(issue.id),
      blocked: delivery?.isPaused ? delivery.pauseReason ?? "delivery_paused" : null };
    const pendingTasks = decision?.tasks.filter(t => t.status === "pending" || t.status === "claimed" || t.status === "running") ?? [];
    let github: Awaited<ReturnType<GitHubDeliveryService["observeWork"]>> | null = null;
    if (key.provider === "github") {
      const split = key.key.lastIndexOf("#");
      github = await (options.github ?? new GitHubDeliveryService()).observeWork({ repo: key.key.slice(0, split),
        issueNumber: Number(key.key.slice(split + 1)), workspaceKey: delivery?.workspaceKey ?? issue.identifier,
        headBranch: delivery?.handoff?.headBranch ?? `symphony/${issue.identifier}`, baseBranch: "main" });
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
        owner: task.owner && task.leaseExpiresAtMs !== null ? { id: task.owner, fence: { ...fence, bindingGeneration: task.claimBindingGeneration ?? decision.bindingGeneration },
          leaseExpiresAt: task.leaseExpiresAtMs, liveness: { startedAt: task.createdAtMs, lastProgressAt: "unknown", lastObservedAt: observedAt } } : null };
    } else if (planningGate && !runtime && !delivery?.isPaused) {
      const eligible = await planningGate.verifyPlanEligibility(decisionSessionId(key), { title: issue.title, body: issue.description ?? "" });
      if (!eligible.eligible) facts = { ...facts, stage: "plan", blocked: eligible.reason ?? "planning_admission_denied" };
    }
    if (!delivery?.isPaused && !runtime && github?.pullRequest && !task) {
      const pr = github.pullRequest;
      facts = { ...facts, stage: "delivery", target: { repository: key.key.slice(0, key.key.lastIndexOf("#")), prNumber: pr.number, headSha: pr.headSha }, expectedFence: { expectedHeadSha: pr.headSha } };
      if (pr.state === "merged") facts = { ...facts, stage: "merge",
        externalWait: { system: "tracker", condition: "merged_pull_request_waiting_for_tracker_sync" } };
      else if (pr.state === "closed") facts = { ...facts, blocked: "pull_request_closed_unmerged" };
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
    if (facts.stage !== "coding" && facts.scheduled?.kind === "retry") facts = { ...facts, scheduled: null,
      contradictions: [...facts.contradictions, "runtime_retry_conflicts_with_next_stage"] };
    if (pendingTasks.length > 1) facts = { ...facts, contradictions: [...facts.contradictions, "multiple_active_decision_tasks"] };
    if (facts.stage === "handoff" && (runtime || pendingTasks.length)) facts = { ...facts,
      contradictions: [...facts.contradictions, "delivery_and_execution_ownership_overlap"] };
    if (!issueRoutable(issue, controller.current.scheduling.policy) && !facts.blocked) facts = { ...facts, blocked: "tracker_admission_denied" };
    // Remote reads may take time. Reject a mixed snapshot if native ownership or
    // pause state changed while HEAD/CI/planning facts were being collected.
    if (planningGate) {
      const latestDecision = (await planningGate.continuityWork()).find(work => decisionSessionId(work.workKey) === decisionSessionId(key));
      if (JSON.stringify(latestDecision) !== JSON.stringify(decision)) {
        facts = { ...facts, available: false, unavailableSources: [...facts.unavailableSources, "decision_changed_during_observation"] };
      }
    }
    const latestDelivery = new FileDeliveryStateStorage(path.join(workspace, ".symphony", "delivery-state.json")).readState();
    if (JSON.stringify(latestDelivery) !== JSON.stringify(delivery)) {
      facts = { ...facts, available: false, unavailableSources: [...facts.unavailableSources, "delivery_changed_during_observation"] };
    }
    const version = JSON.stringify({ issue, stage: facts.stage, blocked: facts.blocked, fence: facts.expectedFence,
      github, owner: facts.owner?.id, lease: facts.owner?.leaseExpiresAt, task: facts.taskRef, delivery,
      policy: controller.current.scheduling.policy, config: controller.current.serviceConfig });
    const observation = { ...facts, version };
    options.onObservation?.(observation);
    return { observation, issue };
  };
  const observe = async (key: WorkKey) => (await read(key)).observation;
  const coordinator = new WorkContinuityCoordinator({
    async isRecoveryResolved(request) {
      if (request.action === "reclaim" && request.taskRef && planningGate) {
        const work = (await planningGate.continuityWork()).find(w => decisionSessionId(w.workKey) === decisionSessionId(request.workKey));
        const task = work?.tasks.find(t => t.id === request.taskRef?.taskId);
        if (!work || !task) return false; // disappearing/unreadable records are not completion evidence
        return task.status !== "claimed" && task.status !== "running"
          || task.revision !== request.taskRef.revision || task.claimGeneration !== request.fence.leaseGeneration
          || work.bindingGeneration !== request.fence.bindingGeneration || task.leaseExpiresAtMs !== request.leaseExpiresAt;
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
      const issues = await controller.current.adapter.fetchIssuesByStates(controller.current.scheduling.policy.activeStates);
      for (const issue of issues) {
        const id = resolveSession(issue);
        if (id) {
          add(parseDecisionSessionRootFromId(id), issue.id, controller.current.workspaceManager.resolveWorkspacePath(issue.identifier));
        }
      }
      for (const retry of authority.continuityRetryReferences()) {
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
      const fresh = await observe(request.workKey);
      if (!canCommit()) return "stopped";
      if (fresh.version !== request.version || !fresh.available) return "stale";
      if (request.action === "reclaim" && request.taskRef && planningGate) {
        const work = (await planningGate.continuityWork()).find(w => decisionSessionId(w.workKey) === decisionSessionId(request.workKey));
        const task = work?.tasks.find(t => t.id === request.taskRef?.taskId);
        if (!canCommit()) return "stopped";
        if (!work || !task || task.leaseExpiresAtMs === null) return "stale";
        return await planningGate.reclaimExpiredClaim({ taskId: request.taskRef.taskId, revision: request.taskRef.revision,
          claimGeneration: request.fence.leaseGeneration ?? -1, bindingGeneration: request.fence.bindingGeneration ?? -1,
          leaseExpiresAtMs: fresh.owner?.leaseExpiresAt ?? -1 }) ? "applied" : "stale";
      }
      const identity = identities.get(decisionSessionId(request.workKey));
      if (request.action === "compensate" && identity?.workspace) {
        return withDeliveryAuthority(identity.workspace, async () => {
          const locked = await observe(request.workKey);
          if (!canCommit()) return "stopped";
          if (locked.version !== request.version) return "stale";
          const storage = new FileDeliveryStateStorage(path.join(identity.workspace!, ".symphony", "delivery-state.json"), true);
          const delivery = storage.readState();
          if (!delivery?.handoff?.handoffId || !delivery.isPaused || !delivery.pendingCompensation) return "unsupported";
          const result = await recoverDeliveryHandoff({ cwd: identity.workspace!, repo: delivery.repo,
            issueNumber: delivery.issueNumber, workspaceKey: delivery.workspaceKey, stateStorage: storage, runner });
          return result.success ? "applied" : "unverified";
        });
      }
      // Coding is admitted by the normal dispatch loop; browser/repair/merge recovery
      // requires a safe native primitive. Diagnosis must not substitute replaying a command.
      return "unsupported";
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
