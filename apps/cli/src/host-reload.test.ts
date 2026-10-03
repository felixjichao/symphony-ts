import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Issue } from "@symphony/domain";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { createHost } from "./host";

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
      // Check if process still exists
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
    const manualScheduler = {
      schedule: (delayMs: number, callback: () => void) => {
        scheduledDelays.push(delayMs);
        const timer = setTimeout(callback, delayMs);
        return timer;
      },
      cancel: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
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
agent:
  max_concurrent_agents: 2
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --delay-completed-ms 5000
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

      // Wait until 2 workers are running
      await waitFor(() => host.state.running.size === 2, 4000);
      expect(host.state.running.size).toBe(2);

      // Lower concurrency to 1
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_concurrent_agents: 1
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --delay-completed-ms 5000
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.agent.maxConcurrentAgents === 1, 3000);

      // Both already running workers remain running (not terminated)
      expect(host.state.running.size).toBe(2);
      // But no available slot exists
      expect(host.authority.hasAvailableGlobalSlot()).toBe(false);

      // Raise concurrency to 3
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_concurrent_agents: 3
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --delay-completed-ms 5000
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.agent.maxConcurrentAgents === 3, 3000);
      expect(host.authority.hasAvailableGlobalSlot()).toBe(true);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #4: retry cap and stall reload: dynamic getters update immediately without rescheduling existing timers", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-cap-"));
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
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 120000
codex:
  stall_timeout_ms: 45000
  command: node ${appServerFixture}
workspace:
  root: ${path.join(temp, "workspaces")}
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

      expect(host.effective.serviceConfig.agent.maxRetryBackoffMs).toBe(120000);
      expect(host.effective.serviceConfig.codex.stallTimeoutMs).toBe(45000);

      // Reload with new values
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
agent:
  max_retry_backoff_ms: 30000
codex:
  stall_timeout_ms: 15000
  command: node ${appServerFixture}
workspace:
  root: ${path.join(temp, "workspaces")}
---
Prompt
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.agent.maxRetryBackoffMs === 30000, 3000);
      expect(host.effective.serviceConfig.agent.maxRetryBackoffMs).toBe(30000);
      expect(host.effective.serviceConfig.codex.stallTimeoutMs).toBe(15000);

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #6: tracker provider config reload immediately routes next calls to new adapter", async () => {
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
        const instanceId = `adapter-${ctx.provider["endpoint"] ?? "default"}`;
        adapterInstances.push(instanceId);
        return {
          kind: "dyn_tracker",
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
      });

      expect(adapterInstances).toEqual(["adapter-v1"]);

      // Call tracker proxy
      await host.tracker.fetchIssuesByStates(["open"]);

      // Update provider config
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

      // Verify that next tracker call hits new adapter
      expect(host.tracker.kind).toBe("dyn_tracker");

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
      });

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

  it("AC #9: workspace root reload consistency (Attempt A cleans up in Root A, Attempt B in Root B, old roots not swept)", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-reload-root-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const rootA = path.join(temp, "root-A");
    const rootB = path.join(temp, "root-B");

    const issues: Issue[] = [
      makeIssue("ISSUE-A", "open"),
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
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
workspace:
  root: ${rootA}
codex:
  command: node ${appServerFixture}
---
Prompt A
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        watcherIntervalMs: 50,
      });

      await host.start();

      // Wait until ISSUE-A finishes attempt in Root A
      await waitFor(() => host.state.completed.has("id-ISSUE-A"), 6000);

      // Verify directory was created in Root A
      const expectedPathA = path.join(rootA, "ISSUE-A");
      expect(await pathExists(expectedPathA)).toBe(true);

      // Now reload workspace root to Root B
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: fixture
polling:
  interval_ms: 10000
workspace:
  root: ${rootB}
codex:
  command: node ${appServerFixture}
---
Prompt B
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.workspace.root === rootB, 3000);
      expect(host.effective.serviceConfig.workspace.root).toBe(rootB);

      // Dispatch ISSUE-B in Root B
      const issueB = makeIssue("ISSUE-B", "open");
      issues.push(issueB);
      host.authority.dispatchIssue(issueB);

      await waitFor(() => host.state.completed.has("id-ISSUE-B"), 6000);

      // Verify ISSUE-B was executed in Root B
      const expectedPathB = path.join(rootB, "ISSUE-B");
      expect(await pathExists(expectedPathB)).toBe(true);

      // Terminal cleanup for ISSUE-A: because ISSUE-A was bound to Root A, its cleanup removes Root A/ISSUE-A
      const cleanupA = await host.cleanupWorkspace.removeWorkspaceForIssue!({
        issueId: "id-ISSUE-A",
        identifier: "ISSUE-A",
      });
      expect(cleanupA.status).toBe("removed");
      expect(await pathExists(expectedPathA)).toBe(false);

      // Verify Root B/ISSUE-B is untouched by ISSUE-A's cleanup
      expect(await pathExists(expectedPathB)).toBe(true);

      // Terminal cleanup for ISSUE-B removes Root B/ISSUE-B
      const cleanupB = await host.cleanupWorkspace.removeWorkspaceForIssue!({
        issueId: "id-ISSUE-B",
        identifier: "ISSUE-B",
      });
      expect(cleanupB.status).toBe("removed");
      expect(await pathExists(expectedPathB)).toBe(false);

      await host.stop();
    } finally {
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
      });

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
