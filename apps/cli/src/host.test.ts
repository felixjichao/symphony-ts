import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Issue, TimerHandle } from "@symphony/domain";
import type { RetryScheduler } from "@symphony/orchestrator";
import { SymphonyConfigError } from "@symphony/config";
import { createStructuredLogger } from "@symphony/observability";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { fileURLToPath } from "node:url";
import { createHost } from "./host";

const appServerFixture = fileURLToPath(new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url));

function createMemoryLogger(lines: string[]) {
  return createStructuredLogger({
    sinks: [{ write(line) { lines.push(line); } }],
  });
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}


function fixtureProfile(calls: string[] = [], issues: Issue[] = []): TrackerAdapterProfile {
  return {
    kind: "fixture",
    documentation: "docs/testing.md#fixture-tracker",
    secretProviderKeys: ["token"],
    secretEnvVars: ["FIXTURE_TOKEN"],
    defaultActiveStates: ["open"],
    defaultTerminalStates: ["closed"],
    createAdapter: () => ({
      kind: "fixture",
      fetchIssuesByIds: async (ids) => {
        calls.push(`fetch_by_ids:${ids.join(",")}`);
        return issues.filter((i) => ids.includes(i.id));
      },
      fetchIssuesByStates: async (states) => {
        calls.push(`fetch_by_states:${states.join(",")}`);
        return issues.filter((i) => states.includes(i.state));
      },
    }),
  };
}


