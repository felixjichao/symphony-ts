/**
 * M5.4 startup terminal workspace sweep 测试（SPEC §8.1 / §8.6、§14.3、§16.1、
 * §17.4｜验收 09 / 10）。
 *
 * 用**真实** `@symphony/workspace` + 真实临时文件系统验证：
 * - startup 按 terminal states 拉取并对每个 identifier 删除真实 workspace 目录；
 * - 非 terminal 目录保留、重复调用幂等（missing）；
 * - fetch 失败不阻止启动、不改动文件系统；
 * - 单项 refused / failed 只记诊断并继续其余项，绝不绕过 containment 做 fallback。
 */
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentAttemptOptions } from "@symphony/agent";
import type { Issue } from "@symphony/domain";
import { createWorkspaceManager, type WorkspaceManager } from "@symphony/workspace";
import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestratorAuthority,
  createOrchestratorRuntimeState,
  type DispatchPolicy,
  type RetryDiagnostic,
  type RetryWorkspaceCleanupResult,
} from "./index";

const POLICY: DispatchPolicy = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
  requiredLabels: [],
  maxConcurrentAgentsByState: {},
};

function makeIssue(identifier: string, state: string, id = `id-${identifier}`): Issue {
  return {
    id,
    nativeRef: null,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state,
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
  };
}

class FakeTracker {
  public terminalFail = false;
  public terminalIssues: readonly Issue[] = [];
  public readonly terminalCalls: string[][] = [];

  public async fetchIssuesByIds(): Promise<readonly Issue[]> {
    return [];
  }

  public async fetchIssuesByStates(stateNames: readonly string[]): Promise<readonly Issue[]> {
    this.terminalCalls.push([...stateNames]);
    if (this.terminalFail) {
      throw new Error("terminal fetch down");
    }
    return this.terminalIssues;
  }
}

type CleanupOverride = "throw" | RetryWorkspaceCleanupResult["status"];

interface Harness {
  readonly authority: OrchestratorAuthority;
  readonly tracker: FakeTracker;
  readonly diagnostics: RetryDiagnostic[];
  readonly cleanupCalls: string[];
}

function makeHarness(
  manager: WorkspaceManager,
  cleanupOverrides: Readonly<Record<string, CleanupOverride>> = {},
): Harness {
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 2 });
  const tracker = new FakeTracker();
  const diagnostics: RetryDiagnostic[] = [];
  const cleanupCalls: string[] = [];

  const authority = new OrchestratorAuthority({
    state,
    policy: POLICY,
    runner: async () => {
      throw new Error("startup sweep must not launch workers");
    },
    createAttemptOptions: (context) => ({ issue: context.issue }) as unknown as AgentAttemptOptions,
    tracker,
    resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
    now: () => 1_000,
    monotonicNow: () => 5_000,
    // 只提供顶层 cleanup 端口（不启用 retry），证明 cleanup 不再依赖 retry 接线。
    cleanupWorkspace: {
      removeWorkspace: async (identifier: string): Promise<RetryWorkspaceCleanupResult> => {
        cleanupCalls.push(identifier);
        const override = cleanupOverrides[identifier];
        if (override === "throw") {
          throw new Error(`cleanup threw for ${identifier}`);
        }
        if (override !== undefined) {
          return { status: override };
        }
        return manager.removeWorkspace(identifier);
      },
    },
    onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  return { authority, tracker, diagnostics, cleanupCalls };
}

const tempRoots: string[] = [];

async function makeTempRoot(prefix = "symphony-startup-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("startup terminal cleanup — 验收 09", () => {
  it("删除 terminal workspace、保留非 terminal、按 terminal states 拉取且重复调用幂等", async () => {
    const root = await makeTempRoot();
    const manager = createWorkspaceManager({ workspace: { root } });
    const done = await manager.createWorkspace("ABC-1");
    const cancelled = await manager.createWorkspace("ABC-2");
    const keep = await manager.createWorkspace("ABC-3");
    await writeFile(path.join(keep.path, "keep.txt"), "still active", "utf8");

    const h = makeHarness(manager);
    h.tracker.terminalIssues = [makeIssue("ABC-1", "Done"), makeIssue("ABC-2", "Cancelled")];

    const result = await h.authority.runStartupTerminalCleanup();
    expect(result.unavailable).toBe(false);
    expect(result.fetchFailed).toBe(false);
    expect(result.removed).toEqual(["ABC-1", "ABC-2"]);
    expect(result.missing).toEqual([]);
    expect(h.tracker.terminalCalls).toEqual([[...POLICY.terminalStates]]);
    expect(await pathExists(done.path)).toBe(false);
    expect(await pathExists(cancelled.path)).toBe(false);
    expect(await pathExists(keep.path)).toBe(true);
    expect(await readFile(path.join(keep.path, "keep.txt"), "utf8")).toBe("still active");
    expect(await pathExists(root)).toBe(true);
    expect(h.diagnostics).toHaveLength(2);
    expect(h.diagnostics.every((d) => d.kind === "cleanup_completed" && d.cleanupStatus === "removed")).toBe(true);

    // 重复执行：目录已不存在 → 幂等 missing，不再报错。
    const again = await h.authority.runStartupTerminalCleanup();
    expect(again.removed).toEqual([]);
    expect(again.missing).toEqual(["ABC-1", "ABC-2"]);
    expect(again.failed).toEqual([]);
    expect(await pathExists(keep.path)).toBe(true);
  });

  it("terminal fetch 失败不阻止启动且不改动文件系统", async () => {
    const root = await makeTempRoot();
    const manager = createWorkspaceManager({ workspace: { root } });
    const workspace = await manager.createWorkspace("ABC-1");

    const h = makeHarness(manager);
    h.tracker.terminalFail = true;

    const result = await h.authority.runStartupTerminalCleanup();
    expect(result.fetchFailed).toBe(true);
    expect(result.removed).toEqual([]);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(await pathExists(workspace.path)).toBe(true);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]).toMatchObject({ kind: "cleanup_fetch_failed", issueId: null });
  });

  it("tracker 缺少 fetchIssuesByStates 时报告 unavailable 且不发请求", async () => {
    const root = await makeTempRoot();
    const manager = createWorkspaceManager({ workspace: { root } });
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 30_000, maxConcurrentAgents: 2 });
    const diagnostics: RetryDiagnostic[] = [];
    const authority = new OrchestratorAuthority({
      state,
      policy: POLICY,
      runner: async () => {
        throw new Error("no dispatch");
      },
      createAttemptOptions: (context) => ({ issue: context.issue }) as unknown as AgentAttemptOptions,
      tracker: { fetchIssuesByIds: async () => [] },
      resolveWorkspacePath: (issue) => manager.resolveWorkspacePath(issue.identifier),
      cleanupWorkspace: { removeWorkspace: async () => ({ status: "removed" as const }) },
      onCleanupDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const result = await authority.runStartupTerminalCleanup();
    expect(result.unavailable).toBe(true);
    expect(result.fetchFailed).toBe(false);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe("cleanup_unavailable");
  });
});

