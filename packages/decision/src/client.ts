import type {
  DecisionSession,
  DecisionTask,
  DecisionReviewTarget,
  DecisionWorkItemRef,
  DecisionContextBundle,
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
} from "./types";

export interface DecisionBridgeClientOptions {
  readonly authToken?: string | undefined;
}

export class DecisionBridgeClient {
  readonly baseUrl: string;
  readonly authToken: string | undefined;

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
  ): Promise<VerifyReviewApprovalResponse> {
    const payload: VerifyReviewApprovalRequest = { sessionId, target };
    return await this.request<VerifyReviewApprovalResponse>("POST", "/v1/reviews/verify", payload);
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
