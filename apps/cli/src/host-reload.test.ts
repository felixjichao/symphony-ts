import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Issue } from "@symphony/domain";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { createHost, type SymphonyHost } from "./host";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const appServerFixture = fileURLToPath(
  new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url),
);

function makeIssue(identifier: string, state = "open", overrides: Partial<Issue> = {}): Issue {
  return {
    id: `id-${identifier}`,
    nativeRef: null,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state,
    branchName: null,
    url: `https://example.com/${identifier}`,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Host live reload semantics (SPEC §6.2 / §13 / §18.1, AC #1 - #10, #14)", () => {
  it("AC #1 & #10: valid file reload updates effective config while host & running workers continue without restart", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-worker-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const startupRecord = path.join(temp, "child-startup.pid");

    const issues: Issue[] = [makeIssue("RUN-01", "open")];
    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --record-startup ${startupRecord} --delay-completed-ms 2000
---
Initial prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
      });

      await host.start();

      // Wait for child worker to start and write PID
      await waitFor(async () => {
        try {
          const content = await readFile(startupRecord, "utf8");
          return Boolean(content.trim());
        } catch {
          return false;
        }
      }, 5000);

      const childPid = (await readFile(startupRecord, "utf8")).trim();
      expect(Number(childPid)).toBeGreaterThan(0);

      expect(host.effective.serviceConfig.polling.intervalMs).toBe(10000);

      // Perform valid file reload: change interval
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 3000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --record-startup ${startupRecord} --delay-completed-ms 2000
---
Updated prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.polling.intervalMs === 3000, 4000);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(3000);

      // Verify running child process was NOT killed or restarted by reload (AC #10)
      let processStillAlive = false;
      try {
        process.kill(Number(childPid), 0);
        processStillAlive = true;
      } catch {
        processStillAlive = false;
      }
      expect(processStillAlive).toBe(true);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #2: poll interval reload respects existing delay and uses new interval on next tick", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-interval-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const scheduledDelays: number[] = [];
    const scheduledEntries: Array<{ id: number; delayMs: number; callback: () => void; cancelled: boolean }> = [];
    let nextTimerId = 1;
    const manualScheduler = {
      schedule: (delayMs: number, callback: () => void) => {
        scheduledDelays.push(delayMs);
        const entry = { id: nextTimerId++, delayMs, callback, cancelled: false };
        scheduledEntries.push(entry);
        return entry;
      },
      cancel: (entry: { cancelled: boolean }) => {
        entry.cancelled = true;
      },
    };

    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => [],
      }),
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 8000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        scheduler: manualScheduler,
        watcherIntervalMs: 50,
      });

      await host.start();

      // First tick was scheduled with delay 0 (immediate)
      expect(scheduledDelays[0]).toBe(0);
      expect(scheduledEntries).toHaveLength(1);

      // Trigger the first tick
      const firstTickCallback = scheduledEntries[0]!.callback;
      firstTickCallback();
      await host.loop.settled();

      // After first tick completes, reschedule() scheduled next tick with interval 8000
      expect(scheduledDelays).toHaveLength(2);
      expect(scheduledDelays[1]).toBe(8000);
      expect(scheduledEntries[1]!.cancelled).toBe(false);

      // Reload with new interval 2500
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 2500
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.polling.intervalMs === 2500, 3000);
      expect(host.state.pollIntervalMs).toBe(2500);

      // Verify the already scheduled 8000ms timer was NOT cancelled immediately upon reload
      expect(scheduledEntries[1]!.cancelled).toBe(false);
      // And no extra timer was created yet
      expect(scheduledDelays).toHaveLength(2);

      // Trigger the pending 8000ms tick
      const secondTickCallback = scheduledEntries[1]!.callback;
      secondTickCallback();
      await host.loop.settled();

      // Now the tick has executed, picked up the new interval, and rescheduled with 2500
      expect(scheduledDelays).toHaveLength(3);
      expect(scheduledDelays[2]).toBe(2500);
      expect(scheduledEntries[2]!.cancelled).toBe(false);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #3: concurrency reload: lowering blocks subsequent dispatch while old workers stay alive; raising resumes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-concurrency-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const issues: Issue[] = [
      makeIssue("ISSUE-01", "open"),
      makeIssue("ISSUE-02", "open"),
      makeIssue("ISSUE-03", "open"),
    ];

    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open", "review"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 100
