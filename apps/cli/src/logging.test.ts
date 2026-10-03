/** §17.6 integration: public implementations, temp workflow/fs, real app-server child. */
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAgentAttempt } from "@symphony/agent";
import { loadEffectiveWorkflow, watchWorkflow } from "@symphony/config";
import { createStructuredLogger } from "@symphony/observability";
import { OrchestratorAuthority, OrchestratorLoop, createOrchestratorRuntimeState } from "@symphony/orchestrator";
import { createGitHubAdapterProfile, TrackerAdapterRegistry, TrackerError } from "@symphony/tracker";
import { createWorkspaceManager } from "@symphony/workspace";
import { createRuntimeLogObservers, registerTrackerLogSecrets } from "./logging";
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fixture = fileURLToPath(new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url));
const good = { id: 1, number: 1, title: "work", state: "open" };
const bad = { number: 2, title: "", state: "open" };
async function harness(failSink = false, failFormat = false, beforeRemove = "echo hook-body secret-token; exit 1", hookTimeoutMs = 5000) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-log-"));
  const root = path.join(temp, "ws"); const workflowPath = path.join(temp, "WORKFLOW.md");
  const lines: string[] = [];
  const logger = createStructuredLogger({ now() { if (failFormat) throw new Error("formatter clock"); return new Date(); }, sinks: [{ write(line) { lines.push(line); if (failSink) throw new Error("sink"); } }] });
  const observers = createRuntimeLogObservers(logger);
  const profile = createGitHubAdapterProfile({ onMalformedRecord: observers.onMalformedRecord, transport: {
    fetchPayloadsByStates: async () => [good, bad], fetchPayloadsByIds: async () => [good],
  } });
  const registry = new TrackerAdapterRegistry([profile]);
  const command = [process.execPath, fixture, "--record-world", "world.json", "--logging-stderr", "--delay-completed-ms", "150"].map(quote).join(" ") + ' --cwd "$(pwd)"';
  const workflow = `---\n${JSON.stringify({ tracker: { kind: "github", provider: { repo: "acme/widget", token: "secret-token" } }, workspace: { root },
    agent: { max_turns: 2 }, codex: { command, read_timeout_ms: 5000, turn_timeout_ms: 5000 },
    hooks: { after_run: "echo secret-token; exit 1", before_remove: beforeRemove, timeout_ms: hookTimeoutMs } })}\n---\nHandle {{ issue.identifier }}\n`;
  await writeFile(workflowPath, workflow);
  registerTrackerLogSecrets(logger, profile, { token: "secret-token" }, {});
  const effective = loadEffectiveWorkflow({ path: workflowPath, trackerExtension: registry.createConfigExtension() });
  const adapter = observers.observeTracker(registry.create(effective.serviceConfig.tracker));
  const manager = createWorkspaceManager({ workspace: effective.serviceConfig.workspace });
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30000, maxConcurrentAgents: 1 });
  const authority = new OrchestratorAuthority({ state,
    policy: { activeStates: ["open"], terminalStates: ["closed"], requiredLabels: [], maxConcurrentAgentsByState: {} },
    tracker: adapter, runner: runAgentAttempt,
    createAttemptOptions: (context) => observers.observeAttempt({ ...context, workflow: effective.definition, workflowPath, getConfig: () => effective.serviceConfig }),
    resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
    onEvent: observers.onEvent, onOutcome: observers.onOutcome, onCleanupDiagnostic: observers.onCleanupDiagnostic,
    cleanupWorkspace: observers.observeCleanup(manager, () => effective.serviceConfig.hooks),
  });
  const loop = new OrchestratorLoop({ authority, candidates: adapter,
    preflight: { preflight: () => ({ ok: true, effective: { pollIntervalMs: 30000, maxConcurrentAgents: 1, policy: { activeStates: ["open"], terminalStates: ["closed"], requiredLabels: [], maxConcurrentAgentsByState: {} } } }) },
    onDiagnostic: observers.onDiagnostic,
  });
  return { temp, workflowPath, workflow, logger, lines, observers, registry, effective, adapter, authority, loop, state, manager,
    async close() { await loop.stop(); logger.close(); await rm(temp, { recursive: true, force: true }); } };
}
describe("runtime logging composition", () => {
  it.each([false, true])("logs real session/worker/hook facts and malformed candidates without changing worker result, sink throws=%s", async (failSink) => {
    const h = await harness(failSink);
    try {
      h.observers.lifecycle({ event: "startup", outcome: "started" });
      await h.loop.start(); h.observers.lifecycle({ event: "startup", outcome: "completed" });
      const candidates = await h.adapter.fetchIssuesByStates(["open"]);
      expect(candidates).toHaveLength(1);
      h.authority.dispatchIssue(candidates[0]!); await h.authority.waitForIdle();
      const world = JSON.parse(await readFile(path.join(h.manager.resolveWorkspacePath("GH-1"), "world.json"), "utf8")) as { pid: number };
      expect(() => process.kill(world.pid, 0)).toThrow();
      expect(h.state.completed.size).toBe(1); expect(h.state.running.size).toBe(0);
      expect(h.lines.some((s) => s.includes('event="tracker_record_omitted"'))).toBe(true);
      expect(h.lines.some((s) => s.includes('event="agent_thread_started"') && !s.includes("session_id="))).toBe(true);
      expect(h.lines.some((s) => s.includes('event="turn_completed"') && s.includes("session_id="))).toBe(true);
      expect(h.lines.some((s) => s.includes('event="worker_finished"') && s.includes("session_id="))).toBe(true);
      expect(h.lines.some((s) => s.includes('event="workspace_hook"'))).toBe(true);
      for (const line of h.lines.filter((s) => s.includes('issue_id='))) {
        expect(line).toContain('issue_id="1"'); expect(line).toContain('issue_identifier="GH-1"');
      }
      expect(h.lines.some((s) => s.includes("fragment [REDACTED] diagnostic"))).toBe(true);
      expect(h.lines.some((s) => s.includes("[truncated]"))).toBe(true);
      expect(h.lines.some((s) => s.includes("diagnostic payload omitted"))).toBe(true);
      expect(h.lines.some((s) => s.includes("after overflow recovery"))).toBe(true);
      expect(h.lines.join("\n")).not.toContain("secret-token");
      h.observers.lifecycle({ event: "shutdown", outcome: "started" }); await h.loop.stop(); h.observers.lifecycle({ event: "shutdown", outcome: "completed" });
      expect(h.lines.at(-1)).toContain('event="shutdown" outcome="completed"');
    } finally { await h.close(); }
  });
  it.each([
    ["failure", "echo hook-body secret-token; exit 1", 5000, "failed"],
    ["timeout", "echo hook-body secret-token; sleep 30", 30, "timeout"],
  ] as const)("before_remove %s is visible with explicit issue context and deletion continues", async (_kind, script, timeout, reason) => {
    const h = await harness(false, false, script, timeout);
    try {
      const workspace = await h.manager.createWorkspace("GH-1");
      const result = await h.authority.runStartupTerminalCleanup();
      expect(result.removed).toEqual(["GH-1"]);
      await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
      const hook = h.lines.find((s) => s.includes('hook="before_remove"'));
      expect(hook).toContain('event="workspace_hook" outcome="failed"');
      expect(hook).toContain(`reason="${reason}"`);
      expect(hook).toContain('issue_id="1" issue_identifier="GH-1"');
      expect(h.lines.at(-1)).toContain('event="workspace_cleanup" outcome="completed"');
      expect(h.lines.join()).not.toMatch(/hook-body|secret-token|sleep 30/);
    } finally { await h.close(); }
  });
  it("throwing hook observer cannot change before_remove best-effort deletion", async () => {
    const h = await harness();
    try {
      const workspace = await h.manager.createWorkspace("GH-1");
      let calls = 0;
      const observers = createRuntimeLogObservers({
        ...h.logger, emit() { calls++; throw new Error("observer failed secret-token"); },
      });
      const cleanup = observers.observeCleanup(h.manager, () => h.effective.serviceConfig.hooks);
      expect(await cleanup.removeWorkspaceForIssue({ issueId: "1", identifier: "GH-1" })).toMatchObject({ status: "removed" });
      expect(calls).toBe(1);
      await expect(access(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await h.close(); }
  });
  it("formatter clock failure does not change real loop/worker completion or cleanup", async () => {
    const h = await harness(false, true);
    try {
      await h.loop.start();
      const candidates = await h.adapter.fetchIssuesByStates(["open"]);
      h.authority.dispatchIssue(candidates[0]!); await h.authority.waitForIdle();
      expect(h.state.completed.size).toBe(1); expect(h.state.running.size + h.state.claimed.size).toBe(0);
      expect(h.lines.length).toBeGreaterThan(0);
      expect(h.lines.every((s) => s.includes("logging_format_failed") && !s.includes("secret-token"))).toBe(true);
    } finally { await h.close(); }
  });
  it("invalid real workflow reload preserves current and fixed log reasons omit YAML/error payload", async () => {
    const h = await harness();
    const watcher = watchWorkflow({ path: h.workflowPath, trackerExtension: h.registry.createConfigExtension(), intervalMs: 100000, onEvent: h.observers.onWorkflowEvent });
    try {
      const current = watcher.current();
      await writeFile(h.workflowPath, "---\n[secret-token\n---\n"); watcher.reload();
      expect(watcher.current()).toBe(current); expect(h.lines.at(-1)).toContain("workflow_rejected");
      await writeFile(h.workflowPath, h.workflow); watcher.reload();
      expect(h.lines.at(-1)).toContain("watcher_version_accepted"); expect(h.lines.join()).not.toContain("secret-token");
    } finally { watcher.close(); await h.close(); }
  });
  it("startup preflight failure is operator-visible and tracker errors rethrow original object", async () => {
    const h = await harness();
    try {
      const loop = new OrchestratorLoop({ authority: h.authority, candidates: h.adapter, preflight: { preflight: () => ({ ok: false, error: "secret-token" }) }, onDiagnostic: h.observers.onDiagnostic });
      await expect(loop.start()).rejects.toThrow(); await loop.stop();
      expect(h.lines.some((s) => s.includes("startup_validation_failed"))).toBe(true);
      const error = new TrackerError("tracker_request", "secret-token", { providerDetail: { raw: "secret-token" } });
      const adapter = h.observers.observeTracker({ kind: "github", fetchIssuesByStates: async () => { throw error; }, fetchIssuesByIds: async () => { throw error; } });
      await expect(adapter.fetchIssuesByStates(["open"])).rejects.toBe(error);
      await expect(adapter.fetchIssuesByIds(["1"])).rejects.toBe(error);
      expect(h.lines.join()).not.toContain("secret-token"); expect(h.lines.at(-1)).toContain("tracker_request");
      const errors = h.lines.filter((s) => s.includes('event="tracker_error"'));
      expect(errors.at(-2)).toContain('operation="fetch_issues_by_states"');
      expect(errors.at(-1)).toContain('operation="fetch_issues_by_ids"');
    } finally { await h.close(); }
  });
  it("initial load/profile failures log only stable codes; secret registration covers raw/resolved/env rotation", async () => {
    const h = await harness();
    try {
      try { loadEffectiveWorkflow({ path: path.join(h.temp, "MISSING.md") }); }
      catch (error) { h.observers.onConfigFailure(error); }
      expect(h.lines.at(-1)).toContain('event="config_validation" outcome="failed"');
      try { h.registry.create({ ...h.effective.serviceConfig.tracker, provider: { repo: "invalid-secret-repo", token: "secret-token" } }); }
      catch (error) { h.observers.onConfigFailure(error); }
      expect(h.lines.at(-1)).toContain("invalid_tracker_config");
      expect(h.lines.join()).not.toContain("invalid-secret-repo");
      const profile = createGitHubAdapterProfile();
      registerTrackerLogSecrets(h.logger, profile, { token: "raw-declaration" }, { GITHUB_TOKEN: "env-secret" });
      registerTrackerLogSecrets(h.logger, profile, { token: "resolved-secret" }, { GITHUB_TOKEN: "rotated-secret" });
      h.logger.emit({ scope: "service", event: "diagnostic", severity: "warn", outcome: "completed", message: "raw-declaration env-secret resolved-secret rotated-secret" });
      expect(h.lines.at(-1)).not.toMatch(/raw-declaration|env-secret|resolved-secret|rotated-secret/);
      expect(h.lines.at(-1)).toContain("[REDACTED]");
    } finally { await h.close(); }
  });
  it("retains original agent callbacks, omits protocol/hook payload and redacts bounded stderr", async () => {
    const h = await harness();
    try {
      const [issue] = await h.adapter.fetchIssuesByStates(["open"]); let reduced = 0;
      const options = h.observers.observeAttempt({ issue: issue!, attempt: null, workflow: h.effective.definition, workflowPath: h.workflowPath, getConfig: () => h.effective.serviceConfig, onEvent: () => { reduced++; } });
      options.onEvent!({ event: "session_started", timestamp: 1, codexAppServerPid: "1", threadId: "t", summary: "secret-token" });
      options.onEvent!({ event: "turn_completed", timestamp: 2, codexAppServerPid: "1", threadId: "t", turnId: "u", sessionId: "t-u", summary: "secret-token", rateLimits: { raw: "secret-token" } });
      options.onStderr!("prefix secret-token " + "😀".repeat(3000)); options.onStderr!('{"token":"secret-token"}');
      expect(reduced).toBe(2); expect(h.lines.at(-1)).toContain("diagnostic payload omitted");
      expect(h.lines.join()).not.toContain("secret-token"); expect(h.lines.at(-2)).toContain("[truncated]");
    } finally { await h.close(); }
  });
});
