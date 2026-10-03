/**
 * M5.3 terminal retry refresh 的安全 workspace 清理回归（SPEC §8.4 note、§9.5、
 * §16.6、§17.4）。
 *
 * 用**真实** `@symphony/workspace` + 真实临时文件系统验证：
 * - terminal refresh 删除真实 workspace 目录；
 * - workspace 被换成逃逸 symlink 时 `removeWorkspace` 返回 `refused`，目录保留、
 *   出根目标无损，authority 只记诊断并释放 claim（不做删除 fallback、不启动 worker）。
 */
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentError, type AgentAttemptOptions, type AgentAttemptResult } from "@symphony/agent";
import type { Issue, OrchestratorRuntimeState } from "@symphony/domain";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";
import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type AgentAttemptRunner,
  type AttemptContext,
  type AttemptOptionsFactory,
  type DispatchPolicy,
  type RetryDiagnostic,
  type RetryScheduler,
  type WorkerTerminalOutcome,
} from "./index";

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: [],
  maxConcurrentAgentsByState: {},
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    nativeRef: null,
    identifier: "ABC-1",
    title: "Retry me",
    description: null,
    priority: 1,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
    ...overrides,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 轮询等待真实 fs / async cleanup 完成（短间隔，非退避测试用的长 sleep）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

class FakeRunner {
  private readonly deferreds: Deferred<AgentAttemptResult>[] = [];

  public readonly run: AgentAttemptRunner = () => {
    const d = deferred<AgentAttemptResult>();
    this.deferreds.push(d);
    return d.promise;
  };

  public get last(): Deferred<AgentAttemptResult> {
    const d = this.deferreds.at(-1);
    if (d === undefined) {
      throw new Error("runner has not been invoked");
    }
    return d;
  }
}

class ManualScheduler implements RetryScheduler {
  private next = 0;
  private readonly callbacks = new Map<number, () => void>();

  public schedule(_delayMs: number, callback: () => void): unknown {
    const id = ++this.next;
    this.callbacks.set(id, callback);
    return id;
  }

  public cancel(handle: unknown): void {
    if (typeof handle === "number") {
      this.callbacks.delete(handle);
    }
  }

  public fire(handle: unknown): void {
    if (typeof handle !== "number") {
      return;
    }
    const callback = this.callbacks.get(handle);
    this.callbacks.delete(handle);
    callback?.();
  }
}

class FakeTracker {
  public readonly issues = new Map<string, Issue>();
  public async fetchIssuesByIds(ids: readonly string[]): Promise<readonly Issue[]> {
    return ids
      .map((id) => this.issues.get(id))
      .filter((issue): issue is Issue => issue !== undefined);
  }
}

interface Harness {
  readonly authority: OrchestratorAuthority;
  readonly state: OrchestratorRuntimeState;
  readonly runner: FakeRunner;
  readonly scheduler: ManualScheduler;
  readonly tracker: FakeTracker;
  readonly diagnostics: RetryDiagnostic[];
  readonly outcomes: WorkerTerminalOutcome[];
}

function makeHarness(manager: WorkspaceManager): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 10 });
  const runner = new FakeRunner();
  const scheduler = new ManualScheduler();
  const tracker = new FakeTracker();
  const diagnostics: RetryDiagnostic[] = [];
  const outcomes: WorkerTerminalOutcome[] = [];
  const contexts: AttemptContext[] = [];

  const createAttemptOptions: AttemptOptionsFactory = (context) => {
    contexts.push(context);
    return { issue: context.issue, attempt: context.attempt } as unknown as AgentAttemptOptions;
  };

  const authority = new OrchestratorAuthority({
    state,
    policy: POLICY,
    runner: runner.run,
    createAttemptOptions,
    tracker,
    resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
    now: () => 1_000,
    monotonicNow: () => 5_000,
    onOutcome: (outcome) => outcomes.push(outcome),
    retry: {
      scheduler,
      maxRetryBackoffMs: () => 300_000,
      cleanupWorkspace: { removeWorkspace: (identifier: string) => manager.removeWorkspace(identifier) },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });

  return { authority, state, runner, scheduler, tracker, diagnostics, outcomes };
}

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-retry-ws-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("terminal retry refresh 的真实 workspace 清理", () => {
  it("terminal refresh 删除真实 workspace 目录并释放 claim", async () => {
    const root = await makeTempRoot();
    const manager = createWorkspaceManager({ workspace: { root } });
    const issue = makeIssue({ state: "Todo" });
    const workspace = await manager.createWorkspace(issue.identifier);
    await writeFile(path.join(workspace.path, "notes.txt"), "work in progress", "utf8");
    expect(await pathExists(workspace.path)).toBe(true);

    const h = makeHarness(manager);
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.runner.last.reject(new AgentError("port_exit", "died"));
    await h.authority.waitForIdle();
    const entry = h.state.retryAttempts.get(issue.id)!;

    // issue 在 retry refresh 时已变为 terminal → 安全清理 workspace。
    h.tracker.issues.set(issue.id, { ...issue, state: "Done" });
    h.scheduler.fire(entry.timerHandle);
    await waitFor(async () => !(await pathExists(workspace.path)));

    expect(await pathExists(workspace.path)).toBe(false);
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.state.retryAttempts.has(issue.id)).toBe(false);
    expect(h.diagnostics).toHaveLength(0);
    // 根目录本身仍在（只删除该 issue 的 workspace）。
    expect(await pathExists(root)).toBe(true);
  });

  it("workspace 换成逃逸 symlink 时 cleanup refused，出根目标保留、只记诊断", async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    const markerPath = path.join(outside, "keep-me.txt");
    await writeFile(markerPath, "do not delete", "utf8");

    const manager = createWorkspaceManager({ workspace: { root } });
    const issue = makeIssue({ identifier: "ABC-ESCAPE" });
    const workspace = await manager.createWorkspace(issue.identifier);
    // 把 workspace 目录替换为指向 root 外的 symlink（TOCTOU 逃逸）。
    await rm(workspace.path, { recursive: true, force: true });
    await symlink(outside, workspace.path);
    expect((await lstat(workspace.path)).isSymbolicLink()).toBe(true);

    const h = makeHarness(manager);
    h.tracker.issues.set(issue.id, issue);
    h.authority.dispatchIssue(issue);
    h.runner.last.reject(new AgentError("port_exit", "died"));
    await h.authority.waitForIdle();
    const entry = h.state.retryAttempts.get(issue.id)!;

    h.tracker.issues.set(issue.id, { ...issue, state: "Done" });
    h.scheduler.fire(entry.timerHandle);
    await waitFor(() => h.diagnostics.length === 1);

    // 出根目标与内容未被删除。
    expect(await pathExists(markerPath)).toBe(true);
    expect(await readFile(markerPath, "utf8")).toBe("do not delete");
    expect(await pathExists(outside)).toBe(true);
    // claim 释放、无 worker、有 refused 诊断。
    expect(h.state.claimed.has(issue.id)).toBe(false);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]).toMatchObject({ kind: "cleanup_refused", issueId: issue.id });
    expect(h.outcomes).toHaveLength(1);
  });
});
