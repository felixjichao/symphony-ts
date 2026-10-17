import {
  decisionSessionId,
  parseDecisionSessionRootFromId,
  formatPlanCommentMarkdown,
  parsePlanCommentMarker,
  type DecisionContextBundle,
  type DecisionReviewTarget,
  type DecisionTask,
  type PlanningEligibilityResult,
  type WorkItemFacts,
  type WorkKey,
} from "@symphony/domain";
import { DecisionBridgeClient } from "./client.js";
import { DecisionService } from "./service.js";
import type { DecisionPlanRecord } from "./types.js";

export interface DecisionPlanningGateOptions {
  readonly clientOrService: DecisionBridgeClient | DecisionService;
}

export interface EnsurePlanTaskOptions {
  readonly operationKey?: string | undefined;
  readonly context?: DecisionContextBundle | undefined;
  readonly triggerKind?: "initial" | "requirements_changed" | "clarification" | "retry" | undefined;
  readonly requirements?: {
    readonly title: string;
    readonly body: string;
    readonly clarifications?: readonly string[] | undefined;
  } | undefined;
  readonly previousTaskId?: string | null | undefined;
  readonly forceNew?: boolean | undefined;
}

export class DecisionPlanningGate {
  private readonly client: DecisionBridgeClient | null = null;
  private readonly service: DecisionService | null = null;

  constructor(clientOrService: DecisionBridgeClient | DecisionService) {
    if (clientOrService instanceof DecisionBridgeClient) {
      this.client = clientOrService;
    } else {
      this.service = clientOrService;
    }
  }

  get clientInstance(): DecisionBridgeClient | null {
    return this.client;
  }

  get serviceInstance(): DecisionService | null {
    return this.service;
  }

