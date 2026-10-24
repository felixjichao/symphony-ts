import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableDecisionStore, DecisionService, DecisionBridge } from "@symphony/decision";
import { githubDecisionRoot } from "@symphony/domain/decision";
import { MockDocument, MockWindow } from "./mock-dom";
import { initSymphonyUserscript, type UserscriptController } from "../src/userscript-entry";
import { MemoryCheckpointStore } from "../src/checkpoint";
import { FetchBridgeTransport, BridgeHttpError } from "../src/transport";
import { ChatGptWebAdapter } from "../src/adapter";

class MockSessionStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

describe("Userscript Entry & SessionStorage Page Reconstruction", () => {
  let originalWindow: unknown;
  let originalDocument: unknown;
  let mockDoc: MockDocument;
  let mockWin: MockWindow & { sessionStorage: MockSessionStorage };
  let sessionStorage: MockSessionStorage;
  let activeController: UserscriptController | null = null;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    mockDoc = new MockDocument();
    mockWin = new MockWindow() as MockWindow & { sessionStorage: MockSessionStorage };
    sessionStorage = new MockSessionStorage();
    mockWin.sessionStorage = sessionStorage;
    Object.assign(mockWin, { localStorage: sessionStorage });

    // Attach to global scope for userscript execution
    (globalThis as unknown as { window: unknown }).window = mockWin;
    (globalThis as unknown as { document: unknown }).document = mockDoc;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (activeController) {
      activeController.stop();
      activeController = null;
    }
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { document: unknown }).document = originalDocument;
  });

  it("restores and saves the response timeout when starting the driver", async () => {
    const saved = vi.fn();
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "symphony_response_timeout_minutes" ? 20 : fallback);
    vi.stubGlobal("GM_setValue", saved);
    activeController = initSymphonyUserscript();
    const input = mockDoc.getElementById("symphony-response-timeout-input") as unknown as HTMLInputElement;
    expect(input.value).toBe("20");
    input.value = "25";
    await activeController.start();
    expect(saved).toHaveBeenCalledWith("symphony_response_timeout_minutes", 25);
    expect(activeController.getDriver()).not.toBeNull();
  });

  it.each(["0", "61", "1.5", ""]) ("rejects invalid timeout input %s before starting", async (value) => {
    activeController = initSymphonyUserscript();
    const input = mockDoc.getElementById("symphony-response-timeout-input") as unknown as HTMLInputElement;
    input.value = value;
    await activeController.start();
    expect(activeController.isRunning()).toBe(false);
    expect(activeController.getDriver()).toBeNull();
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();
    expect(mockDoc.getElementById("symphony-driver-status")?.textContent).toContain("1 to 60");
  });

  it("initializes in Idle state without auto-starting when sessionStorage is empty", () => {
    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBeNull();

    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Start Driver");
  });

  it("automatically starts driver across page reconstruction when symphony_driver_enabled is true", async () => {
    sessionStorage.setItem("symphony_driver_enabled:http://127.0.0.1:4040", "true");

    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Running");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Stop Driver");
  });

  it("clicking Start Driver persists symphony_driver_enabled = true", () => {
    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBeNull();

    // Click to start
    toggleBtn?.click();

    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBe("true");
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Running");
  });

  it("clicking Stop Driver clears symphony_driver_enabled to false", () => {
    sessionStorage.setItem("symphony_driver_enabled:http://127.0.0.1:4040", "true");
    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBe("true");

    // Click to stop
    toggleBtn?.click();

    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBe("false");
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
  });

  it("reopens with a new tab identity and honors persistent Stop across pages", async () => {
    activeController = initSymphonyUserscript({ autoStart: true });
    activeController.getDriver()?.stop(); // Page loss, not the user's durable Stop.
    mockDoc = new MockDocument();
    (globalThis as unknown as { document: unknown }).document = mockDoc;
    mockWin.sessionStorage = new MockSessionStorage();
    activeController = initSymphonyUserscript();
    expect(activeController.isRunning()).toBe(true);
    activeController.stop();
    mockDoc = new MockDocument();
    (globalThis as unknown as { document: unknown }).document = mockDoc;
    activeController = initSymphonyUserscript();
    expect(activeController.isRunning()).toBe(false);
  });

  // #162 / SPEC §13 adjacent, §17/§18: a fresh page must surface native waiting/block facts.
  it.each([false, true])("shows authoritative recovery state after identity loss (blocked=%s) without adopting a lease", async blocked => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userscript-lost-identity-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    try {
      const { port } = await bridge.start();
      const session = await service.createSession(githubDecisionRoot("owner", "repo", 162));
      const task = await service.createPlanTask(session.id);
      const claim = await service.claimTask(task.id, { owner: "previous-browser-tab" });
      await service.startTask(task.id, claim.lease);
      await service.heartbeatTask(task.id, { ...claim.lease, progress: { phase: "waiting_response", responseLength: 10 } });
      if (blocked) await service.blockExecution(task.id, { ...claim.lease, reason: "human_required" });
      const before = service.getTask(task.id);
      const execution = service.getExecution(task.id);
      const requests: string[] = [];
      const real = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${port}` });
      const transport: import("../src/transport").BridgeTransport = {
        request: async (method, route, body, options) => {
          requests.push(`${method} ${route}`);
          return real.request(method, route, body, options);
        },
      };
      activeController = initSymphonyUserscript({ autoStart: true, transport, pollIntervalMs: 10 });
      await vi.waitFor(() => expect(mockDoc.getElementById("symphony-status-pill")?.textContent)
        .toContain(blocked ? "Blocked" : "Waiting"));
      expect(mockDoc.getElementById("symphony-driver-status")?.textContent).toContain(task.id);
      expect(mockDoc.getElementById("symphony-driver-status")?.textContent).toContain(blocked ? "human_required" : "no local checkpoint");
      expect(mockDoc.getElementById("symphony-toggle-btn")?.textContent).toBe("Stop Driver");
      expect(activeController.getDriver()?.checkpointStore.get()).toBeNull();
      expect(requests).toContain("GET /v1/continuity");
      expect(requests.every(request => request.startsWith("GET "))).toBe(true);
      expect(service.getTask(task.id)).toEqual(before);
      expect(service.getExecution(task.id)).toEqual(execution);
      expect(service.getReceipt(task.id)).toBeNull();
      await service.cancelTask(task.id);
      await vi.waitFor(() => expect(mockDoc.getElementById("symphony-status-pill")?.textContent).toContain("Running"));
      expect(mockDoc.getElementById("symphony-driver-status")?.textContent).toBe("Polling for Decision tasks");
      activeController.stop();
      expect(mockDoc.getElementById("symphony-status-pill")?.textContent).toContain("Idle");
    } finally { activeController?.stop(); await bridge.stop(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("does not overwrite Stop when an idle continuity read completes late", async () => {
    let complete: ((value: unknown) => void) | undefined;
    const response = new Promise<unknown>(resolve => { complete = resolve; });
    let reading = false;
    const transport: import("../src/transport").BridgeTransport = {
      request: async <T>(_method: string, route: string): Promise<T> => {
        if (route === "/v1/tasks/next") return null as T;
        reading = true;
        return await response as T;
      },
    };
    activeController = initSymphonyUserscript({ autoStart: true, transport, pollIntervalMs: 10 });
    await vi.waitFor(() => expect(reading).toBe(true));
    activeController.stop();
    complete!({ work: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockDoc.getElementById("symphony-status-pill")?.textContent).toContain("Idle");
    expect(mockDoc.getElementById("symphony-driver-status")?.textContent).toBe("Driver stopped");
    expect(activeController.isRunning()).toBe(false);
  });

  it("auto-starts across reconstruction, consumes checkpoint, and completes work against controlled bridge", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "userscript-e2e-"));
    const store = new DurableDecisionStore({ storeDir: dir });
    await store.open();
    const service = new DecisionService(store);
    const bridge = new DecisionBridge(service, { port: 0 });
    await bridge.start();

    try {
      const root = githubDecisionRoot("owner", "repo", 42);
      let session = await service.createSession(root);
      session = await service.putBinding(session.id, { adapter: "chatgpt-web", externalSessionRef: "c-42", resumeUri: null });
      const task = await service.createPlanTask(session.id);
      const claim = await service.claimTask(task.id, { owner: "userscript-worker" });
      await service.startTask(task.id, {
        owner: claim.lease.owner,
        token: claim.lease.token,
        generation: claim.lease.generation,
      });

      const cpStore = new MemoryCheckpointStore();
      cpStore.set({
        schemaVersion: 1,
        tabId: cpStore.tabId,
        taskId: task.id,
        sessionId: session.id,
        leaseOwner: claim.lease.owner,
        leaseToken: claim.lease.token,
        leaseGeneration: claim.lease.generation,
        leaseExpiresAtMs: claim.lease.expiresAtMs,
        bindingGeneration: 1,
        step: "result_extracted",
        attemptId: "test-att",
        savedAtMs: Date.now(),
        candidateResult: {
          schemaVersion: 1,
          taskId: task.id,
          sessionId: session.id,
          kind: "plan",
          revision: task.revision,
          verdict: "ready",
          content: { plan: "userscript recovery success", acceptanceCriteria: [], risks: [], clarifications: [] },
          createdAtMs: Date.now(),
        },
      });

      const adapter = new ChatGptWebAdapter({
        doc: mockDoc as unknown as Document,
        win: mockWin as unknown as Window,
      });

      sessionStorage.setItem("symphony_driver_enabled:http://127.0.0.1:4040", "true");
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      activeController = initSymphonyUserscript({
        transport,
        checkpointStore: cpStore,
        adapter,
        pollIntervalMs: 50,
      });

      // Poll until checkpoint is consumed and task completes
      const startMs = Date.now();
      while (service.getTask(task.id)?.status !== "completed" || cpStore.get() !== null) {
        if (Date.now() - startMs > 5000) {
          throw new Error("Timeout waiting for userscript auto-start to complete recovered task");
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(service.getTask(task.id)?.status).toBe("completed");
      expect(cpStore.get()).toBeNull();
    } finally {
      activeController?.stop();
      activeController = null;
      await bridge.stop();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stops mutations but retains persistent intent on 401/403 for read-only authorization recovery", async () => {
    sessionStorage.setItem("symphony_driver_enabled:http://127.0.0.1:4040", "true");

    const rejectingTransport = {
      baseUrl: "http://127.0.0.1:4040",
      request: async <T>(): Promise<T> => {
        throw new BridgeHttpError("Unauthorized: invalid credentials", "unauthorized", 401);
      },
    };

    activeController = initSymphonyUserscript({
      transport: rejectingTransport,
      pollIntervalMs: 20,
    });

    const startMs = Date.now();
    while (activeController.isRunning()) {
      if (Date.now() - startMs > 2000) throw new Error("Timeout waiting for authorization block");
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sessionStorage.getItem("symphony_driver_enabled:http://127.0.0.1:4040")).toBe("true");
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Error");
  });
});
