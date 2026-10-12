import * as net from "node:net";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitOperationSupervisor,
  SupervisorGitError,
  scanWithPgrep,
  spawnGitViaSupervisor,
} from "./git-supervisor";

/**
 * 受管 Git 进程组监督者单元测试（NEST-119 A 修订方案）。
 *
 * 覆盖方案要求的监督契约窗口：创建 + 登记先于启动许可、spawn 失败报告、
 * terminate 的组终止与有界确认、请求方（客户端连接）提前退出后监督者仍持有
 * 登记并终止受管组、stopping 拒绝接纳（不静默降级）、非法请求拒绝。
 */

/** 进程是否仍可运行（Linux 僵尸 Z / X 视为已退出）。 */
function isProcessRunning(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      const state = lastParen >= 0 ? stat.slice(lastParen + 2).trimStart().charAt(0) : "";
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForPidFile(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number.parseInt((await fs.readFile(file, "utf8")).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // 尚未写入
    }
    if (Date.now() >= deadline) {
      throw new Error(`PID file was not written within ${timeoutMs}ms: ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function killPidBestEffort(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已退出
  }
}

/** 构造记录自身 PID 后长睡的假 git（经 PATH 注入，模拟 Git 子树）。 */
async function writeSleepyFakeGit(binDir: string, pidFile: string): Promise<void> {
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,
    { mode: 0o755 },
  );
}

/** 等待原始 socket 连接建立。 */
function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** 读取一行 JSON 消息（监督者 → 客户端）。 */
function readLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(buffer.slice(0, newline));
      }
    };
    const onError = (err: Error): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      reject(err);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** 逐行读取直到收到指定类型的消息（跳过其余行）。 */
async function readMessageUntil(socket: net.Socket, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const line = await readLine(socket);
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === type) {
      return message;
    }
  }
}

/** 构造「根 spawn 同组 leaf（stdio ignore）后立即退出」的假 git（复审探针调度）。 */
async function writeForkingFakeGit(
  binDir: string,
  files: { rootPidFile: string; leafPidFile: string; markerFile: string; markerDelayMs: number },
): Promise<void> {
  await fs.mkdir(binDir, { recursive: true });
  const leafScript = path.join(binDir, "leaf.cjs");
  await fs.writeFile(
    leafScript,
    `const fs = require("node:fs");\n` +
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(files.markerFile)}, "late", "utf8"), ${files.markerDelayMs});\n` +
      `setInterval(() => {}, 5000);\n`,
  );
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const { spawn } = require("node:child_process");\n` +
      `fs.writeFileSync(${JSON.stringify(files.rootPidFile)}, String(process.pid));\n` +
      `const leaf = spawn(process.execPath, [${JSON.stringify(leafScript)}], { stdio: "ignore" });\n` +
      `fs.writeFileSync(${JSON.stringify(files.leafPidFile)}, String(leaf.pid));\n` +
      `// 子进程句柄会撑住事件循环，必须显式退出以模拟「根先退出、leaf 重挂父」。\n` +
      `process.exit(0);\n`,
    { mode: 0o755 },
  );
}

describe("GitOperationSupervisor (NEST-119 A 修订方案)", () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-git-supervisor-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("spawn 经监督者创建并登记后授予启动许可，exit 报告携带退出码与输出", async () => {
    const supervisor = await GitOperationSupervisor.start();
    try {
      const result = await spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
        cwd: tmpBase,
        env: process.env,
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("git version");
    } finally {
      await supervisor.dispose();
    }
  }, 15_000);

  it("git 无法 spawn（ENOENT）时报告 spawn_failed，不静默降级", async () => {
    const supervisor = await GitOperationSupervisor.start();
    try {
      await expect(
        spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
          cwd: tmpBase,
          env: { ...process.env, PATH: "/definitely-not-exist" },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "spawn_failed", errno: "ENOENT" });
    } finally {
      await supervisor.dispose();
    }
  }, 15_000);

  it("cwd 不存在或非目录时拒绝启动（invalid_cwd）", async () => {
    const supervisor = await GitOperationSupervisor.start();
    try {
      await expect(
        spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
          cwd: path.join(tmpBase, "missing-dir"),
          env: process.env,
          timeoutMs: 5_000,
        }),
      ).rejects.toBeInstanceOf(SupervisorGitError);
    } finally {
      await supervisor.dispose();
    }
  }, 15_000);

  it("超时 terminate 触发组终止，exit 报告携带 cleanupConfirmed，受管进程真实退出", async () => {
    const binDir = path.join(tmpBase, "bin");
    const pidFile = path.join(tmpBase, "sleepy-git.pid");
    await writeSleepyFakeGit(binDir, pidFile);
    const supervisor = await GitOperationSupervisor.start();
    let pid: number | undefined;
    try {
      const promise = spawnGitViaSupervisor(supervisor.socketPath, ["fetch", "origin"], {
        cwd: tmpBase,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        timeoutMs: 2_000,
      });
      let err: unknown;
      try {
        await promise;
        expect.fail("should have timed out");
      } catch (caught: unknown) {
        err = caught;
      }
      expect(err).toBeInstanceOf(SupervisorGitError);
      const supervisorError = err as SupervisorGitError;
      expect(supervisorError.code).toBe("timeout");
      expect(supervisorError.cleanupConfirmed).toBe(true);

      pid = await waitForPidFile(pidFile, 3_000);
      expect(await waitForProcessGone(pid, 3_000)).toBe(true);
    } finally {
      if (pid === undefined) {
        try {
          pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
          if (!Number.isInteger(pid) || pid <= 0) {
            pid = undefined;
          }
        } catch {
          pid = undefined;
        }
      }
      killPidBestEffort(pid);
      await supervisor.dispose();
    }
  }, 15_000);

  it("请求方（客户端连接）提前退出后，登记保留在监督者并由其终止受管组", async () => {
    const binDir = path.join(tmpBase, "bin");
    const pidFile = path.join(tmpBase, "orphan-git.pid");
    await writeSleepyFakeGit(binDir, pidFile);
    const supervisor = await GitOperationSupervisor.start();
    let pid: number | undefined;
    try {
      const socket = await connect(supervisor.socketPath);
      socket.write(
        `${JSON.stringify({
          op: "spawn",
          id: "orphan-op",
          argv: ["git", "fetch", "origin"],
          cwd: tmpBase,
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
        })}\n`,
      );
      const spawned = JSON.parse(await readLine(socket)) as { type: string };
      expect(spawned.type).toBe("spawned");

      pid = await waitForPidFile(pidFile, 3_000);

      // 请求方死亡：连接断开。登记仍由监督者持有（不依赖 PPID），受管组被终止。
      socket.destroy();
      expect(await waitForProcessGone(pid, 5_000)).toBe(true);

      // 监督者仍可用：新的受管操作正常执行。
      const result = await spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
        cwd: tmpBase,
        env: process.env,
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      killPidBestEffort(pid);
      await supervisor.dispose();
    }
  }, 15_000);

  it("stopAccepting 后拒绝新 spawn（不静默降级为未登记的独立组）", async () => {
    const supervisor = await GitOperationSupervisor.start();
    try {
      supervisor.stopAccepting();
      const err = await spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
        cwd: tmpBase,
        env: process.env,
        timeoutMs: 5_000,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(SupervisorGitError);
      expect((err as SupervisorGitError).code).toBe("refused");
    } finally {
      await supervisor.dispose();
    }
  }, 15_000);

  it("pgrep 无匹配（exit 1）按成功空结果处理，不误报 queryFailed", async () => {
    // 复审 blocker：BSD pgrep 退出码 1 = 无匹配，不是查询故障。
    // 选用几乎不可能存在的 PGID，触发「无匹配」分支。
    const result = await scanWithPgrep([999_999_999], Date.now() + 5_000);
    expect(result.queryFailed).toBe(false);
    expect(result.leftoverPids).toHaveLength(0);
  }, 15_000);

  it("pgrep 查询自身失败（不可执行）按 queryFailed 处理，不得宣称确认", async () => {
    const emptyBin = path.join(tmpBase, "empty-bin");
    await fs.mkdir(emptyBin, { recursive: true });
    const result = await scanWithPgrep([999_999_998], Date.now() + 5_000, emptyBin);    expect(result.queryFailed).toBe(true);
  }, 15_000);

  it("根正常退出且组无残留成员：确认后释放 ownership（terminateAll requested=0）", async () => {
    const supervisor = await GitOperationSupervisor.start();
    try {
      const result = await spawnGitViaSupervisor(supervisor.socketPath, ["--version"], {
        cwd: tmpBase,
        env: process.env,
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      // 自然 close 已完成组确认并解除登记：后续 terminateAll 不再看到该组。
      const report = await supervisor.terminateAll(2_000);
      expect(report.requested).toBe(0);
      expect(report.exitConfirmed).toBe(true);
    } finally {
      await supervisor.dispose();
    }
  }, 15_000);

  it("根先正常退出、同组 leaf 重挂父仍存活：请求方断开后监督者收尾清理", async () => {
    const binDir = path.join(tmpBase, "bin-fork");
    const rootPidFile = path.join(tmpBase, "fork-root.pid");
    const leafPidFile = path.join(tmpBase, "fork-leaf.pid");
    const markerFile = path.join(tmpBase, "fork-late.marker");
    await writeForkingFakeGit(binDir, {
      rootPidFile,
      leafPidFile,
      markerFile,
      markerDelayMs: 1_500,
    });
    const supervisor = await GitOperationSupervisor.start();
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    let leafPid: number | undefined;
    try {
      const socket = await connect(supervisor.socketPath);
      socket.write(
        `${JSON.stringify({
          op: "spawn",
          id: "fork-op",
          argv: ["git", "fetch", "origin"],
          cwd: tmpBase,
          env,
        })}\n`,
      );
      const spawned = await readMessageUntil(socket, "spawned");
      expect(spawned.type).toBe("spawned");
      // exit 报告只在自然 close 的组确认（本例：leaf 仍存活 → ownership 保留）后发出。
      const exit = await readMessageUntil(socket, "exit");
      expect(exit.type).toBe("exit");
      expect(exit.cleanupConfirmed).toBe(false);

      leafPid = await waitForPidFile(leafPidFile, 3_000);

      // 请求方退出 → 监督者对已退出未释放的组做防误杀收尾。
      socket.destroy();
      expect(await waitForProcessGone(leafPid, 5_000)).toBe(true);

      // 等过 leaf 原本的迟到写入时刻，确认无迟到副作用。
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      expect(
        await fs.readFile(markerFile, "utf8").then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      killPidBestEffort(leafPid);
      await supervisor.dispose();
    }
  }, 15_000);

  it("根先正常退出、同组 leaf 重挂父仍存活：外层超时 terminateAll 收敛（复审探针场景）", async () => {
    const binDir = path.join(tmpBase, "bin-fork-teardown");
    const rootPidFile = path.join(tmpBase, "fork-teardown-root.pid");
    const leafPidFile = path.join(tmpBase, "fork-teardown-leaf.pid");
    const markerFile = path.join(tmpBase, "fork-teardown-late.marker");
    await writeForkingFakeGit(binDir, {
      rootPidFile,
      leafPidFile,
      markerFile,
      markerDelayMs: 1_500,
    });
    const supervisor = await GitOperationSupervisor.start();
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    let leafPid: number | undefined;
    let socket: net.Socket | undefined;
    try {
      // 裸 socket 保持连接（模拟 CLI 尚未退出、外层超时未到）：
      // exit 报告到达时 ownership 仍保留在监督者。
      socket = await connect(supervisor.socketPath);
      socket.write(
        `${JSON.stringify({
          op: "spawn",
          id: "fork-teardown-op",
          argv: ["git", "fetch", "origin"],
          cwd: tmpBase,
          env,
        })}\n`,
      );
      const spawned = await readMessageUntil(socket, "spawned");
      expect(spawned.type).toBe("spawned");
      const exit = await readMessageUntil(socket, "exit");
      expect(exit.cleanupConfirmed).toBe(false);

      leafPid = await waitForPidFile(leafPidFile, 3_000);
      // leaf 尚未被清理（连接仍在、无收尾触发）——ownership 保留在监督者。
      expect(isProcessRunning(leafPid)).toBe(true);

      const report = await supervisor.terminateAll(2_000);
      expect(report.requested).toBe(1);
      expect(report.exitConfirmed).toBe(true);
      expect(await waitForProcessGone(leafPid, 2_000)).toBe(true);

      // 等过 leaf 原本的迟到写入时刻，确认无迟到副作用。
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      expect(
        await fs.readFile(markerFile, "utf8").then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      socket?.destroy();
      killPidBestEffort(leafPid);
      await supervisor.dispose();
    }
  }, 15_000);

  it("根先正常退出、同组 leaf 仍存活：dispose 兜底清理", async () => {
    const binDir = path.join(tmpBase, "bin-fork-dispose");
    const rootPidFile = path.join(tmpBase, "fork-dispose-root.pid");
    const leafPidFile = path.join(tmpBase, "fork-dispose-leaf.pid");
    const markerFile = path.join(tmpBase, "fork-dispose-late.marker");
    await writeForkingFakeGit(binDir, {
      rootPidFile,
      leafPidFile,
      markerFile,
      markerDelayMs: 1_500,
    });
    const supervisor = await GitOperationSupervisor.start();
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    let leafPid: number | undefined;
    let socket: net.Socket | undefined;
    try {
      socket = await connect(supervisor.socketPath);
      socket.write(
        `${JSON.stringify({
          op: "spawn",
          id: "fork-dispose-op",
          argv: ["git", "fetch", "origin"],
          cwd: tmpBase,
          env,
        })}\n`,
      );
      await readMessageUntil(socket, "spawned");
      await readMessageUntil(socket, "exit");
      leafPid = await waitForPidFile(leafPidFile, 3_000);
      expect(isProcessRunning(leafPid)).toBe(true);

      await supervisor.dispose();
      expect(await waitForProcessGone(leafPid, 5_000)).toBe(true);
    } finally {
      socket?.destroy();
      killPidBestEffort(leafPid);
    }
  }, 15_000);

  it("terminateAll 在有界窗口内确认全部受管组退出", async () => {
    const pidFileA = path.join(tmpBase, "sleepy-a.pid");
    const pidFileB = path.join(tmpBase, "sleepy-b.pid");
    await writeSleepyFakeGit(path.join(tmpBase, "bin-a"), pidFileA);
    await writeSleepyFakeGit(path.join(tmpBase, "bin-b"), pidFileB);
    const supervisor = await GitOperationSupervisor.start();
    const env = { ...process.env };
    const clientSettled: Array<"resolved" | "rejected"> = [];
    const clientErrors: unknown[] = [];
    const pids: Array<number | undefined> = [];
    try {
      // 两个并发受管操作（各自独立的假 git bin，避免脚本互相覆盖）；客户端不
      // 主动 terminate（60s 预算），由 terminateAll 统一收尾。客户端此后随
      // exit 报告正常收敛（外部终止映射为非零退出）。
      const binDirs = [path.join(tmpBase, "bin-a"), path.join(tmpBase, "bin-b")];
      for (const binDir of binDirs) {
        void spawnGitViaSupervisor(supervisor.socketPath, ["fetch", "origin"], {
          cwd: tmpBase,
          env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH ?? ""}` },
          timeoutMs: 60_000,
        }).then(
          () => {
            clientSettled.push("resolved");
          },
          (err: unknown) => {
            clientSettled.push("rejected");
            clientErrors.push(err);
          },
        );
      }
      const pidA = await waitForPidFile(pidFileA, 3_000);
      const pidB = await waitForPidFile(pidFileB, 3_000);
      pids.push(pidA, pidB);

      const report = await supervisor.terminateAll(2_000);
      expect(report.requested).toBe(2);
      expect(report.exitConfirmed).toBe(true);
      expect(await waitForProcessGone(pidA, 2_000)).toBe(true);
      expect(await waitForProcessGone(pidB, 2_000)).toBe(true);

      // 客户端不悬挂：随 exit 报告收敛（外部终止按非零退出语义）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(clientSettled).toHaveLength(2);
      expect(clientSettled.every((s) => s === "resolved")).toBe(true);
    } finally {
      for (const pid of pids) {
        killPidBestEffort(pid);
      }
      await supervisor.dispose();
    }
  }, 15_000);
});
