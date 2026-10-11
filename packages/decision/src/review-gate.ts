import {
  parseDecisionSessionRootFromId,
  type DecisionContextBundle,
  type DecisionReviewTarget,
  type DecisionTask,
  type DeliveryReviewApprovalResult,
  type DeliveryReviewGate,
  type DeliveryReviewStatusResult,
} from "@symphony/domain";
import { DecisionBridgeClient } from "./client.js";
import { DecisionService } from "./service.js";

export interface DecisionReviewGateOptions {
  readonly clientOrService: DecisionBridgeClient | DecisionService;
}

export class DecisionReviewGate implements DeliveryReviewGate {
  private readonly client: DecisionBridgeClient | null = null;
  private readonly service: DecisionService | null = null;

  constructor(clientOrService: DecisionBridgeClient | DecisionService) {
    if (clientOrService instanceof DecisionBridgeClient) {
      this.client = clientOrService;
    } else {
      this.service = clientOrService;
    }
  }

  async ensureReviewTask(
    sessionId: string,
    target: DecisionReviewTarget,
    context?: DecisionContextBundle,
    options?: { operationKey?: string; forceNewRevision?: boolean },
  ): Promise<DecisionTask> {
    if (this.service) {
      // In-service path
      let session = this.service.getSession(sessionId);
      if (!session) {
        const root = parseDecisionSessionRootFromId(sessionId);
        session = await this.service.createSession(root);
      }

      return await this.service.createReviewTask(sessionId, {
        target,
        ...(context !== undefined ? { context } : {}),
        ...(options?.operationKey !== undefined ? { operationKey: options.operationKey } : {}),
        supersedeSessionReviews: true,
        ...(options?.forceNewRevision !== undefined ? { forceNewRevision: options.forceNewRevision } : {}),
      });
    }

    if (this.client) {
      // HTTP client path
      try {
        await this.client.getSession(sessionId);
      } catch {
        const root = parseDecisionSessionRootFromId(sessionId);
        await this.client.createSession(root);
      }

      const res = await this.client.createTask({
        sessionId,
        kind: "review",
        target,
        ...(context !== undefined ? { context } : {}),
        ...(options?.operationKey !== undefined ? { operationKey: options.operationKey } : {}),
        supersedeSessionReviews: true,
        ...(options?.forceNewRevision !== undefined ? { forceNewRevision: options.forceNewRevision } : {}),
      });
      return res.task;
    }

    throw new Error("Invalid review gate: neither client nor service configured");
  }

  async getReviewStatus(taskId: string): Promise<DeliveryReviewStatusResult> {
    if (this.service) {
      const task = this.service.getTask(taskId);
      if (!task) {
        return { taskId, status: "failed", error: `Task "${taskId}" not found` };
      }
      if (task.status === "completed") {
        const result = this.service.getResult(taskId);
        return { taskId, status: task.status, result };
      }
      if (task.status === "failed") {
        const failure = this.service.getFailure(taskId);
        return { taskId, status: task.status, error: failure?.error ?? "failed" };
      }
      return { taskId, status: task.status };
    }

    if (this.client) {
      const { task } = await this.client.getTask(taskId);
      if (task.status === "completed") {
        const { result } = await this.client.getTaskResult(taskId);
        return { taskId, status: task.status, result };
      }
      if (task.status === "failed") {
        return { taskId, status: task.status, error: "failed" };
      }
      return { taskId, status: task.status };
    }

    throw new Error("Invalid review gate: neither client nor service configured");
  }

  async verifyReviewApproval(
    target: DecisionReviewTarget & { readonly sessionId?: string },
  ): Promise<DeliveryReviewApprovalResult> {
    if (!target.sessionId) {
      throw new Error(
        `verifyReviewApproval requires target.sessionId to prevent session derivation mismatch for PR #${target.prNumber}`,
      );
    }
    const sessionId = target.sessionId;
    const reviewTarget: DecisionReviewTarget = {
      repository: target.repository,
      prNumber: target.prNumber,
      headSha: target.headSha,
    };

    if (this.service) {
      return this.service.verifyReviewApproval(sessionId, reviewTarget);
    }

    if (this.client) {
      try {
        const { approval } = await this.client.verifyReviewApproval(sessionId, reviewTarget);
        return approval;
      } catch (err) {
        return {
          approved: false,
          reason: `Bridge verification request failed: ${err instanceof Error ? err.message : String(err)}`,
          headSha: target.headSha,
          sessionId,
        };
      }
    }

    throw new Error("Invalid review gate: neither client nor service configured");
  }

  async supersedeReviewTask(taskId: string): Promise<void> {
    if (this.service) {
      await this.service.supersedeTask(taskId);
      return;
    }
    if (this.client) {
      await this.client.supersedeTask(taskId);
      return;
    }
  }
}
