import { execFileSync } from "node:child_process";
import type {
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

export interface DecisionBridgeClientOptions {
  readonly authToken?: string | undefined;
}

export class DecisionBridgeClient {
  readonly baseUrl: string;
  readonly authToken: string | undefined;
  private readonly eligibilityCache = new Map<string, { fingerprint: string; result: PlanningEligibilityResult }>();
  private readonly latestPlanCache = new Map<string, DecisionPlanRecord | null>();

  constructor(baseUrl: string, options: DecisionBridgeClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow204?: boolean } = {}
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
    const res = await this.request<VerifyPlanEligibilityResponse>("POST", "/v1/plans/verify", payload);
    const fp = requirements ? `${requirements.title}::${requirements.body}::${(requirements.clarifications ?? []).join(";")}` : "";
    this.eligibilityCache.set(sessionId, { fingerprint: fp, result: res.eligibility });
    return res;
  }

  verifyPlanEligibilitySync(
    sessionId: string,
    requirements?: {
      readonly title: string;
      readonly body: string;
      readonly clarifications?: readonly string[] | undefined;
    },
  ): PlanningEligibilityResult {
    const fp = requirements ? `${requirements.title}::${requirements.body}::${(requirements.clarifications ?? []).join(";")}` : "";
    const cached = this.eligibilityCache.get(sessionId);
    if (cached && cached.fingerprint === fp) {
      return cached.result;
    }
    try {
      const url = `${this.baseUrl}/v1/plans/verify`;
      const args = ["-s", "-X", "POST", url, "-H", "Content-Type: application/json"];
      if (this.authToken) {
        args.push("-H", `Authorization: Bearer ${this.authToken}`);
      }
      args.push("-d", JSON.stringify({ sessionId, requirements }));
      const out = execFileSync("curl", args, { encoding: "utf8", timeout: 3000 });
      const parsed = JSON.parse(out) as VerifyPlanEligibilityResponse;
      if (parsed && parsed.eligibility) {
        this.eligibilityCache.set(sessionId, { fingerprint: fp, result: parsed.eligibility });
        return parsed.eligibility;
      }
    } catch {
      // Fallback
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
    const res = await this.request<GetLatestPlanResponse>(
      "GET",
      `/v1/plans/${encodeURIComponent(sessionId)}/latest`,
    );
    this.latestPlanCache.set(sessionId, res.plan);
    return res;
  }

  getLatestPlanSync(sessionId: string): DecisionPlanRecord | null {
    const cached = this.latestPlanCache.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const url = `${this.baseUrl}/v1/plans/${encodeURIComponent(sessionId)}/latest`;
      const args = ["-s", "-X", "GET", url];
      if (this.authToken) {
        args.push("-H", `Authorization: Bearer ${this.authToken}`);
      }
      const out = execFileSync("curl", args, { encoding: "utf8", timeout: 3000 });
      const parsed = JSON.parse(out) as GetLatestPlanResponse;
      if (parsed) {
        this.latestPlanCache.set(sessionId, parsed.plan);
        return parsed.plan;
      }
    } catch {
      // Fallback
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

  async breakBinding(sessionId: string): Promise<{ session: DecisionSession }> {
    return await this.request<{ session: DecisionSession }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/break-binding`
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
