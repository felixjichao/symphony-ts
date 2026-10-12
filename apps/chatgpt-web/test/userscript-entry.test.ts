import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockDocument, MockWindow } from "./mock-dom";
import { initSymphonyUserscript } from "../src/userscript-entry";

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
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { document: unknown }).document = originalDocument;
  });

  it("initializes in Idle state without auto-starting when sessionStorage is empty", () => {
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();

    initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Start Driver");
  });

  it("automatically starts driver across page reconstruction when symphony_driver_enabled is true", async () => {
    sessionStorage.setItem("symphony_driver_enabled", "true");

    initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Running");
    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(toggleBtn?.textContent).toBe("Stop Driver");
  });

  it("clicking Start Driver persists symphony_driver_enabled = true", () => {
    initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

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
    initSymphonyUserscript({ bridgeBaseUrl: "http://127.0.0.1:4040" });

    const toggleBtn = mockDoc.getElementById("symphony-toggle-btn");
    expect(sessionStorage.getItem("symphony_driver_enabled")).toBe("true");

    // Click to stop
    toggleBtn?.click();

    expect(sessionStorage.getItem("symphony_driver_enabled")).toBeNull();
    const statusPill = mockDoc.getElementById("symphony-status-pill");
    expect(statusPill?.textContent).toContain("Idle");
  });
});
