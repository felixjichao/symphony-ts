import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HooksConfig, Workspace } from "@symphony/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceManager,
  HOOK_OUTPUT_EXCERPT_LIMIT,
  WorkspaceError,
  type RemoveWorkspaceResult,
  type WorkspaceHookEvent,
  type WorkspaceHookEventSink,
  type WorkspaceManager,
} from "./index";

/**
 * #29 / M3.3 workspace lifecycle hooks + safe cleanup 测试
 * （SPEC §5.3.4 / §8.6 / §9.4 / §15.4 / §17.2）。
 *
 * 遵循 docs/testing.md 三哲学：**真实 shell subprocess**（`sh -lc`，不 mock hook
 * runner）、**真实临时文件系统**（不 mock fs）、经包的唯一公共 API 面 `index.ts`
 * 进入（createWorkspaceManager → createWorkspace / runBeforeRunHook /
 * runAfterRunHook / removeWorkspace）。断言「重读世界」——目录 / marker 文件的
 * 真实存在性，而非被测代码的自述。验收映射见 #29 验收 1–7。
 */

// symlink 能力探测：host 不支持创建 symlink 时相关用例经 describe.skipIf 显式 skip
// （vitest 报告可见 skipped），绝不静默 pass（与 path-safety.test.ts 同惯例）。
const symlinkSupport = (() => {
  let probeDir: string | null = null;
  try {
    probeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "sym-hook-symlink-probe-"));
    fsSync.symlinkSync(probeDir, path.join(probeDir, "probe"), "dir");
    return { supported: true as const, reason: "" };
  } catch (err: unknown) {
    return {
      supported: false as const,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (probeDir !== null) {
      try {
        fsSync.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // ignore probe cleanup errors
      }
    }
  }
})();

/** 构造一个 effective HooksConfig（调用时传入；默认全 null + 60s timeout）。 */
function hooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** operator 事件收集器（callback 契约）。 */
function eventCollector(): { events: WorkspaceHookEvent[]; sink: WorkspaceHookEventSink } {
  const events: WorkspaceHookEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 断言抛出 WorkspaceError 且 code 匹配，返回该错误。 */
async function expectWorkspaceError(
  promise: Promise<unknown>,
  code: WorkspaceError["code"],
): Promise<WorkspaceError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkspaceError);
  const wsErr = caught as WorkspaceError;
  expect(wsErr.code).toBe(code);
  return wsErr;
}

