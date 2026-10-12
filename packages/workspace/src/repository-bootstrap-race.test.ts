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

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-bootstrap-race-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  /** 写一个按 argv1 延迟后退出 0 的假 git。 */
  async function writeDelayedFakeGit(exitDelayMs: number): Promise<void> {
    const fakeBin = path.join(tmpBase, "bin");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
      path.join(fakeBin, "git"),
      `#!${process.execPath}\nsetTimeout(() => process.exit(0), ${exitDelayMs});\n`,
      { mode: 0o755 },
    );
    return;
  }

  it("timer 先触发（执行中超时）时，close 收尾不得把 typed git_command_timeout 翻成成功", async () => {
    // git 300ms 后才退出（timeout=50ms 先触发，收敛流程 kill 组并等待 close）；
    // close 到达时收尾流程已持有 settle 权，慢确认（200ms mock）不改变结果。
    await writeDelayedFakeGit(300);
    const workspaceDir = path.join(tmpBase, "ws-timeout");
    await fs.mkdir(workspaceDir, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${path.join(tmpBase, "bin")}${path.delimiter}${originalPath ?? ""}`;
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
      // 后续命令不得被迟到成功推进。
      expect(await fs.stat(path.join(workspaceDir, ".git")).then(() => true, () => false)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);

  it("close 接管收尾后停掉原 timer：慢确认期间不产生假 timeout，命令以成功收敛", async () => {
    // 审查探针调度：git 立即退出 0，组确认慢于 timeout=100ms。修复后 close
    // 接管收尾即停掉 timer——后续的慢确认期间 timeout 不再触发，命令以成功
    // 收敛（bootstrap 推进到默认分支探测失败为止，全程无 git_command_timeout）。
    await writeDelayedFakeGit(0);
    const workspaceDir = path.join(tmpBase, "ws-success");
    await fs.mkdir(workspaceDir, { recursive: true });

    const originalPath = process.env.PATH;
    process.env.PATH = `${path.join(tmpBase, "bin")}${path.delimiter}${originalPath ?? ""}`;
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
      // 命令（含慢确认）全部成功收敛，流程推进到远端默认分支探测失败；
      // 修复前此调度会让 timer 在收尾期间触发并被迟到成功覆盖。
      expect((thrown as RepositoryBootstrapError).code).toBe("missing_remote_default_branch");
      expect((thrown as RepositoryBootstrapError).code).not.toBe("git_command_timeout");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);
});