agent:
  max_concurrent_agents: 2
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
      });

      await host.start();

      // Wait until 2 workers are running (global limit = 2)
      await waitFor(() => host.state.running.size === 2, 4000);
      expect(host.state.running.has("id-ISSUE-01")).toBe(true);
      expect(host.state.running.has("id-ISSUE-02")).toBe(true);
      expect(host.state.running.has("id-ISSUE-03")).toBe(false);

      // Lower concurrency to 1
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 100
agent:
  max_concurrent_agents: 1
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.agent.maxConcurrentAgents === 1, 3000);

      // Both already running workers remain running (not terminated)
      expect(host.state.running.size).toBe(2);

      // Now release worker 1
      await writeFile(path.join(temp, "workspaces", "ISSUE-01", "release.flag"), "ok\n");
      await waitFor(() => host.state.completed.has("id-ISSUE-01"), 4000);

      // Running workers now 1 (worker 2 is still running)
      expect(host.state.running.size).toBe(1);
      expect(host.state.running.has("id-ISSUE-02")).toBe(true);

      // Wait a moment across multiple poll ticks; observe that ISSUE-03 is STILL blocked from dispatching!
      await new Promise((r) => setTimeout(r, 300));
      expect(host.state.running.size).toBe(1);
      expect(host.state.running.has("id-ISSUE-03")).toBe(false);

      // Raise concurrency to 2
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 100
agent:
  max_concurrent_agents: 2
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.agent.maxConcurrentAgents === 2, 3000);

      // On next poll tick, ISSUE-03 is dispatched!
      await waitFor(() => host.state.running.has("id-ISSUE-03"), 4000);
      expect(host.state.running.size).toBe(2);
      expect(host.state.running.has("id-ISSUE-02")).toBe(true);
      expect(host.state.running.has("id-ISSUE-03")).toBe(true);

      // Now test per-state limit reload: add 2 issues in state 'review'
      const review1 = makeIssue("REV-01", "review");
      const review2 = makeIssue("REV-02", "review");
      issues.push(review1, review2);

      // Reload config with global = 5, but per-state review = 1
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 100
agent:
  max_concurrent_agents: 5
  max_concurrent_agents_by_state:
    review: 1
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt
`,
        "utf8",
      );

      await waitFor(
        () => host.effective.serviceConfig.agent.maxConcurrentAgentsByState["review"] === 1,
        3000,
      );

      // Release worker 2 and 3 so global slots open up
      await writeFile(path.join(temp, "workspaces", "ISSUE-02", "release.flag"), "ok\n");
      await writeFile(path.join(temp, "workspaces", "ISSUE-03", "release.flag"), "ok\n");
      await waitFor(() => host.state.completed.has("id-ISSUE-02"), 4000);
      await waitFor(() => host.state.completed.has("id-ISSUE-03"), 4000);

      // REV-01 gets dispatched, but REV-02 is blocked by per-state limit (1)
      await waitFor(() => host.state.running.has("id-REV-01"), 4000);
      await new Promise((r) => setTimeout(r, 300));
      expect(host.state.running.has("id-REV-02")).toBe(false);

      // Reload per-state review limit to 2
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 100
agent:
  max_concurrent_agents: 5
  max_concurrent_agents_by_state:
    review: 2
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt
`,
        "utf8",
      );

      await waitFor(
        () => host.effective.serviceConfig.agent.maxConcurrentAgentsByState["review"] === 2,
        3000,
      );

      // On next tick, REV-02 is dispatched!
      await waitFor(() => host.state.running.has("id-REV-02"), 4000);

      // Clean up running workers
      await waitFor(async () => await pathExists(path.join(temp, "workspaces", "REV-01")), 4000);
      await waitFor(async () => await pathExists(path.join(temp, "workspaces", "REV-02")), 4000);
      await writeFile(path.join(temp, "workspaces", "REV-01", "release.flag"), "ok\n");
      await writeFile(path.join(temp, "workspaces", "REV-02", "release.flag"), "ok\n");
      await waitFor(() => host.state.completed.has("id-REV-01"), 4000);
      await waitFor(() => host.state.completed.has("id-REV-02"), 4000);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #4: retry cap and stall reload: dynamic getters update immediately without restarting host and drive runtime reconciliation and retry", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-cap-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const issues: Issue[] = [
      makeIssue("STALL-01", "open"),
      makeIssue("FAIL-01", "open"),
      makeIssue("FAIL-02", "open"),
    ];

    interface TrackedTimer {
      id: number;
      delayMs: number;
      timer: ReturnType<typeof setTimeout>;
      cancelled: boolean;
    }
    const trackedTimers: TrackedTimer[] = [];
    let nextTimerId = 1;
    const retryScheduler = {
      schedule: (delayMs: number, callback: () => void) => {
        const handle: TrackedTimer = {
          id: nextTimerId++,
          delayMs,
          timer: setTimeout(callback, delayMs),
          cancelled: false,
        };
        trackedTimers.push(handle);
        return handle;
      },
      cancel: (handle: unknown) => {
        if (handle !== null && typeof handle === "object" && "timer" in handle) {
          const t = handle as TrackedTimer;
          t.cancelled = true;
          clearTimeout(t.timer);
        }
      },
    };

    let simulatedNow = Date.now();
    let simulatedMonotonic = 10000;
    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    let host: SymphonyHost | null = null;

    try {
      // 1. Test stall_timeout dynamic getter driving reconciliation
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 60000
codex:
  stall_timeout_ms: 60000
  command: node ${appServerFixture} --silent-turn
workspace:
  root: ${path.join(temp, "workspaces")}
---
Prompt
`,
        "utf8",
      );

      host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        retryScheduler,
        now: () => simulatedNow,
        monotonicNow: () => simulatedMonotonic,
        watcherIntervalMs: 50,
        scheduler: { schedule: () => ({}), cancel: () => {} },
      });
      await host.start();

      // Dispatch STALL-01
      host.authority.dispatchIssue(issues[0]!);

      // Wait until STALL-01 has established a real live session with lastCodexTimestamp
      await waitFor(
        () => Boolean(host!.state.running.get("id-STALL-01")?.session?.lastCodexTimestamp),
        5000,
      );

      // Align simulated UTC time with the real session's last activity timestamp + 5000ms
      const stallTimestamp = host.state.running.get("id-STALL-01")!.session!.lastCodexTimestamp!;
      simulatedNow = stallTimestamp + 5000;
      simulatedMonotonic += 5000;

      // Reconcile: worker is NOT stalled because 5000ms < 60000ms
      const reconcile1 = await host.authority.reconcileRunningIssues();
      expect(reconcile1.stoppedIssueIds).toEqual([]);
      expect(reconcile1.stalledIssueIds).toEqual([]);
      expect(host.state.running.has("id-STALL-01")).toBe(true);

      // Reload stall_timeout_ms to 2000ms (2 seconds)
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 60000
codex:
  stall_timeout_ms: 2000
  command: node ${appServerFixture} --silent-turn
workspace:
  root: ${path.join(temp, "workspaces")}
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host!.effective.serviceConfig.codex.stallTimeoutMs === 2000, 3000);

      // Reconcile again: dynamic getter returns 2000ms, and 5000ms > 2000ms -> stalled!
      const reconcile2 = await host.authority.reconcileRunningIssues();
      expect(reconcile2.stalledIssueIds).toEqual(["id-STALL-01"]);

      // Wait for STALL-01 attempt completion and retry queue registration
      await waitFor(() => host!.state.retryAttempts.has("id-STALL-01"), 5000);
      expect(host.state.running.has("id-STALL-01")).toBe(false);

      const stallRetry = host.state.retryAttempts.get("id-STALL-01")!;
      expect(stallRetry.attempt).toBe(1);
      expect(stallRetry.error).toContain("stall");
      const stallTimerHandle = stallRetry.timerHandle as TrackedTimer;
      // STALL-01 retry backoff: failureRetryDelayMs(1, 60000) = 10000ms
      expect(stallTimerHandle.delayMs).toBe(10000);
      expect(stallTimerHandle.cancelled).toBe(false);

      // 2. Test max_retry_backoff_ms dynamic getter driving retry queue backoff capping
      // Reload codex command to exit-on-turn-start and set max_retry_backoff_ms to 120000
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 120000
codex:
  stall_timeout_ms: 60000
  command: node ${appServerFixture} --exit-on-turn-start
workspace:
  root: ${path.join(temp, "workspaces")}
---
Prompt
`,
        "utf8",
      );
      await waitFor(
        () =>
          host!.effective.serviceConfig.agent.maxRetryBackoffMs === 120000 &&
          Boolean(host!.effective.serviceConfig.codex.command?.includes("--exit-on-turn-start")),
        3000,
      );

      // Dispatch FAIL-01: fails attempt 1 because --exit-on-turn-start exits immediately
      host.authority.dispatchIssue(issues[1]!);
      await waitFor(() => host!.state.retryAttempts.has("id-FAIL-01"), 6000);

      const fail1Retry = host.state.retryAttempts.get("id-FAIL-01")!;
      expect(fail1Retry.attempt).toBe(1);
      const fail1TimerHandle = fail1Retry.timerHandle as TrackedTimer;
      // Attempt 1 retry backoff is uncapped: min(10000, 120000) = 10000ms
      expect(fail1TimerHandle.delayMs).toBe(10000);
      expect(fail1TimerHandle.cancelled).toBe(false);

      // Verify STALL-01's existing timer was preserved and not cancelled
      expect(host.state.retryAttempts.get("id-STALL-01")?.timerHandle).toBe(stallTimerHandle);
      expect(stallTimerHandle.cancelled).toBe(false);
      expect(stallTimerHandle.delayMs).toBe(10000);

      // Now reload max_retry_backoff_ms to 1500ms
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 1500
codex:
  stall_timeout_ms: 60000
  command: node ${appServerFixture} --exit-on-turn-start
