import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

    // Attach to global scope for userscript execution
    (globalThis as unknown as { window: unknown }).window = mockWin;
    (globalThis as unknown as { document: unknown }).document = mockDoc;
  });

  afterEach(() => {
    if (activeController) {
      activeController.stop();
      activeController = null;
    }
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { document: unknown }).document = originalDocument;
  });

  it("initializes in Idle state without auto-starting when sessionStorage is empty", () => {
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();

    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Start Driver");
  });

  it("automatically starts driver across page reconstruction when symphony_driver_enabled is true", async () => {
    sessionStorage.setItem("symphony_driver_enabled", "true");

    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Running");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Stop Driver");
  });

  it("clicking Start Driver persists symphony_driver_enabled = true", () => {
    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();

    // Click to start
    toggleBtn?.click();

    expect(sessionStorage.getItem("symphony_driver_enabled")).toBe("true");
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Running");
  });

  it("clicking Stop Driver clears symphony_driver_enabled to false", () => {
    sessionStorage.setItem("symphony_driver_enabled", "true");
    activeController = initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBe("true");

    // Click to stop
    toggleBtn?.click();

    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
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

      sessionStorage.setItem("symphony_driver_enabled", "true");
      const transport = new FetchBridgeTransport({ baseUrl: `http://127.0.0.1:${bridge.getPort()}` });

      activeController = initSymphonyUserscript({
        transport,
        checkpointStore: cpStore,
        adapter,
        pollIntervalMs: 50,
      });

      // Poll until checkpoint is consumed and task completes
      const startMs = Date.now();
      while (service.getTask(task.id)?.status !== "completed") {
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

  it("stops driver and clears enabled flag upon fatal 401/403 authorization error", async () => {
    sessionStorage.setItem("symphony_driver_enabled", "true");

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

    // Wait briefly for driver loop to hit 401
    const startMs = Date.now();
    while (sessionStorage.getItem("symphony_driver_enabled") !== null) {
      if (Date.now() - startMs > 2000) {
        throw new Error("Timeout waiting for 401 error to clear driver enabled state");
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Error");
  });
});
