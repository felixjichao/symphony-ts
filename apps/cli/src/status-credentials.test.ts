/** SPEC §13 adjacent / §17–18: credential-origin regression through real host/status HTTP. */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { OperationalSnapshot } from "@symphony/domain";
import { createStructuredLogger } from "@symphony/observability";
import { createGitHubAdapterProfile, DefaultGhRunner, type GhExecOptions, type TrackerAdapterProfile } from "@symphony/tracker";
import { createHost } from "./host";
const key = { provider: "github", key: "acme/widget#1" };
const other: TrackerAdapterProfile = {
  kind: "other", documentation: "docs/testing.md", secretProviderKeys: ["token"], secretEnvVars: [],
  defaultActiveStates: ["open"], defaultTerminalStates: ["closed"],
  resolveProviderConfig: provider => provider,
  createAdapter: () => ({ kind: "other", fetchIssuesByIds: async () => [], fetchIssuesByStates: async () => [] }),
};
afterEach(() => vi.restoreAllMocks());
async function harness(kind = "github", apiUrl?: string, token = "fixture-public") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "status-origin-"));
  const workflowPath = path.join(dir, "WORKFLOW.md"); let tick = () => {}; let revision = 0;
  const write = async (providerKind: string, origin: string | undefined, secret: string) => {
    await writeFile(workflowPath, `---\ntracker:\n  kind: ${providerKind}\n  provider:\n    repo: acme/widget\n    token: ${secret}\n${origin ? `    api_url: ${origin}\n` : ""}workspace:\n  root: ${dir}/work\ncodex:\n  command: echo fixture\n---\nPrompt\n`);
    const time = new Date(Date.now() + ++revision * 1000); await utimes(workflowPath, time, time);
  };
  await write(kind, apiUrl, token);
  const logs: string[] = [];
  const host = await createHost({ workflowPath, cwd: dir, enablePlanning: false,
    trackerProfiles: [createGitHubAdapterProfile({ transport: { fetchPayloadsByIds: async () => [], fetchPayloadsByStates: async () => [] } }), other],
    logger: createStructuredLogger({ sinks: [{ write: line => { logs.push(line); } }] }),
    scheduler: { schedule: () => ({}), cancel: () => {} },
    watcherScheduler: { schedule(callback) { tick = callback; return {}; }, cancel: () => {} },
    status: { workKeys: [key], assets: fileURLToPath(new URL("../dist/status-assets", import.meta.url)) },
  });
  await host.start();
  return { logs, host,
    async reload(nextKind: string, origin: string | undefined, secret: string) {
      await write(nextKind, origin, secret); tick();
      expect(host.effective.serviceConfig.tracker.kind).toBe(nextKind);
      expect(host.effective.serviceConfig.tracker.provider["token"]).toBe(secret);
    },
    async snapshot() {
      const response = await fetch(`${host.statusUrl}/api/operations/snapshot`); expect(response.status).toBe(200);
      return await response.json() as OperationalSnapshot;
    },
    async close() { await host.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}
function ghResponse(args: readonly string[]) {
  if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acme/widget", defaultBranchRef: { name: "main" } }), stderr: "", exitCode: 0 };
  if (args[0] === "issue") return { stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/acme/widget/issues/1" }), stderr: "", exitCode: 0 };
  if (args[0] === "api") return { stdout: "[]", stderr: "", exitCode: 0 };
  throw new Error("Unexpected external command");
}
it.each([undefined, "https://api.github.com/"])("uses public GitHub credentials with the public API configuration: %s", async origin => {
  const calls: GhExecOptions[] = [];
  vi.spyOn(DefaultGhRunner.prototype, "exec").mockImplementation(async (args, options) => { calls.push(options!); return ghResponse(args); });
  const h = await harness("github", origin);
  try {
    const snapshot = await h.snapshot(); expect(snapshot.work[0]?.freshness.github.status).toBe("fresh");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.env).toEqual({ GH_TOKEN: "fixture-public", GH_HOST: "github.com" });
    expect(JSON.stringify(snapshot)).not.toContain("fixture-public");
  } finally { await h.close(); }
});
it.each([
  ["github", "https://enterprise.invalid/api/v3"],
  ["github", "https://api.github.com/enterprise"],
  ["github", "https://api.github.com.evil.invalid"],
  ["other", "https://api.github.com"],
])("rejects unsupported source %s / %s before subprocess or ambient credential fallback", async (kind, origin) => {
  const runner = vi.spyOn(DefaultGhRunner.prototype, "exec").mockRejectedValue(new Error("must not execute"));
  const h = await harness(kind, origin, "fixture-private-origin");
  try {
    const snapshot = await h.snapshot(); expect(snapshot.work[0]?.freshness.github.status).toBe("unavailable");
    expect(snapshot.work[0]?.pullRequest).toBeNull(); expect(runner).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot) + h.logs.join(" ")).not.toContain("fixture-private-origin");
  } finally { await h.close(); }
});
it("revalidates provider/origin and captures credentials across reload and in-flight observations", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: GhExecOptions[] = []; let first = true;
  vi.spyOn(DefaultGhRunner.prototype, "exec").mockImplementation(async (args, options) => {
    calls.push(options!);
    if (first) { first = false; entered(); await blocked; }
    return ghResponse(args);
  });
  const h = await harness();
  try {
    const inFlight = h.snapshot(); await started;
    await h.reload("github", "https://enterprise.invalid/api/v3", "fixture-enterprise");
    release(); expect((await inFlight).work[0]?.freshness.github.status).toBe("fresh");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.env).toEqual({ GH_TOKEN: "fixture-public", GH_HOST: "github.com" });
    expect((await h.snapshot()).work[0]?.freshness.github.status).toBe("unavailable"); expect(calls).toHaveLength(3);
    await h.reload("other", "https://api.github.com", "fixture-other");
    expect((await h.snapshot()).work[0]?.freshness.github.status).toBe("unavailable"); expect(calls).toHaveLength(3);
    await h.reload("github", "https://api.github.com", "fixture-new-public");
    const recovered = await h.snapshot(); expect(recovered.work[0]?.freshness.github.status).toBe("fresh");
    expect(calls).toHaveLength(6);
    for (const call of calls.slice(3)) expect(call.env).toEqual({ GH_TOKEN: "fixture-new-public", GH_HOST: "github.com" });
    expect(JSON.stringify(recovered) + h.logs.join(" ")).not.toMatch(/fixture-(enterprise|other|new-public)/);
  } finally { release(); await h.close(); }
});
