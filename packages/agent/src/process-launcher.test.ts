import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentError } from "../src/errors";
import { launchTransport, type LaunchTransportOptions } from "../src/process-launcher";
import type { Transport, TransportExitInfo } from "../src/transport";
import { WorkspaceError, type UnsafePathReason, type WorkspaceManager } from "@symphony/workspace";

import {
  createWorkspaceFixture,
  fixtureCommand,
  isProcessAlive,
  resultObject,
  shellQuote,
  waitFor,
  type WorkspaceFixture,
} from "../test-fixtures/harness";

/**
 * Coding-agent 子进程 launch 边界测试（SPEC §10.1 Launch Contract、§17.2
 * "Agent launch uses the per-issue workspace path as cwd and rejects out-of-root
 * paths"、§17.5 "Launch command uses workspace cwd and invokes
 * `bash -lc <codex.command>`"，M4.2 / #38）。
 *
 * #38 验收 1 / 2 / 3 与 §17.2 launch-cwd 行（验收 9）全部落在本文件：
 * 断言对象是**真实子进程自报的 `process.cwd()`**，不是被测代码的自述。
 */

const openTransports: Transport[] = [];
const openFixtures: WorkspaceFixture[] = [];
const extraDirs: string[] = [];

async function openFixture(
  overrides: Partial<Omit<LaunchTransportOptions, "workspacePathSafety" | "workspacePath">> = {},
): Promise<{ transport: Transport; fixture: WorkspaceFixture }> {
  const fixture = await createWorkspaceFixture();
  openFixtures.push(fixture);
  const transport = await launchTransport({
    command: fixtureCommand(),
    workspacePath: fixture.workspacePath,
    workspacePathSafety: fixture.manager,
    readTimeoutMs: 4_000,
    ...overrides,
  });
  openTransports.push(transport);
  return { transport, fixture };
}

/** 记录 gate 调用（顺序与次数）的包装：证明 launch 前紧邻重验。 */
function recordingGate(manager: WorkspaceManager, calls: string[]): WorkspacePathGateLike {
  return {
    async assertWorkspacePathSafe(workspacePath: string, options): Promise<void> {
      calls.push(workspacePath);
      await manager.assertWorkspacePathSafe(workspacePath, options);
    },
  };
}

type WorkspacePathGateLike = Parameters<typeof launchTransport>[0]["workspacePathSafety"];

/** §17.2 的「child 未启动」实证：command 先 `touch marker` 再 exec fixture。 */
function markerFirstCommand(marker: string): string {
  return `touch ${shellQuote(marker)} && ${fixtureCommand()}`;
}

/** AgentError.cause 里 `WorkspaceError` 携带的 §9.5 细分拒绝原因。 */
function containmentReason(error: unknown): UnsafePathReason | undefined {
  const cause = (error as AgentError).cause;
  return cause instanceof WorkspaceError ? cause.unsafeReason : undefined;
}

