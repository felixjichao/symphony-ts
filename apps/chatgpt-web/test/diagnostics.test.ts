import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverDiagnostics, type DriverDiagnostic } from "../src/diagnostics";
import { SELECTORS } from "../src/probes";

const event: DriverDiagnostic = { taskId: "test-task", stage: "response_wait", kind: "review", revision: 2,
  wait: { phase: "timeout", reason: "no_new_turn", selector: null, baselineCount: 4, currentCount: 1,
    candidateFound: false, matchingTaskResult: false, stopPresent: false, elapsedMs: 900_000 } };
afterEach(() => vi.unstubAllGlobals());
describe("bounded local Driver diagnostics", () => {
  it("retains the final failure and only the last 50 events across reload", () => {
    let saved = "[]";
    vi.stubGlobal("GM_getValue", () => saved);
    vi.stubGlobal("GM_setValue", (_key: string, value: string) => { saved = value; });
    const output = vi.fn();
    const trace = new DriverDiagnostics("tab-test", output);
    for (let revision = 1; revision <= 55; revision++) trace.record({ ...event, revision });
    trace.record({ ...event, stage: "task_failed", revision: 55 });
    const restored = vi.fn();
    new DriverDiagnostics("tab-test", restored);
    const records = JSON.parse(restored.mock.calls[0]?.[0] as string) as Array<{ stage: string; revision: number }>;
    expect(records).toHaveLength(50);
    expect(records[0]?.revision).toBe(7);
    expect(records.at(-1)?.stage).toBe("task_failed");
  });
  it("does not preserve prompt, raw error, credential or reply properties", () => {
    let saved = "";
    vi.stubGlobal("GM_setValue", (_key: string, value: string) => { saved = value; });
    const trace = new DriverDiagnostics("tab-test", () => {});
    trace.record({ ...event, prompt: "PROMPT_SECRET", token: "TOKEN_SECRET", reply: "REPLY_SECRET", error: "ERROR_SECRET" } as DriverDiagnostic);
    expect(saved).not.toContain("SECRET");
    expect(saved).toContain("no_new_turn");
    expect(saved).toContain('"currentCount":1');
  });
  it.each([
    { reason: { token: "TOKEN_SECRET" } },
    { selector: { reply: "REPLY_SECRET" } },
    { reason: "PROMPT_SECRET" },
    { selector: "REPLY_SECRET" },
    { phase: "ERROR_SECRET" },
    { elapsedMs: -1 },
    { elapsedMs: "TOKEN_SECRET" },
    { baselineCount: Infinity },
    { candidateFound: { token: "TOKEN_SECRET" } },
    { stopPresent: "true" },
  ])("drops malformed persisted wait metadata before rendering and re-saving: %j", malformed => {
    let saved = JSON.stringify([{ ...event, atMs: 1, wait: { ...event.wait, ...malformed } }]);
    vi.stubGlobal("GM_getValue", () => saved);
    vi.stubGlobal("GM_setValue", (_key: string, value: string) => { saved = value; });
    const output = vi.fn();
    const trace = new DriverDiagnostics("tab-test", output);
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual([{ ...event, atMs: 1, wait: undefined }]);
    trace.record(event);
    expect(saved).not.toContain("SECRET");
    expect(JSON.parse(saved)).toHaveLength(2);
  });
  it("restores supported selector unions and rejects invalid outer metadata", () => {
    const valid = { ...event, atMs: 1, wait: { ...event.wait,
      selector: `${SELECTORS.assistantTurn[0]}, ${SELECTORS.assistantTurn[3]}` } };
    vi.stubGlobal("GM_getValue", () => JSON.stringify([valid,
      { ...valid, stage: "token_secret" }, { ...valid, atMs: -1 }, { ...valid, revision: 1.5 }]));
    const output = vi.fn();
    new DriverDiagnostics("tab-test", output);
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual([valid]);
  });
  it("survives corrupted storage and failures in persistence or HUD rendering", () => {
    vi.stubGlobal("GM_getValue", () => "not-json");
    vi.stubGlobal("GM_setValue", () => { throw new Error("storage unavailable"); });
    expect(() => new DriverDiagnostics("tab-test", () => { throw new Error("HUD unavailable"); }).record(event)).not.toThrow();
  });
});