workspace:
  root: ${path.join(temp, "workspaces")}
---
Prompt
`,
        "utf8",
      );
      await waitFor(() => host!.effective.serviceConfig.agent.maxRetryBackoffMs === 1500, 3000);

      // Dispatch FAIL-02: fails attempt 1
      host.authority.dispatchIssue(issues[2]!);
      await waitFor(() => host!.state.retryAttempts.has("id-FAIL-02"), 6000);

      const fail2Retry = host.state.retryAttempts.get("id-FAIL-02")!;
      expect(fail2Retry.attempt).toBe(1);
      const fail2TimerHandle = fail2Retry.timerHandle as TrackedTimer;
      // Attempt 1 retry backoff is capped: min(10000, 1500) = 1500ms!
      expect(fail2TimerHandle.delayMs).toBe(1500);
      expect(fail2TimerHandle.cancelled).toBe(false);

      // Verify BOTH previous retry timers (STALL-01 and FAIL-01) remain preserved with their original 10000ms delay
      expect(host.state.retryAttempts.get("id-STALL-01")?.timerHandle).toBe(stallTimerHandle);
      expect(stallTimerHandle.cancelled).toBe(false);
      expect(stallTimerHandle.delayMs).toBe(10000);

      expect(host.state.retryAttempts.get("id-FAIL-01")?.timerHandle).toBe(fail1TimerHandle);
      expect(fail1TimerHandle.cancelled).toBe(false);
      expect(fail1TimerHandle.delayMs).toBe(10000);
    } finally {
      if (host !== null) {
        await host.stop();
      }
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #5: next child worker receives updated prompt, codex command, and options after reload", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-child-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const promptRecordA = path.join(temp, "prompt-a.txt");
    const promptRecordB = path.join(temp, "prompt-b.txt");
    const worldRecordA = path.join(temp, "world-a.json");
    const worldRecordB = path.join(temp, "world-b.json");

    const issues: Issue[] = [
      makeIssue("CHILD-01", "open"),
    ];

    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    try {
      // 1. Initial workflow with Prompt A and command with Record A
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --record-prompt ${promptRecordA} --record-world ${worldRecordA}
---
Prompt Content Version 1: Initial Instructions
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
      });

      await host.start();

      // Child 1 starts and completes
      await waitFor(() => host.state.completed.has("id-CHILD-01"), 6000);

      const promptA = await readFile(promptRecordA, "utf8");
      expect(promptA).toContain("Prompt Content Version 1: Initial Instructions");
      const worldA = JSON.parse(await readFile(worldRecordA, "utf8"));
      expect(worldA.argv).toContain(promptRecordA);

      // 2. Reload workflow with Prompt B and command with Record B
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --record-prompt ${promptRecordB} --record-world ${worldRecordB}
---
Prompt Content Version 2: Updated Instructions
`,
        "utf8",
      );

      await waitFor(
        () => host.effective.serviceConfig.codex.command.includes(promptRecordB),
        3000,
      );

      // Dispatch Child 2 under updated workflow B
      const child2 = makeIssue("CHILD-02", "open");
      issues.push(child2);
      host.authority.dispatchIssue(child2);
      await waitFor(() => host.state.completed.has("id-CHILD-02"), 6000);

      const promptB = await readFile(promptRecordB, "utf8");
      expect(promptB).toContain("Prompt Content Version 2: Updated Instructions");
      const worldB = JSON.parse(await readFile(worldRecordB, "utf8"));
      expect(worldB.argv).toContain(promptRecordB);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #6: tracker provider config reload immediately routes next calls to new adapter and returns its issues", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-tracker-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const adapterInstances: string[] = [];
    const profile: TrackerAdapterProfile = {
      kind: "dyn_tracker",
      documentation: "docs/testing.md#dyn",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: (ctx) => {
        const endpoint = (ctx.provider["endpoint"] as string) ?? "default";
        const instanceId = `adapter-${endpoint}`;
        adapterInstances.push(instanceId);
        return {
          kind: "dyn_tracker",
          fetchIssuesByIds: async (_ids) => [makeIssue(`ID-${endpoint}`)],
          fetchIssuesByStates: async (_states) => [makeIssue(`ISSUE-FROM-${endpoint}`)],
        };
      },
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: dyn_tracker
  provider:
    endpoint: v1
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
        scheduler: { schedule: () => ({}), cancel: () => {} },
      });
      await host.start();

      expect(adapterInstances).toEqual(["adapter-v1", "adapter-v1"]);

      // Call tracker proxy: routes to adapter v1
      const issuesV1 = await host.tracker.fetchIssuesByStates(["open"]);
      expect(issuesV1.map((i) => i.identifier)).toEqual(["ISSUE-FROM-v1"]);
      const byIdV1 = await host.tracker.fetchIssuesByIds(["id-v1"]);
      expect(byIdV1.map((i) => i.identifier)).toEqual(["ID-v1"]);

      // Update provider config to endpoint v2
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: dyn_tracker
  provider:
    endpoint: v2
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.tracker.provider["endpoint"] === "v2", 3000);
      expect(adapterInstances).toContain("adapter-v2");

      // Verify that next tracker calls immediately route to adapter v2
      const issuesV2 = await host.tracker.fetchIssuesByStates(["open"]);
      expect(issuesV2.map((i) => i.identifier)).toEqual(["ISSUE-FROM-v2"]);
      const byIdV2 = await host.tracker.fetchIssuesByIds(["id-v2"]);
      expect(byIdV2.map((i) => i.identifier)).toEqual(["ID-v2"]);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #7 & #8: invalid reload (YAML error / failed adapter construction) preserves entire previous runtime", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-fail-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    let shouldFailConstruction = false;
    const profile: TrackerAdapterProfile = {
      kind: "flaky_tracker",
      documentation: "docs/testing.md#flaky",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => {
        if (shouldFailConstruction) {
          throw new Error("Simulated adapter construction error");
        }
        return {
          kind: "flaky_tracker",
          fetchIssuesByIds: async () => [],
          fetchIssuesByStates: async () => [],
        };
      },
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: flaky_tracker
polling:
  interval_ms: 5000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Good prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
        scheduler: { schedule: () => ({}), cancel: () => {} },
      });
      await host.start();

      const initialEffective = host.effective;
      expect(initialEffective.serviceConfig.polling.intervalMs).toBe(5000);

      // 1. Invalid YAML
      await writeFile(workflowPath, `--- invalid yaml ::: ---`, "utf8");
      await new Promise((r) => setTimeout(r, 200));

      expect(host.effective).toBe(initialEffective);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(5000);

      // 2. Failed adapter construction (AC #8)
      shouldFailConstruction = true;
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: flaky_tracker
polling:
  interval_ms: 2000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Next prompt
