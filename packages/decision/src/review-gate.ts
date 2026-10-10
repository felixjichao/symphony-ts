import {
  isDecisionReviewApproved,
  parseDecisionSessionRootFromId,
  type DecisionContextBundle,
  type DecisionResult,
  type DecisionReviewTarget,
  type DecisionReviewTask,
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
    options?: { operationKey?: string },
  ): Promise<DecisionTask> {
    if (this.service) {
      // In-service path
      let session = this.service.getSession(sessionId);
      if (!session) {
        const root = parseDecisionSessionRootFromId(sessionId);
        session = await this.service.createSession(root);
      }

      // Check existing active or completed review tasks for this exact target
      const existingTasks = this.service.getTasksForSession(sessionId);
      const activeOrDone = existingTasks.find(
        (t): t is DecisionReviewTask =>
          t.kind === "review" &&
          t.target.repository === target.repository &&
          t.target.prNumber === target.prNumber &&
          t.target.headSha === target.headSha &&
          t.status !== "superseded" &&
          t.status !== "cancelled" &&
          t.status !== "failed",
      );
      if (activeOrDone) {
        return activeOrDone;
      }

      return await this.service.createReviewTask(sessionId, {
        target,
        ...(context !== undefined ? { context } : {}),
        ...(options?.operationKey !== undefined ? { operationKey: options.operationKey } : {}),
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

      const { tasks } = await this.client.getTasksForSession(sessionId);
      const activeOrDone = tasks.find(
        (t): t is DecisionReviewTask =>
          t.kind === "review" &&
          t.target.repository === target.repository &&
          t.target.prNumber === target.prNumber &&
          t.target.headSha === target.headSha &&
          t.status !== "superseded" &&
          t.status !== "cancelled" &&
          t.status !== "failed",
      );
      if (activeOrDone) {
        return activeOrDone;
      }

      const opKey = options?.operationKey ?? `review:${sessionId}:${target.repository}:${target.prNumber}:${target.headSha}`;
      const res = await this.client.createTask({
        sessionId,
        kind: "review",
        target,
        ...(context !== undefined ? { context } : {}),
        operationKey: opKey,
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
    const sessionId = target.sessionId ?? `github:${target.repository}#${target.prNumber}`;

    let task: DecisionReviewTask | null = null;
    let result: DecisionResult | null = null;

    if (this.service) {
      const tasks = this.service.getTasksForSession(sessionId);
      const matching = tasks
        .filter(
          (t): t is DecisionReviewTask =>
            t.kind === "review" &&
            t.target.repository === target.repository &&
            t.target.prNumber === target.prNumber &&
            t.target.headSha === target.headSha &&
            t.status === "completed",
        )
        .sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
      task = matching[0] ?? null;
      if (task) {
        result = this.service.getResult(task.id);
      }
    } else if (this.client) {
      try {
        const { tasks } = await this.client.getTasksForSession(sessionId);
        const matching = tasks
          .filter(
            (t): t is DecisionReviewTask =>
              t.kind === "review" &&
              t.target.repository === target.repository &&
              t.target.prNumber === target.prNumber &&
              t.target.headSha === target.headSha &&
              t.status === "completed",
          )
          .sort((a, b) => b.createdAtMs - a.createdAtMs || b.revision - a.revision);
        task = matching[0] ?? null;
        if (task) {
          const res = await this.client.getTaskResult(task.id);
          result = res.result;
        }
      } catch {
        // failed reading from bridge
      }
    }

    if (!task || !result) {
      return {
        approved: false,
        reason: `No completed review task found for target PR #${target.prNumber} @ ${target.headSha}`,
        headSha: target.headSha,
        sessionId,
      };
    }

    const approved = isDecisionReviewApproved(task, result, {
      sessionId,
      repository: target.repository,
      prNumber: target.prNumber,
      headSha: target.headSha,
    });

    if (approved) {
      return {
        approved: true,
        reason: "Review approved",
        taskId: task.id,
        sessionId,
        headSha: target.headSha,
        verdict: "approve",
      };
    }

    const reviewResult = result.kind === "review" ? result : undefined;
    return {
      approved: false,
      reason: `Review is not approved (task status: ${task.status}, verdict: ${reviewResult?.verdict ?? "unknown"})`,
      taskId: task.id,
      sessionId,
      headSha: target.headSha,
      verdict: reviewResult?.verdict,
    };
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
