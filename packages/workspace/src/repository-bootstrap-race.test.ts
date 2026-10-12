import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapRepository, RepositoryBootstrapError } from "./index";

/**
 * 正常 close 收尾与 timeout 的收尾所有权回归（NEST-119 第三轮审查 blocker）。
 *
 * 统一后的收尾契约：
 * - close 接管收尾时停掉原 timer（命令已完成，收尾期间不得再触发 timeout），
 *   并在 await 前后复查 timedOut——已判定的 timeout 绝不被迟到成功覆盖；
 * - timer 先触发（命令执行中超时）时，typed git_command_timeout 由收敛流程
 *   保留，close 只记录根退出、不重复注册等待；
 * - 组确认/收尾放慢（200ms mock）不改变上述任一结果。
 *
 * 时序控制（第四轮审查 blocker 修正）：close/timeout 顺序不得依赖解释器启动
 * 速度——fake git 改用 `#!/bin/sh`（毫秒级启动，相对 100ms 预算约 20 倍裕量，
 * 全套并发下 close 仍恒早于预算到期）；normal-close 用例按审查 Suggestion
 * 断言全程零 SIGKILL（区分「timer 正确停止」与「timeout 触发后被成功覆盖」，
 * 修复前实现会产生 timeout 组终止信号）。
 */
vi.mock("./git-supervisor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-supervisor")>();
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ...actual,
    scanProcessGroupsForLiveMembers: async (pgids: readonly number[], _deadline: number) => {
      await delay(200);
      return actual.scanProcessGroupsForLiveMembers(pgids, Date.now() + 5_000);
    },
    terminateOrphanedProcessGroup: async (pgid: number, _deadline: number) => {
      await delay(200);
      return actual.terminateOrphanedProcessGroup(pgid, Date.now() + 5_000);
    },
  };
});

describe("正常 close 收尾与 timeout 的收尾所有权", () => {
  let tmpBase: string;
  let originalKill: typeof process.kill;
  let sigkillCount: number;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-bootstrap-race-test-"));
    originalKill = process.kill;
    sigkillCount = 0;
  });

  afterEach(async () => {
    process.kill = originalKill;
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  /** 安装 SIGKILL 计数器（区分「timer 停止」与「timeout 触发后终止组」）。 */
  function installSigkillCounter(): void {
    const bound = originalKill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === "SIGKILL") {
        sigkillCount += 1;
      }
      return bound(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
  }

  it("timer 先触发（执行中超时）时，close 收尾不得把 typed git_command_timeout 翻成成功", async () => {
    // git（sh）sleep 300ms 后退出：timeout=50ms 先触发，收敛流程 kill 组并等待
    // close；close 到达时收尾流程已持有 settle 权，慢确认（200ms mock）不改结果。
    const fakeBin = path.join(tmpBase, "bin");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nsleep 0.3\nexit 0\n", { mode: 0o755 });
    const workspaceDir = path.join(tmpBase, "ws-timeout");
    await fs.mkdir(workspaceDir, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    installSigkillCounter();
    try {
      let thrown: unknown;
      try {
        await bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: "/unused/local/repo",
          workspaceKey: "GH-79",
          timeoutMs: 50,
        });
      } catch (err: unknown) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(RepositoryBootstrapError);
      const error = thrown as RepositoryBootstrapError;
      expect(error.code).toBe("git_command_timeout");
      expect((error.details as { cleanupConfirmed?: boolean }).cleanupConfirmed).toBe(true);
      // timeout 收敛流程对组的终止信号恰好发生（kill 根 + 组清空确认）。
      expect(sigkillCount).toBeGreaterThan(0);
      // 后续命令不得被迟到成功推进。
      expect(await fs.stat(path.join(workspaceDir, ".git")).then(() => true, () => false)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);

  it("close 接管收尾后停掉原 timer：慢确认期间无假 timeout、零组终止信号，命令以成功收敛", async () => {
    // 审查探针调度：git 立即退出 0（sh 毫秒级启动，close 恒早于 100ms 预算），
    // 组确认慢于预算（200ms mock）。修复后 close 接管收尾即停掉 timer——
    // 慢确认期间 timeout 不再触发，且全程零 SIGKILL（修复前实现会在收尾期间
    // 触发 timeout 并对组发终止信号）；命令以成功收敛、流程正常推进。
    const fakeBin = path.join(tmpBase, "bin");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const workspaceDir = path.join(tmpBase, "ws-success");
    await fs.mkdir(workspaceDir, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    installSigkillCounter();
    try {
      let thrown: unknown;
      try {
        await bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: "/unused/local/repo",
          workspaceKey: "GH-79",
          timeoutMs: 100,
        });
      } catch (err: unknown) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(RepositoryBootstrapError);
      // 命令（含慢确认）全部成功收敛，流程推进到远端默认分支探测失败。
      expect((thrown as RepositoryBootstrapError).code).toBe("missing_remote_default_branch");
      expect((thrown as RepositoryBootstrapError).code).not.toBe("git_command_timeout");
      // 全程零 SIGKILL：timer 在 close 接管时被停止（审查 Suggestion 断言，
      // 区分「timer 正确停止」与「timeout 触发后被成功覆盖」）。
      expect(sigkillCount).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);
});