`,
        "utf8",
      );
      await new Promise((r) => setTimeout(r, 200));

      expect(host.effective).toBe(initialEffective);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(5000);

      // 3. Self-heal with valid config
      shouldFailConstruction = false;
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: flaky_tracker
polling:
  interval_ms: 1500
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Healed prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.polling.intervalMs === 1500, 3000);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(1500);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #9: workspace root reload consistency (in-flight Attempt A in Root A, reload to Root B, Attempt B in Root B, after_run and terminal cleanup removes Root A while Root B remains intact)", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-root-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const rootA = path.join(temp, "root-A");
    const rootB = path.join(temp, "root-B");
    const hookLog = path.join(temp, "hook.log");

    const issues: Issue[] = [
      makeIssue("TASK-COMMON", "open"),
    ];

    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    let host: Awaited<ReturnType<typeof createHost>> | null = null;
    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
hooks:
  after_run: node -e 'require("node:fs").appendFileSync(process.env.TEST_HOOK_LOG, "after_run:" + process.cwd() + "\\n")'
workspace:
  root: ${rootA}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt A
`,
        "utf8",
      );

      host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
      });

        process.env.TEST_HOOK_LOG = hookLog;

        await host.start();

        // Wait until TASK-COMMON starts running in Root A
        await waitFor(() => host!.state.running.has("id-TASK-COMMON"), 4000);
        const expectedPathA = path.join(rootA, "TASK-COMMON");
        expect(await pathExists(expectedPathA)).toBe(true);

        // While Attempt A is still in-flight, reload workspace root to Root B
        await writeFile(
          workflowPath,
          `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
hooks:
  after_run: node -e 'require("node:fs").appendFileSync(process.env.TEST_HOOK_LOG, "after_run:" + process.cwd() + "\\n")'
workspace:
  root: ${rootB}
codex:
  command: node ${appServerFixture} --wait-file ./release.flag --delay-completed-ms 20
---
Prompt B
`,
          "utf8",
        );

        await waitFor(() => host!.effective.serviceConfig.workspace.root === rootB, 3000);
        expect(host!.effective.serviceConfig.workspace.root).toBe(rootB);

        // Dispatch TASK-B in Root B
        const issueB = makeIssue("TASK-B", "open");
        issues.push(issueB);
        host!.authority.dispatchIssue(issueB);

        await waitFor(() => host!.state.running.has("id-TASK-B"), 4000);
        const expectedPathB = path.join(rootB, "TASK-B");
        await waitFor(async () => await pathExists(expectedPathB), 4000);
        expect(await pathExists(expectedPathB)).toBe(true);

        // Pre-create a same-named directory and marker file in Root B to prove it is not deleted when Root A's TASK-COMMON is cleaned up
        const sameNamedInB = path.join(rootB, "TASK-COMMON");
        await mkdir(sameNamedInB, { recursive: true });
        await writeFile(path.join(sameNamedInB, "marker.txt"), "root-b-marker", "utf8");

        // Both workspaces exist simultaneously
        expect(await pathExists(expectedPathA)).toBe(true);
        expect(await pathExists(expectedPathB)).toBe(true);
        expect(await pathExists(sameNamedInB)).toBe(true);

        // Now mark TASK-COMMON as terminal (closed) in tracker while worker A is still running
        issues[0] = makeIssue("TASK-COMMON", "closed");

        // Trigger reconciliation: M5 reconciliation sees TASK-COMMON is running and now closed -> stop worker -> after_run hook -> terminal cleanup
        const reconcileA = await host!.authority.reconcileRunningIssues();
        expect(reconcileA.stoppedIssueIds).toEqual(["id-TASK-COMMON"]);
        expect(reconcileA.cleanedIssueIds).toEqual(["id-TASK-COMMON"]);

        // Verify Root A directory was removed by terminal cleanup
        await waitFor(async () => !(await pathExists(expectedPathA)), 4000);
        expect(await pathExists(expectedPathA)).toBe(false);

        // Verify Root B same-named directory (and its marker file) and TASK-B workspace are COMPLETELY INTACT and unaffected!
        expect(await pathExists(sameNamedInB)).toBe(true);
        expect(await readFile(path.join(sameNamedInB, "marker.txt"), "utf8")).toBe("root-b-marker");
        expect(await pathExists(expectedPathB)).toBe(true);

        // Verify after_run hook was executed for Root A workspace
        const hookContent = await readFile(hookLog, "utf8");
        expect(hookContent).toContain(`after_run:${expectedPathA}`);

        // Now mark TASK-B as terminal (closed) in tracker while worker B is still running
        issues[1] = makeIssue("TASK-B", "closed");
        const reconcileB = await host!.authority.reconcileRunningIssues();
        expect(reconcileB.stoppedIssueIds).toEqual(["id-TASK-B"]);
        expect(reconcileB.cleanedIssueIds).toEqual(["id-TASK-B"]);
        await waitFor(async () => !(await pathExists(expectedPathB)), 4000);
        expect(await pathExists(expectedPathB)).toBe(false);
      } finally {
        delete process.env.TEST_HOOK_LOG;
        if (host) {
          await host.stop();
        }
        await rm(temp, { recursive: true, force: true });
      }
  });

  it("AC #14: watcher and host.effective share the exact same object reference; no dual truth sources", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-single-source-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const profile: TrackerAdapterProfile = {
      kind: "fixture",
      documentation: "docs/testing.md#fixture",
      secretProviderKeys: [],
      secretEnvVars: [],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "fixture",
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => [],
      }),
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 7000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt v1
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
        scheduler: { schedule: () => ({}), cancel: () => {} },
      });
      await host.start();

      const v1 = host.effective;
      expect(v1.serviceConfig.polling.intervalMs).toBe(7000);

      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 3500
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt v2
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.polling.intervalMs === 3500, 3000);
      const v2 = host.effective;

      expect(v2).not.toBe(v1);
      expect(v2.serviceConfig.polling.intervalMs).toBe(3500);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
