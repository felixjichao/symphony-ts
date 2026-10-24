import type { DecisionContinuityWork, ReclaimDecisionClaim, UnblockDecisionExecution } from "./continuity";
import { execFileSync } from "node:child_process";
import type {
  DecisionObservation,
  WorkKey,
  DecisionSession,
  DecisionTask,
  DecisionReviewTarget,
  DecisionWorkItemRef,
  DecisionContextBundle,
  PlanningEligibilityResult,
} from "@symphony/domain";
import { DecisionStoreError } from "./errors";
import type {
  ClaimTaskRequest,
  ClaimTaskResponse,
  CreateSessionRequest,
  CreateTaskRequest,
  HeartbeatTaskRequest,
  HeartbeatTaskResponse,
  NextTaskResponse,
  GetTaskResultResponse,
  GetTaskReceiptResponse,
  PutTaskContextRequest,
  PutTaskContextResponse,
  GetTaskContextResponse,
  PutBindingRequest,
  RebindSessionRequest,
  BreakBindingRequest,
  StartTaskRequest,
  SubmitFailureRequest,
  SubmitFailureResponse,
  SubmitResultRequest,
  SubmitResultResponse,
  VerifyReviewApprovalRequest,
  VerifyReviewApprovalResponse,
  VerifyPlanEligibilityRequest,
  VerifyPlanEligibilityResponse,
  MarkPlanPublishedRequest,
  MarkPlanPublishedResponse,
  GetLatestPlanResponse,
  DecisionPlanRecord,
} from "./types";

/**
 * Transport for synchronous bridge lookups. The default implementation shells
 * out to curl (a bridge runs in a separate process). It is injectable so the
 * no-cache behavior can be exercised without blocking an in-process server.
 */
export type DecisionBridgeSyncTransport = (
  method: "GET" | "POST",
  path: string,
  body: unknown,
) => unknown;

export interface DecisionBridgeClientOptions {
  readonly authToken?: string | undefined;
  readonly syncTransport?: DecisionBridgeSyncTransport | undefined;
}

export class DecisionBridgeClient {
  readonly baseUrl: string;
  readonly authToken: string | undefined;
  private readonly syncTransport: DecisionBridgeSyncTransport | undefined;

  constructor(baseUrl: string, options: DecisionBridgeClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
    this.syncTransport = options.syncTransport;
  }

  /** Single committed-state whitelist read, with a real abort budget (no continuity side effects). */
  async observeWork(key: WorkKey): Promise<DecisionObservation> {
    const query = new URLSearchParams({ provider: key.provider, key: key.key });
    return this.request<DecisionObservation>("GET", `/v1/observations/work?${query}`, undefined,
      { signal: AbortSignal.timeout(3000) });
  }

  async continuityWork(): Promise<readonly DecisionContinuityWork[]> {
    return (await this.request<{ work: DecisionContinuityWork[] }>("GET", "/v1/continuity")).work;
  }
  async reclaimExpiredClaim(expected: ReclaimDecisionClaim): Promise<boolean> {
    return (await this.request<{ reclaimed: boolean }>("POST", "/v1/continuity/reclaim", expected)).reclaimed;
  }
  async unblockExecution(expected: UnblockDecisionExecution): Promise<boolean> {
    return (await this.request<{ unblocked: boolean }>("POST", "/v1/continuity/unblock", expected)).unblocked;
  }

  private syncRequest(method: "GET" | "POST", path: string, body: unknown): unknown {
    if (this.syncTransport) {
      return this.syncTransport(method, path, body);
    }
    const url = `${this.baseUrl}${path}`;
    const args = ["-s", "-X", method, url];
    if (body !== undefined) {
      args.push("-H", "Content-Type: application/json");
    }
    if (this.authToken) {
      args.push("-H", `Authorization: Bearer ${this.authToken}`);
    }
    if (body !== undefined) {
      args.push("-d", JSON.stringify(body));
    }
    const out = execFileSync("curl", args, { encoding: "utf8", timeout: 3000 });
    return JSON.parse(out) as unknown;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow204?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(body);
    }

    const init: RequestInit = {
      method,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    };

    const res = await fetch(url, init);