describe("workspace lifecycle hooks + safe cleanup（SPEC §9.4 / §15.4 / §17.2，#29）", () => {
  let tmpRoot: string;
  let root: string;
  let outside: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sym-hooks-test-"));
    root = path.join(tmpRoot, "workspaces");
    outside = path.join(tmpRoot, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    manager = createWorkspaceManager({ workspace: { root } });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in test teardown
    }
  });

  it("symlink 能力探测结果显式可见（不支持时相关用例为显式 skip）", () => {
    expect(typeof symlinkSupport.supported).toBe("boolean");
    if (!symlinkSupport.supported) {
      console.warn(
        `[hooks] host 不支持创建 symlink，相关用例显式 skip：${symlinkSupport.reason}`,
      );
    }
  });

  describe("hook runner 执行层（验收 1 / 2：cwd、multiline、non-zero、timeout、effective timeoutMs）", () => {
    it("验收 1：hook 实际 cwd === workspace path（在 cwd 落地文件 + pwd -P 实证）", async () => {
      const ws = await manager.createWorkspace("CWD-1");
      // script 在 cwd 写文件；只有 cwd 真的是 workspace 时文件才落在 workspace 内
      const script = `pwd -P > pwd.txt\ntouch created_in_cwd.txt\n`;
      await manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: script }) });

      const createdInCwd = path.join(ws.path, "created_in_cwd.txt");
      expect(await pathExists(createdInCwd)).toBe(true);

      const pwdContent = (await fs.readFile(path.join(ws.path, "pwd.txt"), "utf8")).trim();
      expect(pwdContent).toBe(await fs.realpath(ws.path));
    });

    it("multiline shell 脚本按序执行（sh -lc 接收整段多行脚本）", async () => {
      const ws = await manager.createWorkspace("MULTILINE-1");
      const script = [
        `echo line1 > multi.txt`,
        `echo line2 >> multi.txt`,
        `printf 'line3\\n' >> multi.txt`,
      ].join("\n");
      await manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: script }) });

      const content = await fs.readFile(path.join(ws.path, "multi.txt"), "utf8");
      expect(content.trim().split("\n")).toEqual(["line1", "line2", "line3"]);
    });

    it("non-zero exit → 抛 hook_execution_failed（fatal），事件 outcome=failed 且携带 exitCode", async () => {
      const ws = await manager.createWorkspace("NONZERO-1");
      const { events, sink } = eventCollector();

      const err = await expectWorkspaceError(
        manager.runBeforeRunHook(ws, {
          hooks: hooks({ beforeRun: "echo oops >&2; exit 3" }),
          identifier: "NONZERO-1",
          onHookEvent: sink,
        }),
        "hook_execution_failed",
      );
      expect(err.workspaceKey).toBe("NONZERO-1");
      expect(err.identifier).toBe("NONZERO-1");

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.hook).toBe("before_run");
      expect(event.workspacePath).toBe(ws.path);
      expect(event.identifier).toBe("NONZERO-1");
      expect(event.outcome).toBe("failed");
      expect(event.exitCode).toBe(3);
    });

    it("timeout → 抛 hook_timeout，终止整个进程组（孙进程不留孤儿、marker 永不出现），无残留 handle", async () => {
      const ws = await manager.createWorkspace("TIMEOUT-1");
      const orphanMarker = path.join(tmpRoot, "orphan-marker.txt");
      // 后台孙进程延时 600ms 写 marker；主进程 sleep 5s。timeout=150ms 时整组被 SIGKILL。
      const script = `( sleep 0.6 && printf orphan > "${orphanMarker}" ) &\nsleep 5\n`;
      const { events, sink } = eventCollector();

      await expectWorkspaceError(
        manager.runBeforeRunHook(ws, {
          hooks: hooks({ beforeRun: script, timeoutMs: 150 }),
          identifier: "TIMEOUT-1",
          onHookEvent: sink,
        }),
        "hook_timeout",
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("timeout");
      expect(events[0]!.hook).toBe("before_run");

      // 等待超过孙进程原本写 marker 的时刻，断言进程组确被终止（marker 永不出现）
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await pathExists(orphanMarker)).toBe(false);
    });

    it("验收 2：timeout 使用调用时传入的当前 effective timeoutMs（无内部旧值缓存）", async () => {
      const ws = await manager.createWorkspace("TIMEOUT-CFG-1");
      const script = "sleep 0.3\n";

      // 调用 1：长 timeout（2000ms）→ sleep 0.3 在时限内完成 → 成功（证明用了 2000 而非小值）
      await manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: script, timeoutMs: 2000 }) });

      // 调用 2：短 timeout（120ms）→ 同一 sleep 0.3 超时（证明用了本次的 120 而非缓存的 2000）
      await expectWorkspaceError(
        manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: script, timeoutMs: 120 }) }),
        "hook_timeout",
      );
    });

    it("输出捕获有硬上限：无界刷屏被截断，事件 outputTruncated=true 且摘录受界", async () => {
      const ws = await manager.createWorkspace("TRUNCATE-1");
      // 向 stderr 灌 ~2MB，远超捕获上限；随后非零退出触发事件
      const script = `head -c 2000000 /dev/zero | tr '\\0' 'x' >&2\nexit 1\n`;
      const { events, sink } = eventCollector();

      await expectWorkspaceError(
        manager.runBeforeRunHook(ws, {
          hooks: hooks({ beforeRun: script }),
          onHookEvent: sink,
        }),
        "hook_execution_failed",
      );

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.outputTruncated).toBe(true);
      expect((event.output ?? "").length).toBeLessThanOrEqual(HOOK_OUTPUT_EXCERPT_LIMIT + 32);
    });

    it("未配置脚本（null）→ no-op 成功，不 spawn、不发事件", async () => {
      const ws = await manager.createWorkspace("NULL-HOOK-1");
      const { events, sink } = eventCollector();
      // beforeRun = null → no-op
      await manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: null }), onHookEvent: sink });
      expect(events).toHaveLength(0);
    });
  });

  describe("after_create（验收 3：仅新建执行、失败只清理新建目录、复用绝不打扰）", () => {
    it("createdNow=true 时执行 after_create（marker 落地），provisioning 成功", async () => {
      const ws = await manager.createWorkspace("AC-1", {
        hooks: hooks({ afterCreate: "touch after_create_ran.txt" }),
      });
      expect(ws.createdNow).toBe(true);
      expect(await pathExists(path.join(ws.path, "after_create_ran.txt"))).toBe(true);
      expect((await fs.lstat(ws.path)).isDirectory()).toBe(true);
    });

    it("复用目录（createdNow=false）不运行 after_create，且既有内容分毫不动", async () => {
      const first = await manager.createWorkspace("AC-REUSE-1", {
        hooks: hooks({ afterCreate: "touch first_marker.txt" }),
      });
      expect(first.createdNow).toBe(true);
      expect(await pathExists(path.join(first.path, "first_marker.txt"))).toBe(true);

      // 再次创建：复用；after_create 配了一个会失败也会写 marker 的脚本，但绝不应运行
      const second = await manager.createWorkspace("AC-REUSE-1", {
        hooks: hooks({ afterCreate: "touch second_marker.txt; exit 1" }),
      });
      expect(second.createdNow).toBe(false);
      expect(second.path).toBe(first.path);
      // 复用时 after_create 未运行：second_marker 不存在
      expect(await pathExists(path.join(first.path, "second_marker.txt"))).toBe(false);
      // 既有内容完好
      expect(await pathExists(path.join(first.path, "first_marker.txt"))).toBe(true);
    });

    it("after_create non-zero → 抛 hook_execution_failed，且 best-effort 删除本次新建的半成品目录", async () => {
      let caughtPath = "";
      const err = await expectWorkspaceError(
        (async () => {
          const ws = await manager.createWorkspace("AC-FAIL-1", {
            hooks: hooks({ afterCreate: "touch partial.txt; exit 7" }),
          });
          caughtPath = ws.path;
        })(),
        "hook_execution_failed",
      );
      // 半成品目录已被清理（重读世界：路径不存在）
      const target = err.path ?? caughtPath;
      expect(target.length).toBeGreaterThan(0);
      expect(await pathExists(target)).toBe(false);
    });

    it("after_create timeout → 抛 hook_timeout，且清理本次新建目录", async () => {
      const err = await expectWorkspaceError(
        manager.createWorkspace("AC-TIMEOUT-1", {
          hooks: hooks({ afterCreate: "sleep 5", timeoutMs: 150 }),
        }),
        "hook_timeout",
      );
      expect(err.path).toBeDefined();
      expect(await pathExists(err.path!)).toBe(false);
    });

    it("无 hooks 选项时 createWorkspace 行为与 M3.1 一致（不运行 hook、正常创建）", async () => {
      const ws = await manager.createWorkspace("AC-NOHOOKS-1");
      expect(ws.createdNow).toBe(true);
      expect((await fs.lstat(ws.path)).isDirectory()).toBe(true);
    });

    describe.skipIf(!symlinkSupport.supported)(
      "after_create 失败清理同样过 containment 校验（symlink 逃逸拒删）",
      () => {
        it("after_create 把新建目录替换成指向 root 外的 symlink 后失败 → 清理拒删，root 外目标不被触碰", async () => {
          const outsideTarget = path.join(outside, "precious");
          await fs.mkdir(outsideTarget);
          await fs.writeFile(path.join(outsideTarget, "keep.txt"), "do-not-delete");

          const wsPath = manager.resolveWorkspacePath("AC-SYMLINK-1");
          const key = path.basename(wsPath);
          // after_create：把自身目录换成指向 outside 的 symlink，然后失败
          const script = `cd "${root}" && rm -rf "${key}" && ln -s "${outsideTarget}" "${key}" && exit 1`;

          await expectWorkspaceError(
            manager.createWorkspace("AC-SYMLINK-1", { hooks: hooks({ afterCreate: script }) }),
            "hook_execution_failed",
          );

          // best-effort 清理重验后拒删：symlink 仍在、root 外目标完好无损
          const linkStat = await fs.lstat(wsPath);
          expect(linkStat.isSymbolicLink()).toBe(true);
          expect(await fs.readFile(path.join(outsideTarget, "keep.txt"), "utf8")).toBe(
            "do-not-delete",
          );
        });
      },
    );
  });

  describe("before_run（验收 4：每 attempt 显式调用、failure/timeout 可判别 fatal、不调度 retry）", () => {
    it("每次调用恰好运行一次（无内建 retry / 多次执行）", async () => {
      const ws = await manager.createWorkspace("BR-1");
      const counter = path.join(ws.path, "before.txt");
      const options = { hooks: hooks({ beforeRun: `echo run >> "${counter}"` }) };

      await manager.runBeforeRunHook(ws, options);
      await manager.runBeforeRunHook(ws, options);

      const lines = (await fs.readFile(counter, "utf8")).trim().split("\n");
      expect(lines).toEqual(["run", "run"]);
    });

    it("failure 抛可判别 fatal 错误，供 M4 中止当前 attempt", async () => {
      const ws = await manager.createWorkspace("BR-FAIL-1");
      await expectWorkspaceError(
        manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: "exit 1" }) }),
        "hook_execution_failed",
      );
    });

    it("timeout 抛可判别 fatal hook_timeout", async () => {
      const ws = await manager.createWorkspace("BR-TIMEOUT-1");
      await expectWorkspaceError(
        manager.runBeforeRunHook(ws, { hooks: hooks({ beforeRun: "sleep 5", timeoutMs: 120 }) }),
        "hook_timeout",
      );
    });

    it("spawn failure（cwd 不存在）→ hook_execution_failed（非零 / 超时之外的 failed 路径）", async () => {
      // 安全但尚未创建的路径：assertWorkspacePathSafe 通过（exists:false），
      // spawn 以不存在的 cwd 触发子进程 'error'（ENOENT）→ outcome failed。
      const ghost: Workspace = {
        path: path.join(root, "GHOST-SPAWN-1"),
        workspaceKey: "GHOST-SPAWN-1",
        createdNow: false,
      };
      const { events, sink } = eventCollector();
      await expectWorkspaceError(
        manager.runBeforeRunHook(ghost, {
          hooks: hooks({ beforeRun: "echo hi" }),
          onHookEvent: sink,
        }),
        "hook_execution_failed",
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("failed");
    });

    describe.skipIf(!symlinkSupport.supported)("spawn 前安全重验", () => {
      it("workspace path 为逃逸 symlink → 抛 unsafe_path（fatal，不执行 shell）", async () => {
        const outsideTarget = path.join(outside, "br-target");
        await fs.mkdir(outsideTarget);
        const wsPath = path.join(root, "BR-UNSAFE-1");
        await fs.symlink(outsideTarget, wsPath, "dir");
        const fakeWorkspace: Workspace = {
          path: wsPath,
          workspaceKey: "BR-UNSAFE-1",
          createdNow: false,
        };

        const err = await expectWorkspaceError(
          manager.runBeforeRunHook(fakeWorkspace, { hooks: hooks({ beforeRun: "touch pwned.txt" }) }),
          "unsafe_path",
        );
        expect(err.unsafeReason).toBe("workspace_symlink_escape");
        // shell 从未在 unsafe 路径执行
        expect(await pathExists(path.join(outsideTarget, "pwned.txt"))).toBe(false);
      });
    });
  });

  describe("after_run（验收 5：best-effort 永不 throw、不覆盖 attempt outcome、失败可见）", () => {
    it("success → 正常返回，不发事件", async () => {
      const ws = await manager.createWorkspace("AR-OK-1");
      const { events, sink } = eventCollector();
      await manager.runAfterRunHook(ws, {
        hooks: hooks({ afterRun: "touch after_ok.txt" }),
        onHookEvent: sink,
      });
      expect(await pathExists(path.join(ws.path, "after_ok.txt"))).toBe(true);
      expect(events).toHaveLength(0);
    });

    it("failure → 调用仍正常返回（不 throw、不改写 outcome），但产生 operator-visible 事件", async () => {
      const ws = await manager.createWorkspace("AR-FAIL-1");
      const { events, sink } = eventCollector();
      // 不 throw：public best-effort 调用最终成功返回
      await manager.runAfterRunHook(ws, {
        hooks: hooks({ afterRun: "echo bad >&2; exit 9" }),
        identifier: "AR-FAIL-1",
        onHookEvent: sink,
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.hook).toBe("after_run");
      expect(events[0]!.outcome).toBe("failed");
      expect(events[0]!.identifier).toBe("AR-FAIL-1");
      expect(events[0]!.exitCode).toBe(9);
    });

    it("timeout → 调用仍正常返回，产生 timeout 事件", async () => {
      const ws = await manager.createWorkspace("AR-TIMEOUT-1");
      const { events, sink } = eventCollector();
      await manager.runAfterRunHook(ws, {
        hooks: hooks({ afterRun: "sleep 5", timeoutMs: 120 }),
        onHookEvent: sink,
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("timeout");
    });

    it("未配置 after_run → no-op 正常返回", async () => {
      const ws = await manager.createWorkspace("AR-NULL-1");
      await manager.runAfterRunHook(ws, { hooks: hooks({ afterRun: null }) });
    });

    describe.skipIf(!symlinkSupport.supported)("unsafe 路径 best-effort", () => {
      it("workspace path 为逃逸 symlink → 不 throw、不执行 shell，发 failed 事件说明 skipped", async () => {
        const outsideTarget = path.join(outside, "ar-target");
        await fs.mkdir(outsideTarget);
        const wsPath = path.join(root, "AR-UNSAFE-1");
        await fs.symlink(outsideTarget, wsPath, "dir");
        const fakeWorkspace: Workspace = {
          path: wsPath,
          workspaceKey: "AR-UNSAFE-1",
          createdNow: false,
        };
        const { events, sink } = eventCollector();

        await manager.runAfterRunHook(fakeWorkspace, {
          hooks: hooks({ afterRun: "touch pwned.txt" }),
          onHookEvent: sink,
        });

        expect(events).toHaveLength(1);
        expect(events[0]!.outcome).toBe("failed");
        expect(events[0]!.message).toContain("safety re-verification");
        expect(await pathExists(path.join(outsideTarget, "pwned.txt"))).toBe(false);
      });
    });
  });

  describe("before_remove + cleanup（验收 6 / 7：best-effort hook、containment、幂等、可判别结果）", () => {
    it("existing 目录：运行 before_remove 后删除 → status removed，目录消失", async () => {
      const ws = await manager.createWorkspace("RM-1");
      const beforeMarker = path.join(tmpRoot, "before_remove_ran.txt");
      const result = await manager.removeWorkspace("RM-1", {
        hooks: hooks({ beforeRemove: `printf ran > "${beforeMarker}"` }),
      });

      expect(result.status).toBe("removed");
      expect(await pathExists(ws.path)).toBe(false);
      expect(await pathExists(beforeMarker)).toBe(true);
    });

    it("before_remove failure → operator 事件，但 cleanup 继续（status removed，目录仍被删）", async () => {
      const ws = await manager.createWorkspace("RM-FAIL-1");
      const { events, sink } = eventCollector();
      const result = await manager.removeWorkspace("RM-FAIL-1", {
        hooks: hooks({ beforeRemove: "echo cleanup-prep-failed >&2; exit 1" }),
        onHookEvent: sink,
      });

      expect(result.status).toBe("removed");
      expect(await pathExists(ws.path)).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]!.hook).toBe("before_remove");
      expect(events[0]!.outcome).toBe("failed");
    });

    it("before_remove timeout → operator 事件，但 cleanup 继续（status removed）", async () => {
      const ws = await manager.createWorkspace("RM-TIMEOUT-1");
      const { events, sink } = eventCollector();
      const result = await manager.removeWorkspace("RM-TIMEOUT-1", {
        hooks: hooks({ beforeRemove: "sleep 5", timeoutMs: 130 }),
        onHookEvent: sink,
      });

      expect(result.status).toBe("removed");
      expect(await pathExists(ws.path)).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("timeout");
    });

    it("missing workspace → 幂等成功（status missing），不运行 before_remove", async () => {
      const beforeMarker = path.join(tmpRoot, "should_not_run.txt");
      const result1 = await manager.removeWorkspace("RM-MISSING-1", {
        hooks: hooks({ beforeRemove: `printf ran > "${beforeMarker}"` }),
      });
      const result2 = await manager.removeWorkspace("RM-MISSING-1");

      expect(result1.status).toBe("missing");
      expect(result2.status).toBe("missing");
      expect(await pathExists(beforeMarker)).toBe(false);
    });

    it("无 hooks 选项也能删除（before_remove 不运行）", async () => {
      const ws = await manager.createWorkspace("RM-NOHOOKS-1");
      const result = await manager.removeWorkspace("RM-NOHOOKS-1");
      expect(result.status).toBe("removed");
      expect(await pathExists(ws.path)).toBe(false);
    });

    it("非法 identifier → 抛 invalid_identifier（输入校验，与 createWorkspace 一致）", async () => {
      await expectWorkspaceError(manager.removeWorkspace(""), "invalid_identifier");
    });

    it("非目录对象（regular file）在 workspace 路径 → refused existing_non_directory，文件不被删除", async () => {
      const wsPath = manager.resolveWorkspacePath("RM-FILE-1");
      await fs.writeFile(wsPath, "precious-user-data");

      const result = await manager.removeWorkspace("RM-FILE-1", {
        hooks: hooks({ beforeRemove: "touch should_not_run.txt" }),
      });

      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("existing_non_directory");
      }
      // Fail Safely：文件完好，未被删除
      const stat = await fs.lstat(wsPath);
      expect(stat.isFile()).toBe(true);
      expect(await fs.readFile(wsPath, "utf8")).toBe("precious-user-data");
    });

    describe.skipIf(!symlinkSupport.supported)("containment：unsafe / out-of-root target 拒绝删除（验收 7）", () => {
      it("workspace path 为指向 root 外的 symlink → refused，不运行 hook、symlink 与 root 外目标均不被触碰", async () => {
        const outsideTarget = path.join(outside, "victim");
        await fs.mkdir(outsideTarget);
        await fs.writeFile(path.join(outsideTarget, "important.txt"), "keep-me");

        const wsPath = path.join(root, "RM-UNSAFE-1");
        await fs.symlink(outsideTarget, wsPath, "dir");
        const beforeMarker = path.join(tmpRoot, "rm_hook_ran.txt");

        const result: RemoveWorkspaceResult = await manager.removeWorkspace("RM-UNSAFE-1", {
          hooks: hooks({ beforeRemove: `printf ran > "${beforeMarker}"` }),
        });

        expect(result.status).toBe("refused");
        if (result.status === "refused") {
          expect(result.reason).toBe("workspace_symlink_escape");
        }
        // hook 从未运行；symlink 仍在；root 外目标完好
        expect(await pathExists(beforeMarker)).toBe(false);
        expect((await fs.lstat(wsPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(outsideTarget, "important.txt"), "utf8")).toBe("keep-me");
      });

      it("TOCTOU：before_remove 运行期间把目录换成逃逸 symlink → 删除前重验拒绝，root 外目标不被删", async () => {
        const outsideTarget = path.join(outside, "toctou-victim");
        await fs.mkdir(outsideTarget);
        await fs.writeFile(path.join(outsideTarget, "keep.txt"), "keep-me");

        const ws = await manager.createWorkspace("RM-TOCTOU-1");
        const key = path.basename(ws.path);
        // before_remove 把自身目录换成指向 outside 的 symlink（模拟 hook 长时间运行期间被替换）
        const script = `cd "${root}" && rm -rf "${key}" && ln -s "${outsideTarget}" "${key}"`;

        const result = await manager.removeWorkspace("RM-TOCTOU-1", {
          hooks: hooks({ beforeRemove: script }),
        });

        expect(result.status).toBe("refused");
        if (result.status === "refused") {
          expect(result.reason).toBe("workspace_symlink_escape");
        }
        // 重验拦截了 destructive delete：symlink 仍在、root 外目标完好
        expect((await fs.lstat(ws.path)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(outsideTarget, "keep.txt"), "utf8")).toBe("keep-me");
      });
    });
  });
});
