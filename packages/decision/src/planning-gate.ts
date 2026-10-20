import type { ReclaimDecisionClaim } from "./continuity";
import {
  parseDecisionSessionRootFromId,
  formatPlanCommentMarkdown,
  parsePlanCommentMarker,
  type DecisionContextBundle,
  type DecisionTask,
  type PlanningEligibilityResult,
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

  async continuityWork() {
    if (this.service) return this.service.continuityWork();
    if (this.client) return this.client.continuityWork();
    throw new Error("Decision backend unavailable");
  }
  async reclaimExpiredClaim(expected: ReclaimDecisionClaim): Promise<boolean> {
    if (this.service) return this.service.reclaimExpiredClaim(expected);
    if (this.client) return this.client.reclaimExpiredClaim(expected);
    return false;
  }

  async ensurePlanTask(sessionId: string, options: EnsurePlanTaskOptions = {}): Promise<DecisionTask> {
    if (this.service) {
      let session = this.service.getSession(sessionId);
      if (!session) {
        const root = parseDecisionSessionRootFromId(sessionId);
        session = await this.service.createSession(root);
      }

      return await this.service.createPlanTask(sessionId, options);
    }

    if (this.client) {
      try {
        await this.client.getSession(sessionId);
      } catch {
        const root = parseDecisionSessionRootFromId(sessionId);
        await this.client.createSession(root);
      }

      const res = await this.client.createTask({
        sessionId,
        kind: "plan",
        ...(options.operationKey !== undefined ? { operationKey: options.operationKey } : {}),
        ...(options.context !== undefined ? { context: options.context } : {}),
        ...(options.triggerKind !== undefined ? { triggerKind: options.triggerKind } : {}),
        ...(options.requirements !== undefined ? { requirements: options.requirements } : {}),
        ...(options.previousTaskId !== undefined ? { previousTaskId: options.previousTaskId } : {}),
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