describe("startup terminal cleanup — 验收 10（安全边界不被绕过）", () => {
  it("workspace 被换成逃逸 symlink 时 refused，出根目标无损", async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot("symphony-startup-outside-");
    const markerPath = path.join(outside, "keep-me.txt");
    await writeFile(markerPath, "do not delete", "utf8");

    const manager = createWorkspaceManager({ workspace: { root } });
    const workspace = await manager.createWorkspace("ESCAPE-1");
    await rm(workspace.path, { recursive: true, force: true });
    await symlink(outside, workspace.path);
    expect((await lstat(workspace.path)).isSymbolicLink()).toBe(true);

    const h = makeHarness(manager);
    h.tracker.terminalIssues = [makeIssue("ESCAPE-1", "Done")];

    const result = await h.authority.runStartupTerminalCleanup();
    expect(result.refused).toEqual(["ESCAPE-1"]);
    expect(result.removed).toEqual([]);
    expect(await readFile(markerPath, "utf8")).toBe("do not delete");
    expect(await pathExists(outside)).toBe(true);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]).toMatchObject({ kind: "cleanup_refused", identifier: "ESCAPE-1" });
  });

  it("单项 refused / failed / 异常不阻断其余项", async () => {
    const root = await makeTempRoot();
    const manager = createWorkspaceManager({ workspace: { root } });
    const refusedTarget = await manager.createWorkspace("R-1");
    // R-1 被换成逃逸 symlink，触发真实 refused。
    const outside = await makeTempRoot("symphony-startup-outside-");
    await writeFile(path.join(outside, "marker.txt"), "keep", "utf8");
    await rm(refusedTarget.path, { recursive: true, force: true });
    await symlink(outside, refusedTarget.path);

    const ok = await manager.createWorkspace("OK-1");
    const failing = await manager.createWorkspace("F-1");
    const throwing = await manager.createWorkspace("T-1");

    const h = makeHarness(manager, { "F-1": "failed", "T-1": "throw" });
    h.tracker.terminalIssues = [
      makeIssue("R-1", "Done"),
      makeIssue("F-1", "Done"),
      makeIssue("T-1", "Done"),
      makeIssue("OK-1", "Cancelled"),
    ];

    const result = await h.authority.runStartupTerminalCleanup();
    // 每项都尝试处理：refused / failed / 异常各一，其余仍被删除。
    expect(result.refused).toEqual(["R-1"]);
    expect(result.failed).toEqual(["F-1", "T-1"]);
    expect(result.removed).toEqual(["OK-1"]);
    expect(await pathExists(ok.path)).toBe(false);
    expect(await pathExists(failing.path)).toBe(true);
    expect(await pathExists(throwing.path)).toBe(true);
    expect(await readFile(path.join(outside, "marker.txt"), "utf8")).toBe("keep");
    const kinds = h.diagnostics.map((diagnostic) => diagnostic.kind).sort();
    expect(kinds).toEqual(["cleanup_completed", "cleanup_error", "cleanup_failed", "cleanup_refused"]);
  });
});
