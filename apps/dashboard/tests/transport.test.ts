import { afterEach, describe, expect, it, vi } from "vitest";
import { readSnapshot } from "../src/transport";
import { validateSnapshot } from "../src/validate";
import { snapshot, work } from "./fixtures";
afterEach(() => vi.unstubAllGlobals());
describe("fixed snapshot transport", () => {
  it.each([404, 405, 500, 502, 504])( "distinguishes HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
    await expect(readSnapshot(new AbortController().signal)).rejects.toThrow(`HTTP ${status}`);
  });
  it("uses a fixed GET without redirects or cache and preserves the full JSON", async () => {
    const data = snapshot(); const fetcher = vi.fn(async () => Response.json(data)); vi.stubGlobal("fetch", fetcher);
    expect(await readSnapshot(new AbortController().signal)).toEqual(data); expect(fetcher.mock.calls[0]).toMatchObject(["/api/operations/snapshot", { method: "GET", cache: "no-store", redirect: "error" }]);
  });
  it.each(["partial", "all"])("accepts %s unavailable sources with 200", async () => { const data = snapshot({ health: "unavailable", sources: [{ source: "github", instance: "test", freshness: { status: "unavailable", observedAt: null, lastAttemptAt: 1, reason: "error" } }] }); vi.stubGlobal("fetch", async () => Response.json(data)); expect(await readSnapshot(new AbortController().signal)).toEqual(data); });
  it("reports connection failure separately from server errors", async () => { vi.stubGlobal("fetch", async () => { throw new TypeError("private detail"); }); await expect(readSnapshot(new AbortController().signal)).rejects.toThrow("连接失败"); });
  it.each([{ schemaVersion: "1" }, { schemaVersion: 2 }, { work: [{}] }, { summary: { active: "bad" } }, { generatedAt: null }])("rejects bad shape/version %s without defaults", overrides => expect(() => validateSnapshot({ ...snapshot(), ...overrides })).toThrow());
  it("accepts legacy optional counts and inconsistent but legal conclusions", () => {
    const data = snapshot({ summary: { active: 0, waiting: 0, retrying: 0, needsHuman: 0 }, work: [work()] }); expect(() => validateSnapshot(data)).not.toThrow(); expect(data.summary.degradedWork).toBeUndefined();
  });
  it("does not leak malformed JSON", async () => { vi.stubGlobal("fetch", async () => new Response("private-not-json")); await expect(readSnapshot(new AbortController().signal)).rejects.toThrow("响应格式 / 版本不兼容"); });
});
