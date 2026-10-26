import crypto from "node:crypto";
import http from "node:http";
import {
  parseWorkKey,
  parseDecisionReviewTarget,
  parseDecisionContextBundle,
  type DecisionContextBundle,
  type DecisionResult,
  type DecisionWorkItemRef,
} from "@symphony/domain";
import {
  DecisionForbiddenError,
  DecisionNotFoundError,
  DecisionPayloadTooLargeError,
  DecisionStoreError,
  DecisionUnauthorizedError,
  DecisionValidationError,
} from "./errors";
import { DecisionService } from "./service";
import { DurableDecisionStore } from "./store";
import type { DecisionBridgeConfig, DecisionStoreConfig } from "./types";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function timingSafeEqualStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export class DecisionBridge {
  private readonly service: DecisionService;
  private readonly host: string;
  private readonly port: number;
  private readonly authToken: string | undefined;
  private readonly allowedOrigins: Set<string>;
  private server: http.Server | null = null;
  private actualPort: number | null = null;
  private closing = false;
  private fullyStopped = false;
  private startup: Promise<{ host: string; port: number }> | null = null;
  private shutdown: Promise<void> | null = null;
  private activeSockets = new Set<import("node:net").Socket>();

  constructor(serviceOrConfig: DecisionService | DecisionBridgeConfig, config?: Partial<DecisionBridgeConfig>) {
    if (serviceOrConfig instanceof DecisionService) {
      this.service = serviceOrConfig;
      const conf = config ?? {};
      this.host = conf.host ?? "127.0.0.1";
      this.port = conf.port ?? 4040;
      this.authToken = conf.authToken;
      this.allowedOrigins = new Set(conf.allowedOrigins ?? []);
    } else {
      const storeConfig: DecisionStoreConfig = {
        storeDir: serviceOrConfig.storeDir,
        clock: serviceOrConfig.clock,
        authorizeExecution: serviceOrConfig.authorizeExecution,
        defaultClaimTtlMs: serviceOrConfig.defaultClaimTtlMs,
      };
      const store = new DurableDecisionStore(storeConfig);
      this.service = new DecisionService(store, {
        clock: serviceOrConfig.clock,
        authorizeExecution: serviceOrConfig.authorizeExecution,
        defaultClaimTtlMs: serviceOrConfig.defaultClaimTtlMs,
      });
      this.host = serviceOrConfig.host ?? "127.0.0.1";
      this.port = serviceOrConfig.port ?? 4040;
      this.authToken = serviceOrConfig.authToken;
      this.allowedOrigins = new Set(serviceOrConfig.allowedOrigins ?? []);
    }

    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      throw new DecisionValidationError(
        `Bridge is restricted to loopback interfaces only. Configured host "${this.host}" is not permitted.`
      );
    }
  }

  getService(): DecisionService {
    return this.service;
  }

  getPort(): number | null {
    return this.actualPort;
  }

  getHost(): string {
    return this.host;
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.fullyStopped) {
      this.fullyStopped = false;
      this.closing = false;
      this.startup = null;
      this.shutdown = null;
    }
    if (this.closing) return Promise.reject(new Error("Decision bridge is stopping"));
    if (!this.startup) this.startup = this.startInternal();
    return this.startup;
  }

  private async startInternal(): Promise<{ host: string; port: number }> {
    if (this.server) {
      return { host: this.host, port: this.actualPort! };
    }

    await this.service.getStore().open();
    if (this.closing) throw new Error("Decision bridge stopped during startup");

    return new Promise<{ host: string; port: number }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          this.sendError(res, err);
        });
      });

      server.on("connection", (socket) => {
        this.activeSockets.add(socket);
        socket.on("close", () => {
          this.activeSockets.delete(socket);
        });
      });

      server.once("error", (err) => {
        reject(err);
      });

      server.listen(this.port, this.host, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          this.actualPort = address.port;
          this.server = server;
          resolve({ host: this.host, port: this.actualPort });
        } else {
          reject(new Error("Failed to obtain server address"));
        }
      });
    });
  }

  stop(): Promise<void> {
    this.closing = true;
    if (!this.shutdown) this.shutdown = this.stopInternal();
    return this.shutdown;
  }

  private async stopInternal(): Promise<void> {
    try { await this.startup; } catch { /* startup failure still owns its store cleanup */ }
    if (!this.server) {
      await this.service.getStore().close();
      this.fullyStopped = true;
      return;
    }

    const s = this.server;
    this.server = null;
    this.actualPort = null;

    // Destroy active sockets
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    await new Promise<void>((resolve, reject) => {
      s.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await this.service.getStore().close();
    this.fullyStopped = true;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 1. Host header validation (DNS rebinding protection)
    const hostHeader = req.headers.host;
    if (hostHeader) {
      const hostWithoutPort = hostHeader.split(":")[0]?.toLowerCase();
      if (hostWithoutPort !== "127.0.0.1" && hostWithoutPort !== "localhost" && hostWithoutPort !== "[::1]") {
        this.sendError(res, new DecisionValidationError("Forbidden host header"));
        return;
      }
    }

    // 2. Origin & CORS Handling
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!this.allowedOrigins.has(origin)) {
        this.sendError(res, new DecisionForbiddenError(`Forbidden origin: ${origin}`));
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Credentials", "false");
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // 3. Bearer Token Auth
    if (this.authToken !== undefined) {
      const authHeader = req.headers.authorization;
      if (
        !authHeader ||
        !authHeader.startsWith("Bearer ") ||
        !timingSafeEqualStrings(authHeader.slice(7), this.authToken)
      ) {
        throw new DecisionUnauthorizedError();
      }
    }

    // 4. URL parsing
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    if (method === "GET" && pathname === "/v1/observations/work") {
      let key;
      try { key = parseWorkKey({ provider: url.searchParams.get("provider"), key: url.searchParams.get("key") }); }
      catch { throw new DecisionValidationError("Invalid observation WorkKey"); }
      this.sendJson(res, 200, this.service.observeWork(key));
      return;
    }
    if (method === "GET" && pathname === "/v1/continuity") {
      this.sendJson(res, 200, { work: this.service.continuityWork() });
      return;
    }
    if (method === "POST" && pathname === "/v1/continuity/reclaim") {
      const body = await this.readJsonBody(req) as Record<string, unknown> | null;
      if (!body || typeof body["taskId"] !== "string" ||
        !["revision", "claimGeneration", "bindingGeneration", "leaseExpiresAtMs"].every(key => Number.isSafeInteger(body[key]) && (body[key] as number) >= 0)) {
        throw new DecisionValidationError("Invalid expired claim fence");
      }
      const reclaimed = await this.service.reclaimExpiredClaim({ taskId: body["taskId"],
        revision: body["revision"] as number, claimGeneration: body["claimGeneration"] as number,
        bindingGeneration: body["bindingGeneration"] as number, leaseExpiresAtMs: body["leaseExpiresAtMs"] as number });
      this.sendJson(res, 200, { reclaimed });
      return;
    }
    if (method === "POST" && pathname === "/v1/continuity/unblock") {
      const body = await this.readJsonBody(req) as Record<string, unknown> | null;
      // `leaseExpiresAtMs: null` is the explicit fence for a pending task that owns no lease.
      const leaseExpiresAtMs = body?.["leaseExpiresAtMs"];
      if (!body || typeof body["taskId"] !== "string" ||
        !["revision", "claimGeneration", "bindingGeneration", "blockedAtMs"].every(key => Number.isSafeInteger(body[key]) && (body[key] as number) >= 0) ||
        (leaseExpiresAtMs !== null && !(Number.isSafeInteger(leaseExpiresAtMs) && (leaseExpiresAtMs as number) >= 0))) {
        throw new DecisionValidationError("Invalid unblock fence");
      }
      const unblocked = await this.service.unblockExecution({ taskId: body["taskId"],
        revision: body["revision"] as number, claimGeneration: body["claimGeneration"] as number,
        bindingGeneration: body["bindingGeneration"] as number, leaseExpiresAtMs: leaseExpiresAtMs as number | null,
        blockedAtMs: body["blockedAtMs"] as number });
      this.sendJson(res, 200, { unblocked });
      return;
    }

    // Route matching
    // GET /v1/tasks/next
    if (method === "GET" && pathname === "/v1/tasks/next") {
      const next = await this.service.getNextTask();
      if (!next) {
        res.statusCode = 204;
        res.end();
        return;
      }
      this.sendJson(res, 200, next);
      return;
    }

    // POST /v1/tasks/:id/claim
    const claimMatch = /^\/v1\/tasks\/([^/]+)\/claim$/.exec(pathname);
    if (method === "POST" && claimMatch) {
      const id = decodeURIComponent(claimMatch[1]!);
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== "object") {
        throw new DecisionValidationError("Claim request body must be an object");
      }
      const owner = (body as Record<string, unknown>)["owner"];
      if (typeof owner !== "string") {
        throw new DecisionValidationError("owner must be a string");
      }
      const ttlMs = (body as Record<string, unknown>)["ttlMs"];
      const result = await this.service.claimTask(id, {
        owner,
        ttlMs: typeof ttlMs === "number" ? ttlMs : undefined,
      });
      this.sendJson(res, 200, result);
      return;
    }

    // POST /v1/tasks/:id/start
    const startMatch = /^\/v1\/tasks\/([^/]+)\/start$/.exec(pathname);
    if (method === "POST" && startMatch) {
      const id = decodeURIComponent(startMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["owner"] !== "string" || typeof b["token"] !== "string" || typeof b["generation"] !== "number") {
        throw new DecisionValidationError("start requires owner, token and generation");
      }
      const result = await this.service.startTask(id, {
        owner: b["owner"],
        token: b["token"],
        generation: b["generation"],
      });
      this.sendJson(res, 200, { task: result });
      return;
    }

    const blockMatch = /^\/v1\/tasks\/([^/]+)\/block$/.exec(pathname);
    if (method === "POST" && blockMatch) {
      const b = await this.readJsonBody(req) as Record<string, unknown>;
      if (!b || typeof b["owner"] !== "string" || typeof b["token"] !== "string"
        || typeof b["generation"] !== "number" || typeof b["reason"] !== "string") throw new DecisionValidationError("Invalid block request");
      await this.service.blockExecution(decodeURIComponent(blockMatch[1]!), {
        owner: b["owner"], token: b["token"], generation: b["generation"], reason: b["reason"],
        ...(b["recoveryCount"] !== undefined ? { recoveryCount: b["recoveryCount"] as number } : {}),
      });
      this.sendJson(res, 200, { blocked: true });
      return;
    }

    const executionMatch = /^\/v1\/tasks\/([^/]+)\/execution$/.exec(pathname);
    if (method === "GET" && executionMatch) {
      const id = decodeURIComponent(executionMatch[1]!);
      if (!this.service.getTask(id)) throw new DecisionNotFoundError("Task not found");
      this.sendJson(res, 200, { execution: this.service.getExecution(id) });
      return;
    }

    // POST /v1/tasks/:id/heartbeat
    const hbMatch = /^\/v1\/tasks\/([^/]+)\/heartbeat$/.exec(pathname);
    if (method === "POST" && hbMatch) {
      const id = decodeURIComponent(hbMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["owner"] !== "string" || typeof b["token"] !== "string" || typeof b["generation"] !== "number") {
        throw new DecisionValidationError("heartbeat requires owner, token and generation");
      }
      const ttlMs = b["ttlMs"];
      const result = await this.service.heartbeatTask(id, {
        owner: b["owner"],
        token: b["token"],
        generation: b["generation"],
        ttlMs: typeof ttlMs === "number" ? ttlMs : undefined,
        ...(b["progress"] !== undefined ? { progress: parseExecutionProgress(b["progress"]) } : {}),
      });
      this.sendJson(res, 200, result);
      return;
    }

    // POST /v1/tasks/:id/result
    const resultMatch = /^\/v1\/tasks\/([^/]+)\/result$/.exec(pathname);
    if (method === "POST" && resultMatch) {
      const id = decodeURIComponent(resultMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["owner"] !== "string" || typeof b["token"] !== "string" || typeof b["generation"] !== "number") {
        throw new DecisionValidationError("result requires owner, token and generation");
      }
      const submissionResult = b["result"];
      if (!submissionResult || typeof submissionResult !== "object") {
        throw new DecisionValidationError("result payload is required");
      }
      const outcome = await this.service.submitResult(id, {
        owner: b["owner"],
        token: b["token"],
        generation: b["generation"],
        result: submissionResult as unknown as DecisionResult,
      });
      this.sendJson(res, 200, outcome);
      return;
    }

    // POST /v1/tasks/:id/fail
    const failMatch = /^\/v1\/tasks\/([^/]+)\/fail$/.exec(pathname);
    if (method === "POST" && failMatch) {
      const id = decodeURIComponent(failMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["owner"] !== "string" || typeof b["token"] !== "string" || typeof b["generation"] !== "number") {
        throw new DecisionValidationError("fail requires owner, token and generation");
      }
      if (typeof b["error"] !== "string") {
        throw new DecisionValidationError("fail requires error string");
      }
      const outcome = await this.service.submitFailure(id, {
        owner: b["owner"],
        token: b["token"],
        generation: b["generation"],
        error: b["error"],
        details: b["details"],
        retryable: typeof b["retryable"] === "boolean" ? b["retryable"] : undefined,
      });
      this.sendJson(res, 200, outcome);
      return;
    }

    // GET /v1/tasks/:id/result
    const taskResultMatch = /^\/v1\/tasks\/([^/]+)\/result$/.exec(pathname);
    if (method === "GET" && taskResultMatch) {
      const id = decodeURIComponent(taskResultMatch[1]!);
      const result = this.service.getResult(id);
      if (!result) throw new DecisionNotFoundError(`Result for task "${id}" not found`);
      this.sendJson(res, 200, { result });
      return;
    }

    // GET /v1/tasks/:id/receipt
    const taskReceiptMatch = /^\/v1\/tasks\/([^/]+)\/receipt$/.exec(pathname);
    if (method === "GET" && taskReceiptMatch) {
      const id = decodeURIComponent(taskReceiptMatch[1]!);
      const receipt = this.service.getReceipt(id);
      if (!receipt) throw new DecisionNotFoundError(`Receipt for task "${id}" not found`);
      this.sendJson(res, 200, { receipt });
      return;
    }

    // GET /v1/tasks/:id/failure
    const taskFailureMatch = /^\/v1\/tasks\/([^/]+)\/failure$/.exec(pathname);
    if (method === "GET" && taskFailureMatch) {
      const id = decodeURIComponent(taskFailureMatch[1]!);
      const failure = this.service.getFailure(id);
      if (!failure) throw new DecisionNotFoundError(`Failure for task "${id}" not found`);
      this.sendJson(res, 200, { failure });
      return;
    }

    // PUT /v1/tasks/:id/context
    const putContextMatch = /^\/v1\/tasks\/([^/]+)\/context$/.exec(pathname);
    if (method === "PUT" && putContextMatch) {
      const id = decodeURIComponent(putContextMatch[1]!);
      const body = await this.readJsonBody(req);
      if (!body || typeof body !== "object") {
        throw new DecisionValidationError("context request body must be an object");
      }
      const ctx = (body as Record<string, unknown>)["context"];
      if (!ctx || typeof ctx !== "object") {
        throw new DecisionValidationError("context field is required");
      }
      const context = await this.service.putTaskContext(id, ctx as unknown as DecisionContextBundle);
      this.sendJson(res, 200, { context });
      return;
    }

    // GET /v1/tasks/:id/context
    const getContextMatch = /^\/v1\/tasks\/([^/]+)\/context$/.exec(pathname);
    if (method === "GET" && getContextMatch) {
      const id = decodeURIComponent(getContextMatch[1]!);
      const context = this.service.getTaskContext(id);
      if (!context) throw new DecisionNotFoundError(`Context for task "${id}" not found`);
      this.sendJson(res, 200, { context });
      return;
    }

    // GET /v1/tasks/:id
    const taskGetMatch = /^\/v1\/tasks\/([^/]+)$/.exec(pathname);
    if (method === "GET" && taskGetMatch) {
      const id = decodeURIComponent(taskGetMatch[1]!);
      const task = this.service.getTask(id);
      if (!task) throw new DecisionNotFoundError(`Task "${id}" not found`);
      this.sendJson(res, 200, { task, execution: this.service.getExecution(id) });
      return;
    }

    // POST /v1/tasks/:id/cancel
    const cancelMatch = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(pathname);
    if (method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]!);
      const task = await this.service.cancelTask(id);
      this.sendJson(res, 200, { task });
      return;
    }

    // POST /v1/tasks/:id/supersede
    const supersedeMatch = /^\/v1\/tasks\/([^/]+)\/supersede$/.exec(pathname);
    if (method === "POST" && supersedeMatch) {
      const id = decodeURIComponent(supersedeMatch[1]!);
      const task = await this.service.supersedeTask(id);
      this.sendJson(res, 200, { task });
      return;
    }

    // POST /v1/reviews/verify
    if (method === "POST" && pathname === "/v1/reviews/verify") {
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["sessionId"] !== "string") {
        throw new DecisionValidationError("verify review approval requires sessionId");
      }
      if (!b["target"] || typeof b["target"] !== "object") {
        throw new DecisionValidationError("verify review approval requires target");
      }
      const target = parseDecisionReviewTarget(b["target"]);
      let requirements: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined;
      if (b["requirements"] && typeof b["requirements"] === "object") {
        const reqObj = b["requirements"] as Record<string, unknown>;
        if (typeof reqObj["title"] === "string" && typeof reqObj["body"] === "string") {
          const clarifications = Array.isArray(reqObj["clarifications"])
            ? reqObj["clarifications"].filter((x): x is string => typeof x === "string")
            : undefined;
          requirements = {
            title: reqObj["title"],
            body: reqObj["body"],
            ...(clarifications !== undefined ? { clarifications } : {}),
          };
        }
      }
      const approval = this.service.verifyReviewApproval(b["sessionId"], target, requirements);
      this.sendJson(res, 200, { approval });
      return;
    }

    // POST /v1/plans/verify
    if (method === "POST" && pathname === "/v1/plans/verify") {
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["sessionId"] !== "string") {
        throw new DecisionValidationError("verify plan eligibility requires sessionId");
      }
      let requirements: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined;
      if (b["requirements"] && typeof b["requirements"] === "object") {
        const reqObj = b["requirements"] as Record<string, unknown>;
        if (typeof reqObj["title"] === "string" && typeof reqObj["body"] === "string") {
          const clarifications = Array.isArray(reqObj["clarifications"])
            ? reqObj["clarifications"].filter((x): x is string => typeof x === "string")
            : undefined;
          requirements = {
            title: reqObj["title"],
            body: reqObj["body"],
            ...(clarifications !== undefined ? { clarifications } : {}),
          };
        }
      }
      const eligibility = this.service.verifyPlanEligibility(b["sessionId"], requirements);
      this.sendJson(res, 200, { eligibility });
      return;
    }

    // POST /v1/plans/:id/publish
    const publishPlanMatch = /^\/v1\/plans\/([^/]+)\/publish$/.exec(pathname);
    if (method === "POST" && publishPlanMatch) {
      const taskId = decodeURIComponent(publishPlanMatch[1]!);
      const body = (await this.readJsonBody(req)) as Record<string, unknown> | null;
      const commentId = body?.["commentId"] !== undefined ? (body["commentId"] as string | number) : undefined;
      const publishedAtMs = typeof body?.["publishedAtMs"] === "number" ? body["publishedAtMs"] : undefined;
      const plan = await this.service.markPlanPublished(taskId, { commentId, publishedAtMs });
      this.sendJson(res, 200, { plan });
      return;
    }

    // GET /v1/plans/:sessionId/latest
    const latestPlanMatch = /^\/v1\/plans\/([^/]+)\/latest$/.exec(pathname);
    if (method === "GET" && latestPlanMatch) {
      const sessionId = decodeURIComponent(latestPlanMatch[1]!);
      const plan = this.service.getLatestPlanForSession(sessionId);
      this.sendJson(res, 200, { plan });
      return;
    }

    // POST /v1/tasks (create task)
    if (method === "POST" && pathname === "/v1/tasks") {
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["sessionId"] !== "string") {
        throw new DecisionValidationError("create task requires sessionId");
      }
      const operationKey = typeof b["operationKey"] === "string" ? b["operationKey"] : undefined;
      const kind = b["kind"];
      if (kind === "plan") {
        const triggerKind = typeof b["triggerKind"] === "string"
          ? (b["triggerKind"] as "initial" | "requirements_changed" | "clarification" | "retry")
          : undefined;
        let requirements: { readonly title: string; readonly body: string; readonly clarifications?: readonly string[] | undefined } | undefined;
        if (b["requirements"] && typeof b["requirements"] === "object") {
          const reqObj = b["requirements"] as Record<string, unknown>;
          if (typeof reqObj["title"] === "string" && typeof reqObj["body"] === "string") {
            const clarifications = Array.isArray(reqObj["clarifications"])
              ? reqObj["clarifications"].filter((x): x is string => typeof x === "string")
              : undefined;
            requirements = {
              title: reqObj["title"],
              body: reqObj["body"],
              ...(clarifications !== undefined ? { clarifications } : {}),
            };
          }
        }
        const context = b["context"] ? parseDecisionContextBundle(b["context"]) : undefined;
        const previousTaskId = typeof b["previousTaskId"] === "string" ? b["previousTaskId"] : undefined;
        const task = await this.service.createPlanTask(b["sessionId"], {
          ...(operationKey !== undefined ? { operationKey } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(triggerKind !== undefined ? { triggerKind } : {}),
          ...(requirements !== undefined ? { requirements } : {}),
          ...(previousTaskId !== undefined ? { previousTaskId } : {}),
        });
        this.sendJson(res, 201, { task });
        return;
      }
      if (kind === "review") {
        if (!b["target"] || typeof b["target"] !== "object") {
          throw new DecisionValidationError("review task requires target");
        }
        const target = parseDecisionReviewTarget(b["target"]);
        const context = b["context"] ? parseDecisionContextBundle(b["context"]) : undefined;
        const supersedeSessionReviews = Boolean(b["supersedeSessionReviews"]);
        const forceNewRevision = Boolean(b["forceNewRevision"]);
        const task = await this.service.createReviewTask(b["sessionId"], {
          target,
          context,
          ...(operationKey !== undefined ? { operationKey } : {}),
          supersedeSessionReviews,
          ...(forceNewRevision ? { forceNewRevision: true } : {}),
          ...(b["reuseCompleted"] === true ? { reuseCompleted: true } : {}),
        });
        this.sendJson(res, 201, { task });
        return;
      }
      throw new DecisionValidationError("kind must be plan or review");
    }

    // GET /v1/sessions/:id/tasks
    const sessionTasksMatch = /^\/v1\/sessions\/([^/]+)\/tasks$/.exec(pathname);
    if (method === "GET" && sessionTasksMatch) {
      const id = decodeURIComponent(sessionTasksMatch[1]!);
      const session = this.service.getSession(id);
      if (!session) throw new DecisionNotFoundError(`Session "${id}" not found`);
      const tasks = this.service.getTasksForSession(id);
      this.sendJson(res, 200, { tasks });
      return;
    }

    // GET /v1/sessions/:id/reviews/latest
    const sessionLatestReviewMatch = /^\/v1\/sessions\/([^/]+)\/reviews\/latest$/.exec(pathname);
    if (method === "GET" && sessionLatestReviewMatch) {
      const id = decodeURIComponent(sessionLatestReviewMatch[1]!);
      const session = this.service.getSession(id);
      if (!session) throw new DecisionNotFoundError(`Session "${id}" not found`);
      const task = this.service.getLatestReviewTask(id);
      this.sendJson(res, 200, { task });
      return;
    }

    // GET /v1/sessions/:id
    const sessionGetMatch = /^\/v1\/sessions\/([^/]+)$/.exec(pathname);
    if (method === "GET" && sessionGetMatch) {
      const id = decodeURIComponent(sessionGetMatch[1]!);
      const session = this.service.getSession(id);
      if (!session) throw new DecisionNotFoundError(`Session "${id}" not found`);
      this.sendJson(res, 200, { session });
      return;
    }

    // PUT /v1/sessions/:id/binding
    const putBindingMatch = /^\/v1\/sessions\/([^/]+)\/binding$/.exec(pathname);
    if (method === "PUT" && putBindingMatch) {
      const id = decodeURIComponent(putBindingMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (typeof b["adapter"] !== "string" || typeof b["externalSessionRef"] !== "string") {
        throw new DecisionValidationError("binding requires adapter and externalSessionRef");
      }
      const resumeUri = b["resumeUri"] === null || typeof b["resumeUri"] === "string" ? b["resumeUri"] : null;
      const owner = typeof b["owner"] === "string" ? b["owner"] : undefined;
      const token = typeof b["token"] === "string" ? b["token"] : undefined;
      const generation = typeof b["generation"] === "number" ? b["generation"] : undefined;
      const session = await this.service.putBinding(id, {
        adapter: b["adapter"],
        externalSessionRef: b["externalSessionRef"],
        resumeUri,
        ...(owner ? { owner } : {}),
        ...(token ? { token } : {}),
        ...(generation !== undefined ? { generation } : {}),
      });
      this.sendJson(res, 200, { session });
      return;
    }

    // POST /v1/sessions/:id/rebind
    const rebindMatch = /^\/v1\/sessions\/([^/]+)\/rebind$/.exec(pathname);
    if (method === "POST" && rebindMatch) {
      const id = decodeURIComponent(rebindMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (
        typeof b["adapter"] !== "string" ||
        typeof b["externalSessionRef"] !== "string" ||
        typeof b["expectedGeneration"] !== "number"
      ) {
        throw new DecisionValidationError("rebind requires adapter, externalSessionRef and expectedGeneration");
      }
      const resumeUri = b["resumeUri"] === null || typeof b["resumeUri"] === "string" ? b["resumeUri"] : null;
      const operationKey = typeof b["operationKey"] === "string" ? b["operationKey"] : undefined;
      const owner = typeof b["owner"] === "string" ? b["owner"] : undefined;
      const token = typeof b["token"] === "string" ? b["token"] : undefined;
      const generation = typeof b["generation"] === "number" ? b["generation"] : undefined;
      const session = await this.service.rebindSession(id, {
        adapter: b["adapter"],
        externalSessionRef: b["externalSessionRef"],
        resumeUri,
        expectedGeneration: b["expectedGeneration"],
        operationKey,
        ...(owner ? { owner } : {}),
        ...(token ? { token } : {}),
        ...(generation !== undefined ? { generation } : {}),
      });
      this.sendJson(res, 200, { session });
      return;
    }

    // POST /v1/sessions/:id/break-binding
    const breakMatch = /^\/v1\/sessions\/([^/]+)\/break-binding$/.exec(pathname);
    if (method === "POST" && breakMatch) {
      const id = decodeURIComponent(breakMatch[1]!);
      const body = await this.readJsonBody(req);
      const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const owner = typeof b["owner"] === "string" ? b["owner"] : undefined;
      const token = typeof b["token"] === "string" ? b["token"] : undefined;
      const generation = typeof b["generation"] === "number" ? b["generation"] : undefined;
      const expectedGeneration =
        typeof b["expectedGeneration"] === "number" ? b["expectedGeneration"] : undefined;
      const session = await this.service.breakBinding(id, {
        ...(owner ? { owner } : {}),
        ...(token ? { token } : {}),
        ...(generation !== undefined ? { generation } : {}),
        ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
      });
      this.sendJson(res, 200, { session });
      return;
    }

    // POST /v1/sessions/:id/complete
    const completeMatch = /^\/v1\/sessions\/([^/]+)\/complete$/.exec(pathname);
    if (method === "POST" && completeMatch) {
      const id = decodeURIComponent(completeMatch[1]!);
      const session = await this.service.completeSession(id);
      this.sendJson(res, 200, { session });
      return;
    }

    // POST /v1/sessions/:id/reopen
    const reopenMatch = /^\/v1\/sessions\/([^/]+)\/reopen$/.exec(pathname);
    if (method === "POST" && reopenMatch) {
      const id = decodeURIComponent(reopenMatch[1]!);
      const session = await this.service.reopenSession(id);
      this.sendJson(res, 200, { session });
      return;
    }

    // POST /v1/sessions (create session)
    if (method === "POST" && pathname === "/v1/sessions") {
      const body = await this.readJsonBody(req);
      const b = body as Record<string, unknown>;
      if (!b["root"] || typeof b["root"] !== "object") {
        throw new DecisionValidationError("create session requires root");
      }
      const session = await this.service.createSession(b["root"] as unknown as DecisionWorkItemRef);
      this.sendJson(res, 201, { session });
      return;
    }

    throw new DecisionNotFoundError(`Route not found: ${method} ${pathname}`);
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let totalBytes = 0;
      let exceeded = false;
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        if (exceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          exceeded = true;
          req.resume();
          reject(new DecisionPayloadTooLargeError());
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (exceeded) return;
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          const parsed = JSON.parse(text);
          resolve(parsed);
        } catch {
          reject(new DecisionValidationError("Invalid JSON in request body"));
        }
      });

      req.on("error", (err) => {
        reject(err);
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  private sendError(res: http.ServerResponse, err: unknown): void {
    let status = 500;
    let code = "internal_server_error";
    let message = "An internal server error occurred";

    if (err instanceof DecisionStoreError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof TypeError) {
      status = 400;
      code = "type_error";
      message = err.message;
    } else if (err instanceof Error) {
      message = err.message;
    }

    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code, message } }));
    }
  }
}

function parseExecutionProgress(value: unknown): { phase: string; responseLength: number } {
  if (!value || typeof value !== "object" || !("phase" in value) || !("responseLength" in value)
    || typeof value.phase !== "string" || typeof value.responseLength !== "number") {
    throw new DecisionValidationError("Invalid execution progress");
  }
  return { phase: value.phase, responseLength: value.responseLength };
}
