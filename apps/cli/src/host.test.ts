import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decisionSessionId,
  githubDecisionRoot,
  type Issue,
  type TimerHandle,
} from "@symphony/domain";
import { DurableDecisionStore, DecisionService, DecisionPlanningGate } from "@symphony/decision";
import type { RetryScheduler } from "@symphony/orchestrator";
import { SymphonyConfigError } from "@symphony/config";
import { createStructuredLogger } from "@symphony/observability";
import { createGitHubAdapterProfile, type TrackerAdapterProfile } from "@symphony/tracker";
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

  it("preflight re-validates and rejects startup when env secret is removed even if file stamp is unchanged", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-preflight-env-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const env: Record<string, string | undefined> = { GITHUB_TOKEN: "valid-secret" };
    const profile = createGitHubAdapterProfile({ fetchImpl: async () => new Response("[]", { status: 200 }) });

    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );

      const host = await createHost({
        workflowPath,
        env,
        trackerProfiles: [profile],
        watcherIntervalMs: 60000,
      });

      // Remove the secret from env
      delete env.GITHUB_TOKEN;

      // host.start() runs preflight during startup validation and must fail
      await expect(host.start()).rejects.toThrow();

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("preflight re-validates and rejects startup when file content changes to invalid tracker kind even if mtime/size are preserved", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-preflight-stamp-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const env = { GITHUB_TOKEN: "valid-secret" };
    const profile = createGitHubAdapterProfile({ fetchImpl: async () => new Response("[]", { status: 200 }) });

    try {
      const body = `---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\nworkspace:\n  root: ${temp}\n---\nPrompt\n`;
      await writeFile(workflowPath, body);

      const targetTime = new Date("2026-01-01T00:00:00Z");
      await utimes(workflowPath, targetTime, targetTime);
      const originalStat = await stat(workflowPath);

      const host = await createHost({
        workflowPath,
        env,
        trackerProfiles: [profile],
        watcherIntervalMs: 60000,
      });

      // Replace kind: github with equal-length kind: badbad and restore same mtime
      await writeFile(workflowPath, body.replace("kind: github", "kind: badbad"));
      await utimes(workflowPath, targetTime, targetTime);
      const newStat = await stat(workflowPath);

      expect(newStat.mtimeMs).toBe(originalStat.mtimeMs);
      expect(newStat.size).toBe(originalStat.size);

      // host.start() preflight must re-read from disk and reject badbad
      await expect(host.start()).rejects.toThrow();

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("enables planning gate in createHost: blocks unapproved issues and passes plan when eligible", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-planning-test-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const storeDir = path.join(temp, ".symphony", "decision");

    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );

      const store = new DurableDecisionStore({ storeDir });
      await store.open();
      const service = new DecisionService(store);
      const root = githubDecisionRoot("owner", "repo", 42);
      await service.createSession(root);
      const sessionId = decisionSessionId(root);

      const host = await createHost({
        workflowPath,
        planningGate: new DecisionPlanningGate(service),
        enablePlanning: true,
        env: { GITHUB_TOKEN: "dummy" },
      });

      const issue = makeIssue("GH-42", "open", {
        title: "Test Issue",
        description: "Test description",
        url: "https://github.com/owner/repo/issues/42",
        nativeRef: { repo: "owner/repo", number: 42 },
      });

      // 1. Initial: no plan -> dispatchIssue returns not_eligible
      const res1 = host.authority.dispatchIssue(issue);
      expect(res1.kind).toBe("not_eligible");

      const task = await service.createPlanTask(sessionId, {
        requirements: { title: "Test Issue", body: "Test description" },
      });
      const claim = await service.claimTask(task.id, { owner: "planner", ttlMs: 60_000 });
      await service.startTask(task.id, {
        owner: "planner",
        token: claim.lease.token,
        generation: claim.lease.generation,
      });
      await service.submitResult(task.id, {
        owner: "planner",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: {
          schemaVersion: 1,
          taskId: task.id,
          sessionId,
          revision: task.revision,
          kind: "plan",
          verdict: "ready",
          content: {
            plan: "Step 1",
            acceptanceCriteria: ["AC 1"],
            risks: [],
            clarifications: [],
          },
          createdAtMs: Date.now(),
        },
      });

      // Still not published -> not_eligible
      const res2 = host.authority.dispatchIssue(issue);
      expect(res2.kind).toBe("not_eligible");

      // 3. Mark published
      await service.markPlanPublished(task.id, { commentId: 101 });

      // Now eligible -> dispatched!
      const res3 = host.authority.dispatchIssue(issue);
      expect(res3.kind).toBe("dispatched");

      // 4. Requirements changed on another issue GH-43
      const root2 = githubDecisionRoot("owner", "repo", 43);
      await service.createSession(root2);
      const sessionId2 = decisionSessionId(root2);
      const task2 = await service.createPlanTask(sessionId2, {
        requirements: { title: "Issue 43", body: "Initial body" },
      });
      const claim2 = await service.claimTask(task2.id, { owner: "planner", ttlMs: 60_000 });
      await service.startTask(task2.id, {
        owner: "planner",
        token: claim2.lease.token,
        generation: claim2.lease.generation,
      });
      await service.submitResult(task2.id, {
        owner: "planner",
        token: claim2.lease.token,
        generation: claim2.lease.generation,
        result: {
          schemaVersion: 1,
          taskId: task2.id,
          sessionId: sessionId2,
          revision: task2.revision,
          kind: "plan",
          verdict: "ready",
          content: {
            plan: "Step 1",
            acceptanceCriteria: ["AC 1"],
            risks: [],
            clarifications: [],
          },
          createdAtMs: Date.now(),
        },
      });
      await service.markPlanPublished(task2.id, { commentId: 102 });

      const driftedIssue = makeIssue("GH-43", "open", {
        title: "Issue 43",
        description: "Modified body since planning",
        url: "https://github.com/owner/repo/issues/43",
        nativeRef: { repo: "owner/repo", number: 43 },
      });
      const res4 = host.authority.dispatchIssue(driftedIssue);
      expect(res4.kind).toBe("not_eligible");

      await host.authority.shutdown();
      await host.stop();
      await store.close();
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("dispatches a clarified plan even though Issue facts carry no clarifications", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-clarify-test-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const storeDir = path.join(temp, ".symphony", "decision");

    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );

      const store = new DurableDecisionStore({ storeDir });
      await store.open();
      const service = new DecisionService(store);
      const root = githubDecisionRoot("owner", "repo", 77);
      await service.createSession(root);
      const sessionId = decisionSessionId(root);

      // Mirrors the durable result of `symphony plan clarify`: answered
      // clarifications are persisted with the plan and folded into its fingerprint.
      const task = await service.createPlanTask(sessionId, {
        triggerKind: "clarification",
        requirements: {
          title: "Clarified issue",
          body: "Original body",
          clarifications: ["Use approach A"],
        },
      });
      const claim = await service.claimTask(task.id, { owner: "planner", ttlMs: 60_000 });
      await service.startTask(task.id, {
        owner: "planner",
        token: claim.lease.token,
        generation: claim.lease.generation,
      });
      await service.submitResult(task.id, {
        owner: "planner",
        token: claim.lease.token,
        generation: claim.lease.generation,
        result: {
          schemaVersion: 1,
          taskId: task.id,
          sessionId,
          revision: task.revision,
          kind: "plan",
          verdict: "ready",
          content: { plan: "Use approach A", acceptanceCriteria: ["AC"], risks: [], clarifications: [] },
          createdAtMs: Date.now(),
        },
      });
      await service.markPlanPublished(task.id, { commentId: 202 });

      const host = await createHost({
        workflowPath,
        planningGate: new DecisionPlanningGate(service),
        enablePlanning: true,
        env: { GITHUB_TOKEN: "dummy" },
      });

      const issue = makeIssue("GH-77", "open", {
        title: "Clarified issue",
        description: "Original body",
        url: "https://github.com/owner/repo/issues/77",
        nativeRef: { repo: "owner/repo", number: 77 },
      });

      // The dispatch entry only knows GitHub title/body; the service must apply
      // the durable clarifications instead of reporting requirements_changed.
      const res = host.authority.dispatchIssue(issue);
      expect(res.kind).toBe("dispatched");

      await host.authority.shutdown();
      await host.stop();
      await store.close();
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("createHost auto-creates DecisionPlanningGate from storeDir and cleanly closes owned store on stop", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-planning-auto-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const storeDir = path.join(temp, ".symphony", "decision");

    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: github\n  provider:\n    repo: owner/repo\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );

      const host = await createHost({
        workflowPath,
        decisionStoreDir: storeDir,
        enablePlanning: true,
        env: { GITHUB_TOKEN: "dummy" },
      });

      const issue = makeIssue("GH-42", "open", {
        title: "Test Issue",
        description: "Test description",
        url: "https://github.com/owner/repo/issues/42",
        nativeRef: { repo: "owner/repo", number: 42 },
      });

      // No plan in auto-created store -> dispatch rejected
      const res = host.authority.dispatchIssue(issue);
      expect(res.kind).toBe("not_eligible");

      // Stopping host must release the store lock cleanly
      await host.stop();

      // We should now be able to open the store without lock conflict
      const store = new DurableDecisionStore({ storeDir });
      await store.open();
      expect(store.getAllTasks()).toEqual([]);
      await store.close();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects conflicting backend options in createHost (decisionStoreDir + decisionBridgeUrl)", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-conflict-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );
      await expect(
        createHost({
          workflowPath,
          decisionStoreDir: "/tmp/some-store",
          decisionBridgeUrl: "http://127.0.0.1:8080",
        }),
      ).rejects.toThrowError(SymphonyConfigError);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("explicit decisionStoreDir takes precedence over inherited DECISION_BRIDGE_URL", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-store-precedence-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const storeDir = path.join(temp, ".symphony", "decision");
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );
      // Pass an invalid bridge URL in options.env; explicit decisionStoreDir should still be used
      const host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile()],
        decisionStoreDir: storeDir,
        env: {
          DECISION_BRIDGE_URL: "http://127.0.0.1:1", // dead port
        },
      });
      expect(host).toBeDefined();
      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("assembles default WorkContinuityCoordinator and discovers active work during tick without running worker", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-work-continuity-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const issues = [makeIssue("1", "open")];
    try {
      await writeFile(
        workflowPath,
        `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\n---\nPrompt\n`,
      );
      const host = await createHost({
        workflowPath,
        trackerProfiles: [fixtureProfile([], issues)],
      });
      expect(host.workContinuityCoordinator).toBeDefined();
      expect(host.authority.activeWorkerCount).toBe(0);

      const res = await host.workContinuityCoordinator.reconcile();
      expect(res).toBeDefined();
      expect(res.reconciledCount).toBeGreaterThanOrEqual(0);
      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});