    if (options.allow204 && res.status === 204) {
      return null as T;
    }

    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}: ${res.statusText}`;
      try {
        const errorJson = (await res.json()) as { error?: { code?: string; message?: string } };
        if (errorJson?.error) {
          code = errorJson.error.code ?? code;
          message = errorJson.error.message ?? message;
        }
      } catch {
        // Failed to parse error json
      }
      throw new DecisionStoreError(message, code, res.status);
    }

    return (await res.json()) as T;
  }

  async getNextTask(): Promise<NextTaskResponse | null> {
    return await this.request<NextTaskResponse | null>("GET", "/v1/tasks/next", undefined, {
      allow204: true,
    });
  }

  async claimTask(taskId: string, params: ClaimTaskRequest): Promise<ClaimTaskResponse> {
    return await this.request<ClaimTaskResponse>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/claim`,
      params
    );
  }

  async startTask(taskId: string, params: StartTaskRequest): Promise<{ task: DecisionTask }> {
    return await this.request<{ task: DecisionTask }>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/start`,
      params
    );
  }

  async heartbeatTask(taskId: string, params: HeartbeatTaskRequest): Promise<HeartbeatTaskResponse> {
    return await this.request<HeartbeatTaskResponse>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/heartbeat`,
      params
    );
  }

  async submitResult(taskId: string, params: SubmitResultRequest): Promise<SubmitResultResponse> {
    return await this.request<SubmitResultResponse>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/result`,
      params
    );
  }

  async submitFailure(taskId: string, params: SubmitFailureRequest): Promise<SubmitFailureResponse> {
    return await this.request<SubmitFailureResponse>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/fail`,
      params
    );
  }

  async getTask(taskId: string): Promise<{ task: DecisionTask }> {
    return await this.request<{ task: DecisionTask }>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}`
    );
  }

  async getTaskResult(taskId: string): Promise<GetTaskResultResponse> {
    return await this.request<GetTaskResultResponse>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}/result`
    );
  }

  async getTaskReceipt(taskId: string): Promise<GetTaskReceiptResponse> {
    return await this.request<GetTaskReceiptResponse>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}/receipt`
    );
  }

  async putTaskContext(taskId: string, context: DecisionContextBundle): Promise<PutTaskContextResponse> {
    const payload: PutTaskContextRequest = { context };
    return await this.request<PutTaskContextResponse>(
      "PUT",
      `/v1/tasks/${encodeURIComponent(taskId)}/context`,
      payload
    );
  }

  async getTaskContext(taskId: string): Promise<GetTaskContextResponse> {
    return await this.request<GetTaskContextResponse>(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}/context`
    );
  }

  async cancelTask(taskId: string): Promise<{ task: DecisionTask }> {
    return await this.request<{ task: DecisionTask }>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/cancel`
    );
  }

  async supersedeTask(taskId: string): Promise<{ task: DecisionTask }> {
    return await this.request<{ task: DecisionTask }>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/supersede`
    );
  }

  async createTask(params: CreateTaskRequest): Promise<{ task: DecisionTask }> {
    return await this.request<{ task: DecisionTask }>("POST", "/v1/tasks", params);
  }

  async getSession(sessionId: string): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  async getTasksForSession(sessionId: string): Promise<{ tasks: DecisionTask[] }> {
    return await this.request<{ tasks: DecisionTask[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/tasks`
    );
  }

  async getLatestReviewTask(sessionId: string): Promise<{ task: DecisionTask | null }> {
    return await this.request<{ task: DecisionTask | null }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/reviews/latest`
    );
  }

  async verifyReviewApproval(
    sessionId: string,
    target: DecisionReviewTarget,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): Promise<VerifyReviewApprovalResponse> {
    const payload: VerifyReviewApprovalRequest = {
      sessionId,
      target,
      ...(requirements !== undefined ? { requirements } : {}),
    };
    return await this.request<VerifyReviewApprovalResponse>("POST", "/v1/reviews/verify", payload);
  }

  async verifyPlanEligibility(
    sessionId: string,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): Promise<VerifyPlanEligibilityResponse> {
    const payload: VerifyPlanEligibilityRequest = { sessionId, requirements };
    return await this.request<VerifyPlanEligibilityResponse>("POST", "/v1/plans/verify", payload);
  }

  // Synchronous lookups are used by the orchestrator's dispatch gate, which must
  // observe the current authoritative planning state. They intentionally do not
  // cache: the plan revision, publish status, and verdict can change between two
  // dispatches for otherwise identical requirements, so any cached result would
  // grant stale authorization (or permanently reject a finished plan). A bridge
  // failure fails closed.
  verifyPlanEligibilitySync(
    sessionId: string,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): PlanningEligibilityResult {
    try {
      const parsed = this.syncRequest("POST", "/v1/plans/verify", {
        sessionId,
        requirements,
      }) as VerifyPlanEligibilityResponse;
      if (parsed && parsed.eligibility) {
        return parsed.eligibility;
      }
    } catch {
      // Fail closed on bridge failure.
    }
    return {
      eligible: false,
      sessionId,
      reason: "Planning eligibility check pending or unavailable synchronously",
    };
  }

  async markPlanPublished(
    taskId: string,
    params: MarkPlanPublishedRequest = {},
  ): Promise<MarkPlanPublishedResponse> {
    return await this.request<MarkPlanPublishedResponse>(
      "POST",
      `/v1/plans/${encodeURIComponent(taskId)}/publish`,
      params,
    );
  }

  async getLatestPlan(sessionId: string): Promise<GetLatestPlanResponse> {
    return await this.request<GetLatestPlanResponse>(
      "GET",
      `/v1/plans/${encodeURIComponent(sessionId)}/latest`,
    );
  }

  getLatestPlanSync(sessionId: string): DecisionPlanRecord | null {
    try {
      const parsed = this.syncRequest(
        "GET",
        `/v1/plans/${encodeURIComponent(sessionId)}/latest`,
        undefined,
      ) as GetLatestPlanResponse;
      if (parsed) {
        return parsed.plan;
      }
    } catch {
      // Fail closed on bridge failure.
    }
    return null;
  }

  async createSession(root: DecisionWorkItemRef): Promise<{ session: DecisionSession }> {
    const payload: CreateSessionRequest = { root };
    return await this.request<{ session: DecisionSession }>("POST", "/v1/sessions", payload);
  }

  async putBinding(sessionId: string, params: PutBindingRequest): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "PUT",
      `/v1/sessions/${encodeURIComponent(sessionId)}/binding`,
      params
    );
  }

  async rebindSession(sessionId: string, params: RebindSessionRequest): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/rebind`,
      params
    );
  }

  async breakBinding(sessionId: string, params?: BreakBindingRequest): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/break-binding`,
      params
    );
  }

  async completeSession(sessionId: string): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/complete`
    );
  }

  async reopenSession(sessionId: string): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/reopen`
    );
  }
}