  async observeWork(workKey: WorkKey): Promise<NonNullable<WorkItemFacts["decision"]>> {
    if (this.service) {
      const obs = this.service.observeWork(workKey);
      const planTasks = obs.tasks.filter((t) => t.kind === "plan");
      planTasks.sort((a, b) => b.revision - a.revision);
      const latestPlan = planTasks[0];
      let planVerdict: "ready" | "needs_clarification" | "needs_human" | undefined = undefined;
      if (latestPlan) {
        const res = obs.results.find((r) => r.taskId === latestPlan.taskId && r.outcome.kind === "plan");
        if (res && res.outcome.kind === "plan") {
          planVerdict = res.outcome.verdict;
        }
      }

      const reviewTasks = obs.tasks.filter((t) => t.kind === "review");
      reviewTasks.sort((a, b) => b.revision - a.revision);
      const latestReview = reviewTasks[0];
      let reviewVerdict: "approve" | "changes_requested" | "needs_human" | undefined = undefined;
      if (latestReview) {
        const res = obs.results.find((r) => r.taskId === latestReview.taskId && r.outcome.kind === "review");
        if (res && res.outcome.kind === "review") {
          reviewVerdict = res.outcome.verdict;
        }
      }

      return {
        sessionStatus: obs.session?.status,
        bindingGeneration: obs.session?.bindingGeneration,
        latestPlanTask: latestPlan
          ? {
              taskId: latestPlan.taskId,
              revision: latestPlan.revision,
              status: latestPlan.status,
              claimGeneration: latestPlan.claimGeneration,
              verdict: planVerdict,
              lease: latestPlan.lease,
            }
          : null,
        latestReviewTask:
          latestReview && latestReview.target
            ? {
                taskId: latestReview.taskId,
                revision: latestReview.revision,
                status: latestReview.status,
                target: latestReview.target,
                claimGeneration: latestReview.claimGeneration,
                verdict: reviewVerdict,
                lease: latestReview.lease,
              }
            : null,
      };
    }

    if (this.client) {
      const sId = decisionSessionId(workKey);
      const { tasks } = await this.client.getTasksForSession(sId);
      const planTasks = tasks.filter((t) => t.kind === "plan");
      planTasks.sort((a, b) => b.revision - a.revision);
      const latestPlan = planTasks[0];
      let planVerdict: "ready" | "needs_clarification" | "needs_human" | undefined = undefined;
      if (latestPlan && latestPlan.status === "completed") {
        const res = await this.client.getTaskResult(latestPlan.id);
        if (res?.result && res.result.kind === "plan") {
          planVerdict = res.result.verdict;
        }
      }

      const reviewTasks = tasks.filter((t) => t.kind === "review");
      reviewTasks.sort((a, b) => b.revision - a.revision);
      const latestReview = reviewTasks[0];
      let reviewVerdict: "approve" | "changes_requested" | "needs_human" | undefined = undefined;
      if (latestReview && latestReview.status === "completed") {
        const res = await this.client.getTaskResult(latestReview.id);
        if (res?.result && res.result.kind === "review") {
          reviewVerdict = res.result.verdict;
        }
      }

      return {
        latestPlanTask: latestPlan
          ? {
              taskId: latestPlan.id,
              revision: latestPlan.revision,
              status: latestPlan.status,
              claimGeneration: latestPlan.claimGeneration,
              verdict: planVerdict,
              lease: latestPlan.lease
                ? {
                    owner: latestPlan.lease.owner,
                    generation: latestPlan.lease.generation,
                    expiresAtMs: latestPlan.lease.expiresAtMs,
                  }
                : null,
            }
          : null,
        latestReviewTask:
          latestReview && latestReview.kind === "review" && (latestReview as { target?: DecisionReviewTarget }).target
            ? {
                taskId: latestReview.id,
                revision: latestReview.revision,
                status: latestReview.status,
                target: (latestReview as { target: DecisionReviewTarget }).target,
                claimGeneration: latestReview.claimGeneration,
                verdict: reviewVerdict,
                lease: latestReview.lease
                  ? {
                      owner: latestReview.lease.owner,
                      generation: latestReview.lease.generation,
                      expiresAtMs: latestReview.lease.expiresAtMs,
                    }
                  : null,
              }
            : null,
      };
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  async ensurePlanTask(sessionId: string, options: EnsurePlanTaskOptions = {}): Promise<DecisionTask> {
    if (this.service) {
      let session = this.service.getSession(sessionId);
      if (!session) {
        const root = parseDecisionSessionRootFromId(sessionId);
        session = await this.service.createSession(root);
      }

      return await this.service.ensurePlanTask(sessionId, options);
    }

    if (this.client) {
      try {
        await this.client.getSession(sessionId);
      } catch {
        const root = parseDecisionSessionRootFromId(sessionId);
        await this.client.createSession(root);
      }

      const shouldReuse =
        !options.forceNew &&
        (!options.triggerKind || options.triggerKind === "initial");

      const res = await this.client.createTask({
        sessionId,
        kind: "plan",
        ...(options.operationKey !== undefined ? { operationKey: options.operationKey } : {}),
        ...(options.context !== undefined ? { context: options.context } : {}),
        ...(options.triggerKind !== undefined ? { triggerKind: options.triggerKind } : {}),
        ...(options.requirements !== undefined ? { requirements: options.requirements } : {}),
        ...(options.previousTaskId !== undefined ? { previousTaskId: options.previousTaskId } : {}),
        ...(options.forceNew !== undefined ? { forceNew: options.forceNew } : {}),
        reuseActive: shouldReuse,
      });
      return res.task;
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  async verifyPlanEligibility(
    sessionId: string,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): Promise<PlanningEligibilityResult> {
    if (this.service) {
      return this.service.verifyPlanEligibility(sessionId, requirements);
    }

    if (this.client) {
      try {
        const res = await this.client.verifyPlanEligibility(sessionId, requirements);
        return res.eligibility;
      } catch (err) {
        return {
          eligible: false,
          sessionId,
          reason: `Bridge verification request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  verifyPlanEligibilitySync(
    sessionId: string,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): PlanningEligibilityResult {
    if (this.service) {
      return this.service.verifyPlanEligibility(sessionId, requirements);
    }

    if (this.client) {
      return this.client.verifyPlanEligibilitySync(sessionId, requirements);
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  async markPlanPublished(
    taskId: string,
    params: { readonly commentId?: string | number | undefined; readonly publishedAtMs?: number | undefined } = {},
  ): Promise<DecisionPlanRecord> {
    if (this.service) {
      return await this.service.markPlanPublished(taskId, params);
    }

    if (this.client) {
      const res = await this.client.markPlanPublished(taskId, params);
      return res.plan;
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  async getLatestPlan(sessionId: string): Promise<DecisionPlanRecord | null> {
    if (this.service) {
      return this.service.getLatestPlanForSession(sessionId);
    }

    if (this.client) {
      const res = await this.client.getLatestPlan(sessionId);
      return res.plan;
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  getLatestPlanSync(sessionId: string): DecisionPlanRecord | null {
    if (this.service) {
      return this.service.getLatestPlanForSession(sessionId);
    }

    if (this.client) {
      return this.client.getLatestPlanSync(sessionId);
    }

    throw new Error("Invalid planning gate: neither client nor service configured");
  }

  formatPlanCommentMarkdown(options: Parameters<typeof formatPlanCommentMarkdown>[0]): string {
    return formatPlanCommentMarkdown(options);
  }

  parsePlanCommentMarker(body: string) {
    return parsePlanCommentMarker(body);
  }
}
