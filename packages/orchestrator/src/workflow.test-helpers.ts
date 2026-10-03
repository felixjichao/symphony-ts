/** M5 Core Conformance assembly: public packages, local tracker, real fs/processes. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentAttempt, type AgentAttemptResult, type AgentEvent } from "@symphony/agent";
import { loadEffectiveWorkflow, type EffectiveWorkflow } from "@symphony/config";
import type { Issue } from "@symphony/domain";
import { createTrackerAdapterRegistry, type TrackerAdapter } from "@symphony/tracker";
import { createWorkspaceManager } from "@symphony/workspace";
import {
  OrchestratorAuthority, OrchestratorLoop, createOrchestratorRuntimeState,
  type DispatchPolicy, type DispatchPreflightResult, type LoopDiagnostic,
} from "./index";
import { FakeTracker, ManualScheduler } from "./loop.test-helpers";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("world observation timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export interface WorkflowSettings {
  args?: readonly string[];
  interval?: number;
  concurrency?: number;
  maxTurns?: number;
  perState?: Readonly<Record<string, number>>;
  cap?: number;
  stall?: number;
  active?: readonly string[];
  terminal?: readonly string[];
  labels?: readonly string[];
  prompt?: string;
}

export async function createWorkflowHarness(settings: WorkflowSettings = {}) {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "symphony-m56-"));
  const workflowPath = path.join(temp, "WORKFLOW.md");
  const root = path.join(temp, "workspaces");
  const fixture = fileURLToPath(new URL("../../agent/test-fixtures/app-server.mjs", import.meta.url));
  const tracker = new FakeTracker();
  const profile = {
    kind: "fixture", documentation: "docs/testing.md#fixture-tracker",
    secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ["Todo", "In Progress"], defaultTerminalStates: ["Done"],
    createAdapter: () => ({ kind: "fixture",
      fetchIssuesByIds: (ids: readonly string[]) => tracker.fetchIssuesByIds(ids),
      fetchIssuesByStates: (states: readonly string[]) => tracker.fetchIssuesByStates(states),
    }),
  };
  const registry = createTrackerAdapterRegistry([profile]);
  let effective: EffectiveWorkflow;
  let adapter: TrackerAdapter;
  let currentSettings = settings;
  const writeWorkflow = (next: WorkflowSettings = currentSettings) => {
    currentSettings = next;
    const command = [process.execPath, fixture, "--record-world", "world.json",
      "--record-transcript", "transcript.ndjson", ...(next.args ?? [])]
      .map(shellQuote).join(" ") + ' --cwd "$(pwd)"';
    writeFileSync(workflowPath, `---\n${JSON.stringify({
      tracker: { kind: "fixture", required_labels: next.labels ?? ["AGENT"],
        ...(next.active ? { active_states: next.active } : {}),
        ...(next.terminal ? { terminal_states: next.terminal } : {}) },
      workspace: { root }, polling: { interval_ms: next.interval ?? 30000 },
      agent: { max_turns: next.maxTurns ?? 1, max_concurrent_agents: next.concurrency ?? 3,
        max_retry_backoff_ms: next.cap ?? 300000, max_concurrent_agents_by_state: next.perState ?? {} },
      codex: { command, read_timeout_ms: 5000, turn_timeout_ms: 30000, stall_timeout_ms: next.stall ?? 0 },
      hooks: { after_run: "echo after >> lifecycle.txt", before_remove: "test -f lifecycle.txt && echo remove >> lifecycle.txt", timeout_ms: 5000 },
    })}\n---\n${next.prompt ?? "Handle {{ issue.identifier }} attempt={{ attempt }}"}\n`, "utf8");
  };
  writeWorkflow();
  const preflight = (): DispatchPreflightResult => {
    try {
      const next = loadEffectiveWorkflow({ path: workflowPath, trackerExtension: registry.createConfigExtension() });
      if (!next.serviceConfig.codex.command.trim()) throw new Error("codex.command is empty");
      const nextAdapter = registry.create(next.serviceConfig.tracker);
      const config = next.serviceConfig;
      const policy: DispatchPolicy = {
        activeStates: config.tracker.activeStates ?? profile.defaultActiveStates,
        terminalStates: config.tracker.terminalStates ?? profile.defaultTerminalStates,
        requiredLabels: config.tracker.requiredLabels,
        maxConcurrentAgentsByState: config.agent.maxConcurrentAgentsByState,
      };
      // Commit all readers together only after successful file/adapter validation.
      effective = next;
      adapter = nextAdapter;
      return { ok: true, effective: { pollIntervalMs: config.polling.intervalMs,
        maxConcurrentAgents: config.agent.maxConcurrentAgents, policy } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const initial = preflight();
  if (!initial.ok) { await fs.rm(temp, { recursive: true, force: true }); throw new Error(initial.error); }
  const manager = createWorkspaceManager({ workspace: { root } });
  const state = createOrchestratorRuntimeState(initial.effective);
  const poll = new ManualScheduler();
  const retry = new ManualScheduler();
  const results: AgentAttemptResult[] = [];
  const starts: { issue: Issue; attempt: number | null }[] = [];
  const events: AgentEvent[] = [];
  const diagnostics: LoopDiagnostic[] = [];
  const clocks = { utc: Date.now(), monotonic: 5000 };
  const cleanupObservations: { identifier: string; alive: boolean; lifecycle: string }[] = [];
  const cleanupGate: { beforeRemove: (() => Promise<void>) | null } = { beforeRemove: null };
  const cleanup = {
    removeWorkspace: async (identifier: string) => {
      const workspacePath = manager.resolveWorkspacePath(identifier);
      if (existsSync(path.join(workspacePath, "world.json"))) {
        const world = JSON.parse(readFileSync(path.join(workspacePath, "world.json"), "utf8")) as { pid: number };
        cleanupObservations.push({ identifier, alive: processAlive(world.pid),
          lifecycle: readFileSync(path.join(workspacePath, "lifecycle.txt"), "utf8") });
      }
      await cleanupGate.beforeRemove?.();
      return manager.removeWorkspace(identifier, { hooks: effective.serviceConfig.hooks });
    },
  };
  const reads = {
    fetchIssuesByIds: (ids: readonly string[]) => adapter.fetchIssuesByIds(ids),
    fetchIssuesByStates: (states: readonly string[]) => adapter.fetchIssuesByStates(states),
  };
  const authority = new OrchestratorAuthority({
    state, policy: initial.effective.policy, tracker: reads,
    runner: async (options) => { const result = await runAgentAttempt(options); results.push(result); return result; },
    createAttemptOptions: (context) => {
      starts.push({ issue: context.issue, attempt: context.attempt });
      return { ...context, workflow: effective.definition, workflowPath,
        getConfig: () => effective.serviceConfig,
        onEvent: (event) => { events.push(event); context.onEvent(event); } };
    },
    resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
    now: () => clocks.utc, monotonicNow: () => clocks.monotonic,
    stallTimeoutMs: () => effective.serviceConfig.codex.stallTimeoutMs,
    cleanupWorkspace: cleanup,
    retry: { scheduler: retry, maxRetryBackoffMs: () => effective.serviceConfig.agent.maxRetryBackoffMs, cleanupWorkspace: cleanup },
  });
  const loop = new OrchestratorLoop({ authority, candidates: reads, preflight: { preflight }, scheduler: poll,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  return {
    temp, workflowPath, root, tracker, manager, state, poll, retry, authority, loop,
    results, starts, events, diagnostics, clocks, cleanupObservations, cleanupGate, writeWorkflow,
    effective: () => effective,
    async tick() { poll.fire(); await loop.settled(); },
    async retryAndIdle(count: number) {
      retry.fire(); await waitFor(() => starts.length === count); await authority.waitForIdle();
    },
    world(issue: Issue): { pid: number; cwd: string; argv: string[] } {
      return JSON.parse(readFileSync(path.join(manager.resolveWorkspacePath(issue.identifier), "world.json"), "utf8")) as { pid: number; cwd: string; argv: string[] };
    },
    async dispose() { await loop.stop(); await fs.rm(temp, { recursive: true, force: true }); },
  };
}