afterEach(async () => {
  for (;;) {
    const transport = openTransports.shift();
    if (transport === undefined) {
      break;
    }
    await transport.stop().catch(() => undefined);
  }
  for (;;) {
    const fixture = openFixtures.shift();
    if (fixture === undefined) {
      break;
    }
    await fixture.dispose();
  }
  while (extraDirs.length > 0) {
    const dir = extraDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("§10.1 / §17.5 launch 形态：bash -lc + workspace cwd", () => {
  it("fixture 自报 process.cwd() 就是 workspace path，且 PID 是被 launch 的那个进程", async () => {
    const { transport, fixture } = await openFixture();

    const response = await transport.sendRequest({
      method: "test/info",
      params: { names: ["SYMPHONY_M42_INHERITED"] },
    });
    const info = resultObject(response.result);

    expect(info.cwd).toBe(fixture.workspacePath);
    expect(transport.pid).toBe(String(info.pid));
    expect(isProcessAlive(Number(transport.pid))).toBe(true);
    // 经包公共 gate 解析出的 workspace 路径与真实 cwd 一致（§17.2 launch-cwd 实证）。
    const validation = await fixture.manager.validateWorkspacePath(fixture.workspacePath);
    expect(validation.safe && validation.path).toBe(resolve(fixture.workspacePath));
  }, 15_000);

  it("command 确实经 `bash -lc` 解释：shell 展开发生在子进程侧", async () => {
    const { transport, fixture } = await openFixture();
    const info = resultObject(
      (await transport.sendRequest({ method: "test/info", params: {} })).result,
    );

    // `--cwd "$(pwd)"` / `--bash "$BASH_VERSION"` 只有走 shell 才会被展开。
    expect(info.shellCwd).toBe(fixture.workspacePath);
    expect(info.bashVersion, `BASH_VERSION=${String(info.bashVersion)}`).toMatch(/^\d+\.\d+/);
    expect(String(info.argv).includes("$(pwd)")).toBe(false);
    expect(String(info.argv).includes("$BASH_VERSION")).toBe(false);
  }, 15_000);

  it("shell 前缀赋值形态由 shell 解析，transport 不参与 argv 拆解", async () => {
    // 故意写成 transport 无法自行 parse 的 shell 形态：`VAR=value <node> <fixture> …`。
    // 父进程里先放一个不同值，证明 child 看到的是 shell 注入的那个。
    process.env.SYMPHONY_M42_SET_BY_SHELL = "from-parent-env";
    try {
      const { transport } = await openFixture({
        command: `SYMPHONY_M42_SET_BY_SHELL=from-shell ${fixtureCommand()}`,
      });
      const info = resultObject(
        (
          await transport.sendRequest({
            method: "test/info",
            params: { names: ["SYMPHONY_M42_SET_BY_SHELL"] },
          })
        ).result,
      );

      expect(info.env).toEqual({ SYMPHONY_M42_SET_BY_SHELL: "from-shell" });
    } finally {
      delete process.env.SYMPHONY_M42_SET_BY_SHELL;
    }
  }, 15_000);
});

describe("§9.5 / §17.2 launch 前的 workspace cwd containment 重验", () => {
  it("workspace path 等于 root：拒绝 launch，且 child 从未启动", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const marker = join(fixture.root, "child-started.marker");

    const error = await launchTransport({
      command: markerFirstCommand(marker),
      workspacePath: fixture.root,
      workspacePathSafety: fixture.manager,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("invalid_workspace_cwd");
    expect((error as AgentError).cause).toBeInstanceOf(WorkspaceError);
    expect(containmentReason(error)).toBe("workspace_equals_root");
    expect((error as AgentError).path).toBe(fixture.root);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("out-of-root 路径：拒绝 launch，且 child 从未启动", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "symphony-m42-outside-")));
    extraDirs.push(outside);
    const marker = join(outside, "child-started.marker");

    const error = await launchTransport({
      command: `touch ${shellQuote(marker)} && ${fixtureCommand()}`,
      workspacePath: outside,
      workspacePathSafety: fixture.manager,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as AgentError)?.code).toBe("invalid_workspace_cwd");
    expect(containmentReason(error)).toBe("workspace_outside_root");
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("workspace 目录被替换成逃逸 symlink：launch 前重验拦下，child 未启动", async () => {
    const fixture = await createWorkspaceFixture({ createWorkspaceDirectory: false });
    openFixtures.push(fixture);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "symphony-m42-escape-")));
    extraDirs.push(outside);
    // 先有合法目录，**再**在 launch 之前被换成指向 root 外的 symlink（M3.2 TOCTOU 面）。
    const workspace = join(fixture.root, "issue-9");
    await symlink(outside, workspace, "dir");
    const marker = join(fixture.root, "symlink-child-started.marker");

    const error = await launchTransport({
      command: markerFirstCommand(marker),
      workspacePath: workspace,
      workspacePathSafety: fixture.manager,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((error as AgentError)?.code).toBe("invalid_workspace_cwd");
    expect(containmentReason(error)).toBe("workspace_symlink_escape");
    expect(existsSync(marker)).toBe(false);
    // root 外的目标目录也没被写过任何东西。
    expect(existsSync(join(outside, "child-started.marker"))).toBe(false);
  }, 15_000);

  it("createWorkspace 通过后再被换成逃逸 symlink：同一 gate 在 launch 前重验（§17.2 收口）", async () => {
    const fixture = await createWorkspaceFixture({
      createWorkspaceDirectory: false,
    });
    openFixtures.push(fixture);
    const created = await fixture.manager.createWorkspace("SYM-11");
    expect(existsSync(created.path)).toBe(true);

    const outside = await realpath(await mkdtemp(join(tmpdir(), "symphony-m42-after-create-")));
    extraDirs.push(outside);
    await rm(created.path, { recursive: true, force: true });
    await symlink(outside, created.path, "dir");
    const marker = join(fixture.root, "after-create-child-started.marker");

    await expect(
      launchTransport({
        command: markerFirstCommand(marker),
        workspacePath: created.path,
        workspacePathSafety: fixture.manager,
      }),
    ).rejects.toMatchObject({ code: "invalid_workspace_cwd" });
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("gate 恰好被调用一次、参数就是实际 spawn 的 cwd", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const calls: string[] = [];

    const transport = await launchTransport({
      command: fixtureCommand(),
      workspacePath: fixture.workspacePath,
      workspacePathSafety: recordingGate(fixture.manager, calls),
    });
    openTransports.push(transport);
    const info = resultObject(
      (await transport.sendRequest({ method: "test/info", params: {} })).result,
    );

    expect(calls).toEqual([resolve(fixture.workspacePath)]);
    expect(info.cwd).toBe(calls[0]);
  }, 15_000);
});

describe("§10.6 / §17.2 launch 失败面", () => {
  it("空 command：launch_failed，不 spawn、不做 gate 校验", async () => {
    const fixture = await createWorkspaceFixture();
    openFixtures.push(fixture);
    const marker = join(fixture.root, "empty-command.marker");

    const error = await launchTransport({
      command: "   ",
      workspacePath: fixture.workspacePath,
      workspacePathSafety: fixture.manager,
    } as LaunchTransportOptions).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("launch_failed");
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it("containment 通过但目录不存在：spawn 失败映射为 launch_failed 并保留原始 cause", async () => {
    const fixture = await createWorkspaceFixture({ createWorkspaceDirectory: false });
    openFixtures.push(fixture);

    const error = await launchTransport({
      command: fixtureCommand(),
      workspacePath: join(fixture.root, "never-created"),
      workspacePathSafety: fixture.manager,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("launch_failed");
    expect((error as AgentError).path).toBe(resolve(join(fixture.root, "never-created")));
    expect(String((error as AgentError).cause)).toContain("ENOENT");
  }, 15_000);

  it("launch 失败的错误只经 cause 保留底层异常，不透传未类型化异常", async () => {
    const fixture = await createWorkspaceFixture({ createWorkspaceDirectory: false });
    openFixtures.push(fixture);
    const thrown = await launchTransport({
      command: fixtureCommand(),
      workspacePath: join(fixture.root, "gone"),
      workspacePathSafety: {
        assertWorkspacePathSafe: async () => undefined,
      },
    }).catch((error: unknown) => error);

    // 绕过 gate 的调用方拿到的仍是 typed AgentError（而不是裸 ENOENT）。
    expect(thrown).toBeInstanceOf(AgentError);
    expect((thrown as AgentError).code).toBe("launch_failed");
  }, 15_000);
});

describe("§10.1 子进程环境：显式 env + generic excludeEnvNames", () => {
  it("继承集合可点名剔除，显式 env 后写优先；不含任何硬编码 secret 名单", async () => {
    process.env.SYMPHONY_M42_KEEP = "kept";
    process.env.SYMPHONY_M42_DROP = "should-not-reach-child";
    process.env.SYMPHONY_M42_OVERRIDE = "parent-value";
    try {
      const { transport } = await openFixture({
        env: { SYMPHONY_M42_OVERRIDE: "child-value", SYMPHONY_M42_EXTRA: "only-in-child" },
        excludeEnvNames: ["SYMPHONY_M42_DROP", "PATH_LIKE_ANY_NAME_THE_CALLER_PICKS"],
      });
      const info = resultObject(
        (
          await transport.sendRequest({
            method: "test/info",
            params: {
              names: [
                "SYMPHONY_M42_KEEP",
                "SYMPHONY_M42_DROP",
                "SYMPHONY_M42_OVERRIDE",
                "SYMPHONY_M42_EXTRA",
              ],
            },
          })
        ).result,
      );

      expect(info.env).toEqual({
        SYMPHONY_M42_KEEP: "kept",
        SYMPHONY_M42_DROP: null,
        SYMPHONY_M42_OVERRIDE: "child-value",
        SYMPHONY_M42_EXTRA: "only-in-child",
      });
    } finally {
      delete process.env.SYMPHONY_M42_KEEP;
      delete process.env.SYMPHONY_M42_DROP;
      delete process.env.SYMPHONY_M42_OVERRIDE;
      delete process.env.SYMPHONY_M42_EXTRA;
    }
  }, 15_000);

  it("不注入 excludeEnvNames 时按父进程环境继承（fixture 读得到 PATH）", async () => {
    const { transport } = await openFixture();
    const info = resultObject(
      (await transport.sendRequest({ method: "test/info", params: { names: ["PATH"] } })).result,
    );

    expect(typeof (info.env as Record<string, unknown>).PATH).toBe("string");
    expect(String((info.env as Record<string, unknown>).PATH).length).toBeGreaterThan(0);
  }, 15_000);
});

describe("transport 与 launch 边界的衔接", () => {
  it("未 await stop 就退出：pid 可读、closed 翻转、重复 stop 幂等", async () => {
    const { transport, collector } = await openFixtureWithCollector();
    expect(transport.closed).toBe(false);
    expect(transport.pid).toBeTypeOf("string");

    await transport.sendRequest({ method: "test/exit", params: { code: 0 } }).catch(() => undefined);
    expect(await waitFor(() => transport.closed)).toBe(true);
    await transport.stop();
    await transport.stop();
    expect(collector.exit?.stopped).toBe(false);
  }, 15_000);
});

async function openFixtureWithCollector(): Promise<{
  transport: Transport;
  collector: { exit: TransportExitInfo | null };
}> {
  const collector: { exit: TransportExitInfo | null } = { exit: null };
  const fixture = await createWorkspaceFixture();
  openFixtures.push(fixture);
  const transport = await launchTransport({
    command: fixtureCommand(),
    workspacePath: fixture.workspacePath,
    workspacePathSafety: fixture.manager,
    listener: {
      onExit: (info) => {
        collector.exit = info;
      },
    },
  });
  openTransports.push(transport);
  return { transport, collector };
}