describe("createHost in-process composition", () => {
  it("fails fast on missing workflow file without process.exit and logs config_validation", async () => {
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);
    const nonExistent = path.join(os.tmpdir(), "symphony-non-existent-WORKFLOW.md");

    await expect(createHost({ workflowPath: nonExistent, logger })).rejects.toThrowError(SymphonyConfigError);
    expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("missing_workflow_file"))).toBe(true);
  });

  it("fails fast on unsupported tracker kind and logs config failure", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: unknown_provider\nworkspace:\n  root: ${temp}\ncodex:\n  command: "echo test"\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrow();
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("unsupported_tracker_kind"))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails fast on invalid config syntax/schema and logs config failure", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\n[invalid-yaml\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrow();
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails fast when codex.command is empty", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\ncodex:\n  command: "   "\n---\nPrompt\n`);
      await expect(createHost({
        workflowPath,
        logger,
        trackerProfiles: [fixtureProfile()],
      })).rejects.toThrow("codex.command is empty");
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("starts and stops real loop gracefully with custom tracker and scheduler", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);
    const calls: string[] = [];

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: fixture\n  provider:\n    token: "my-secret-token"\nworkspace:\n  root: ${temp}\npolling:\n  interval_ms: 1000\ncodex:\n  command: "echo test"\n---\nPrompt {{ issue.identifier }}\n`);

      const host = await createHost({
        workflowPath,
        logger,
        trackerProfiles: [fixtureProfile(calls)],
      });

      expect(host.workflowPath).toBe(workflowPath);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(1000);
      expect(host.state.running.size).toBe(0);

      await host.start();
      expect(lines.some((l) => l.includes('event="startup" outcome="started"'))).toBe(true);
      expect(lines.some((l) => l.includes('event="startup" outcome="completed"'))).toBe(true);

      // Verify secret token was redacted
      expect(lines.join("\n")).not.toContain("my-secret-token");

      await host.stop();
      expect(lines.some((l) => l.includes('event="shutdown" outcome="started"'))).toBe(true);
      expect(lines.some((l) => l.includes('event="shutdown" outcome="completed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("assembles built-in github profile by default and validates tracker config", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      // Invalid repo format for github provider
      await writeFile(workflowPath, `---\ntracker:\n  kind: github\n  provider:\n    repo: "invalid-repo"\n    token: "gh-secret"\nworkspace:\n  root: ${temp}\ncodex:\n  command: "echo test"\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrowError(SymphonyConfigError);
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("invalid_tracker_config"))).toBe(true);
      expect(lines.join("\n")).not.toContain("gh-secret");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("exposes shared clock, getSnapshot, and tryGetSnapshot reflecting runtime state", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-snap-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\npolling:\n  interval_ms: 1234\nagent:\n  max_concurrent_agents: 5\ncodex:\n  command: "echo test"\n---\nPrompt\n`,
      );
      const wall = 1000;
      const mono = 2000;
      const host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile()],
        now: () => wall,
        monotonicNow: () => mono,
      });

      expect(host.clock.wallNow()).toBe(1000);
      expect(host.clock.monotonicNow()).toBe(2000);

      const snapshot = host.getSnapshot();
      expect(snapshot.generatedAt).toBe(1000);
      expect(snapshot.pollIntervalMs).toBe(1234);
      expect(snapshot.maxConcurrentAgents).toBe(5);
      expect(snapshot.running).toEqual([]);
      expect(snapshot.retrying).toEqual([]);

      const tryResult = host.tryGetSnapshot();
      expect(tryResult.status).toBe("available");
      if (tryResult.status === "available") {
        expect(tryResult.snapshot.generatedAt).toBe(1000);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("enables retry control plane: schedules backoff retry on failed attempt", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-retry-fail-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\nagent:\n  max_retry_backoff_ms: 15000\ncodex:\n  command: "${process.execPath} ${appServerFixture} --turn-status failed"\n---\nPrompt\n`,
      );

      const scheduledRetries: Array<{ delayMs: number; callback: () => void }> = [];
      const testRetryScheduler: RetryScheduler = {
        schedule(delayMs, callback) {
          const entry = { delayMs, callback };
          scheduledRetries.push(entry);
          return entry as TimerHandle;
        },
        cancel(handle) {
          const idx = scheduledRetries.indexOf(handle as unknown as { delayMs: number; callback: () => void });
          if (idx !== -1) scheduledRetries.splice(idx, 1);
        },
      };

      const lines: string[] = [];
      const logger = createMemoryLogger(lines);
      const testIssue = makeIssue("RETRY-FAIL", "open");
      const host = await createHost({
        workflowPath,
        logger,
        trackerProfiles: [fixtureProfile([], [testIssue])],
        retryScheduler: testRetryScheduler,
      });

      const dispatchResult = await host.authority.dispatchIssue(testIssue);
      expect(dispatchResult.kind).toBe("dispatched");

      await waitFor(() => host.state.running.size === 0);
      await waitFor(() => host.state.retryAttempts.size > 0);

      expect(host.state.retryAttempts.size).toBe(1);
      expect(host.authority.pendingRetryCount).toBe(1);

      const retryEntry = host.state.retryAttempts.get(testIssue.id);
      expect(retryEntry).toBeDefined();
      expect(retryEntry?.attempt).toBe(1);
      expect(retryEntry?.error).toBeDefined();
      expect(scheduledRetries.length).toBe(1);
      // SPEC §8.4 failure delay for attempt 1 is min(10000 * 2^0, 15000) = 10000ms
      expect(scheduledRetries[0]?.delayMs).toBe(10000);

      const snap = host.getSnapshot();
      expect(snap.retrying.length).toBe(1);
      expect(snap.retrying[0]?.issueId).toBe(testIssue.id);

      await host.stop();
      await host.authority.waitForIdle();
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15000);


  it("enables retry control plane: schedules continuation retry on successful attempt", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-retry-cont-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\ncodex:\n  command: "${process.execPath} ${appServerFixture}"\n---\nPrompt\n`,
      );

      const scheduledRetries: Array<{ delayMs: number; callback: () => void }> = [];
      const testRetryScheduler: RetryScheduler = {
        schedule(delayMs, callback) {
          const entry = { delayMs, callback };
          scheduledRetries.push(entry);
          return entry as TimerHandle;
        },
        cancel(handle) {
          const idx = scheduledRetries.indexOf(handle as unknown as { delayMs: number; callback: () => void });
          if (idx !== -1) scheduledRetries.splice(idx, 1);
        },
      };

      const testIssue = makeIssue("CONT-SUCC", "open");
      const host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile([], [testIssue])],
        retryScheduler: testRetryScheduler,
      });

      const dispatchResult = await host.authority.dispatchIssue(testIssue);
      expect(dispatchResult.kind).toBe("dispatched");

      await waitFor(() => host.state.running.size === 0);
      await waitFor(() => host.state.retryAttempts.size > 0);

      expect(host.state.retryAttempts.size).toBe(1);
      expect(host.authority.pendingRetryCount).toBe(1);

      const retryEntry = host.state.retryAttempts.get(testIssue.id);
      expect(retryEntry).toBeDefined();
      expect(retryEntry?.attempt).toBe(1);
      expect(retryEntry?.error).toBeNull();
      // Continuation delay is fixed 1000ms (SPEC §8.4)
      expect(scheduledRetries[0]?.delayMs).toBe(1000);

      await host.stop();
      await host.authority.waitForIdle();
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15000);


  it("enables stall detection: stops stalled running worker when stallTimeoutMs is exceeded", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-stall-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\ncodex:\n  command: "sleep 30"\n  stall_timeout_ms: 50\n---\nPrompt\n`,
      );

      let currentUtc = 1000;
      let currentMono = 1000;

      const testIssue = makeIssue("STALL-TEST", "open");
      const host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile([], [testIssue])],
        now: () => currentUtc,
        monotonicNow: () => currentMono,
      });

      const dispatched = await host.authority.dispatchIssue(testIssue);
      expect(dispatched.kind).toBe("dispatched");
      expect(host.state.running.size).toBe(1);

      // Before stall timeout, reconciliation does not stop worker
      const earlyRecon = await host.authority.reconcileRunningIssues();
      expect(earlyRecon.stalledIssueIds).toEqual([]);
      expect(host.state.running.size).toBe(1);

      // Advance UTC clock past stall_timeout_ms (50ms)
      currentUtc = 5000;
      currentMono = 5000;

      // Reconcile: stall detection triggers
      const stallRecon = await host.authority.reconcileRunningIssues();
      expect(stallRecon.stalledIssueIds).toContain(testIssue.id);

      await waitFor(() => host.state.running.size === 0);

      await host.stop();
      await host.authority.waitForIdle();
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15000);

});

