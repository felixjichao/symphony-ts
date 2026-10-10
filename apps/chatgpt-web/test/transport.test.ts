import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BridgeHttpError,
  FetchBridgeTransport,
  GmBridgeTransport,
} from "../src/transport";

interface MockGmOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  data?: string;
  onload: (res: { status: number; responseText: string }) => void;
  onerror: (err: unknown) => void;
  ontimeout: () => void;
  onabort: () => void;
}

const globalScope = globalThis as unknown as {
  fetch: typeof fetch;
  GM_xmlhttpRequest?: ((options: MockGmOptions) => { abort: () => void }) | undefined;
};

describe("Bridge Transports", () => {
  describe("BridgeHttpError", () => {
    it("preserves message, code, and status", () => {
      const err = new BridgeHttpError("Not Found", "task_not_found", 404);
      expect(err.message).toBe("Not Found");
      expect(err.code).toBe("task_not_found");
      expect(err.status).toBe(404);
      expect(err.name).toBe("BridgeHttpError");
    });
  });

  describe("FetchBridgeTransport", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends request with headers and authorization token", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok" }),
      });
      globalScope.fetch = mockFetch as unknown as typeof fetch;

      const transport = new FetchBridgeTransport({
        baseUrl: "http://127.0.0.1:4040",
        authToken: "secret-token",
      });

      const res = await transport.request<{ status: string }>("POST", "/v1/test", { hello: "world" });
      expect(res).toEqual({ status: "ok" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:4040/v1/test",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer secret-token",
          }),
          body: JSON.stringify({ hello: "world" }),
        })
      );
    });

    it("handles 204 No Content when allow204 is set", async () => {
      globalScope.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }) as unknown as typeof fetch;

      const transport = new FetchBridgeTransport();
      const res = await transport.request("GET", "/v1/tasks/next", undefined, { allow204: true });
      expect(res).toBeNull();
    });

    it("parses error response into BridgeHttpError", async () => {
      globalScope.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: async () => ({
          error: {
            code: "session_execution_in_progress",
            message: "Another task is active on this session",
          },
        }),
      }) as unknown as typeof fetch;

      const transport = new FetchBridgeTransport();
      await expect(transport.request("POST", "/v1/tasks/task-1/claim")).rejects.toThrowError(
        BridgeHttpError
      );
    });
  });

  describe("GmBridgeTransport", () => {
    beforeEach(() => {
      globalScope.GM_xmlhttpRequest = undefined;
    });

    afterEach(() => {
      delete globalScope.GM_xmlhttpRequest;
    });

    it("invokes GM_xmlhttpRequest and handles JSON responses", async () => {
      globalScope.GM_xmlhttpRequest = vi.fn((options: MockGmOptions) => {
        setTimeout(() => {
          options.onload({
            status: 200,
            responseText: JSON.stringify({ success: true }),
          });
        }, 10);
        return { abort: vi.fn() };
      });

      const transport = new GmBridgeTransport({
        baseUrl: "http://127.0.0.1:4040",
      });

      const res = await transport.request<{ success: boolean }>("GET", "/v1/tasks/1");
      expect(res).toEqual({ success: true });
    });

    it("handles 204 No Content under GM_xmlhttpRequest", async () => {
      globalScope.GM_xmlhttpRequest = vi.fn((options: MockGmOptions) => {
        setTimeout(() => {
          options.onload({
            status: 204,
            responseText: "",
          });
        }, 10);
        return { abort: vi.fn() };
      });

      const transport = new GmBridgeTransport();
      const res = await transport.request("GET", "/v1/tasks/next", undefined, { allow204: true });
      expect(res).toBeNull();
    });

    it("rejects on network error or timeout", async () => {
      globalScope.GM_xmlhttpRequest = vi.fn((options: MockGmOptions) => {
        setTimeout(() => {
          options.onerror(new Error("Connection refused"));
        }, 10);
        return { abort: vi.fn() };
      });

      const transport = new GmBridgeTransport();
      await expect(transport.request("GET", "/v1/tasks/1")).rejects.toThrow("Bridge network error");
    });
  });
});
