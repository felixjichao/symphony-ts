import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceManager,
  WorkspaceError,
  type UnsafePathReason,
  type WorkspaceManager,
  type WorkspacePathValidation,
} from "./index";

/**
 * #28 workspace path safety boundary 测试（SPEC §9.5 / §17.2）。
 *
 * 全部基于真实临时文件系统与真实 symlink（不 mock fs），并经包的唯一公共
 * API 面 `index.ts` 进入（validateWorkspacePath / assertWorkspacePathSafe /
 * createWorkspace）。验收映射见 #28 验收 1–7。
 */

// symlink 能力探测：host 不支持创建 symlink 时，相关用例经 describe.skipIf
// 显式 skip（vitest 报告中可见 skipped），绝不静默 pass。
const symlinkSupport = (() => {
  let probeDir: string | null = null;
  try {
    probeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "sym-symlink-probe-"));
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

// root 运行时（euid 0）权限位不适用：chmod 000 无法制造 unreadable，
// 对应用例显式 skip 而非静默 pass。
const runsAsRoot =
  typeof process.geteuid === "function" && process.geteuid() === 0;

async function expectUnsafe(
  validation: WorkspacePathValidation,
  reason: UnsafePathReason,
): Promise<void> {
  expect(validation.safe).toBe(false);
  if (!validation.safe) {
    expect(validation.reason).toBe(reason);
  }
}

async function expectAssertRejection(
  manager: WorkspaceManager,
  workspacePath: string,
  reason: UnsafePathReason,
): Promise<WorkspaceError> {
  let caught: unknown;
  try {
    await manager.assertWorkspacePathSafe(workspacePath);
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkspaceError);
  const wsErr = caught as WorkspaceError;
  expect(wsErr.code).toBe("unsafe_path");
  expect(wsErr.unsafeReason).toBe(reason);
  return wsErr;
}

/** validate 与 assert 两个入口对同一场景必须给出一致的拒绝面。 */
async function expectRejected(
  manager: WorkspaceManager,
  workspacePath: string,
  reason: UnsafePathReason,
): Promise<WorkspaceError> {
  await expectUnsafe(await manager.validateWorkspacePath(workspacePath), reason);
  return expectAssertRejection(manager, workspacePath, reason);
}

describe("workspace path safety boundary（SPEC §9.5 / §17.2，#28）", () => {
  let tmpRoot: string;
  let root: string;
  let outside: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sym-path-safety-"));
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
      // 该输出让「skip 而非静默 pass」在测试报告中可审计
      console.warn(
        `[path-safety] host 不支持创建 symlink，相关用例显式 skip：${symlinkSupport.reason}`,
      );
    }
  });

  describe("验收 1：正常 root/key 通过", () => {
    it("已存在目录：safe=true、exists=true、canonicalPath 为 realpath 结果", async () => {
      const ws = path.join(root, "NEST-62");
      await fs.mkdir(ws);

      const validation = await manager.validateWorkspacePath(ws);
      expect(validation.safe).toBe(true);
      if (validation.safe) {
        expect(validation.path).toBe(ws);
        expect(validation.exists).toBe(true);
        expect(validation.canonicalRoot).toBe(await fs.realpath(root));
        expect(validation.canonicalPath).toBe(await fs.realpath(ws));
      }
      await expect(manager.assertWorkspacePathSafe(ws)).resolves.toBeUndefined();
    });

    it("尚不存在路径：不因目标缺失跳过校验，safe=true、exists=false、canonicalPath 为推定落点", async () => {
      const ws = path.join(root, "NEST-63");

      const validation = await manager.validateWorkspacePath(ws);
      expect(validation.safe).toBe(true);
      if (validation.safe) {
        expect(validation.exists).toBe(false);
        expect(validation.canonicalPath).toBe(
          path.join(await fs.realpath(root), "NEST-63"),
        );
      }
      await expect(manager.assertWorkspacePathSafe(ws)).resolves.toBeUndefined();
    });

    it("多级尚不存在路径（root/a/b）：safe，推定落点仍在 root 下", async () => {
      const ws = path.join(root, "a", "b");

      const validation = await manager.validateWorkspacePath(ws);
      expect(validation.safe).toBe(true);
      if (validation.safe) {
        expect(validation.exists).toBe(false);
        expect(validation.canonicalPath).toBe(
          path.join(await fs.realpath(root), "a", "b"),
        );
      }
    });

    it("root 自身尚不存在（递归创建语义）：canonicalRoot 按最近已存在 ancestor 推定，createWorkspace 端到端可用", async () => {
      const nestedRoot = path.join(tmpRoot, "nested", "ws-root");
      const nestedManager = createWorkspaceManager({
        workspace: { root: nestedRoot },
      });
      const ws = path.join(nestedRoot, "NEST-64");

      const validation = await nestedManager.validateWorkspacePath(ws);
      expect(validation.safe).toBe(true);
      if (validation.safe) {
        expect(validation.canonicalRoot).toBe(
          path.join(await fs.realpath(tmpRoot), "nested", "ws-root"),
        );
        expect(validation.canonicalPath).toBe(
          path.join(validation.canonicalRoot, "NEST-64"),
        );
      }

      // M3.1「root 不存在则递归创建」语义回归：safety gate 不得阻断该路径
      const created = await nestedManager.createWorkspace("NEST-64");
      expect(created.createdNow).toBe(true);
      expect(created.path).toBe(ws);
      const stat = await fs.stat(ws);
      expect(stat.isDirectory()).toBe(true);
    });

    it("带冗余 segment / 尾斜杠的合法路径规范化后通过", async () => {
      await fs.mkdir(path.join(root, "NEST-65"));

      const messy = `${path.join(root, ".", "NEST-65", "..", "NEST-65")}/`;
      const validation = await manager.validateWorkspacePath(messy);
      expect(validation.safe).toBe(true);
      if (validation.safe) {
        expect(validation.path).toBe(path.join(root, "NEST-65"));
      }
    });
  });

  describe("验收 2/3：root 本身、非绝对路径与 lexical 出根被拒绝", () => {
    it("workspace path == root：workspace_equals_root（含尾斜杠形态）", async () => {
      await expectRejected(manager, root, "workspace_equals_root");
      await expectRejected(
        manager,
        `${root}/`,
        "workspace_equals_root",
      );
    });

    it("相对路径与空串：必须绝对路径，拒绝为 workspace_outside_root", async () => {
      for (const p of ["relative/path", "", ".", "..", "NEST-62"]) {
        await expectRejected(manager, p, "workspace_outside_root");
      }
    });

    it("../ 逃逸：workspace_outside_root", async () => {
      await expectRejected(
        manager,
        path.join(root, "..", "escape"),
        "workspace_outside_root",
      );
      await expectRejected(
        manager,
        path.join(root, "a", "..", "..", "escape"),
        "workspace_outside_root",
      );
    });

    it("sibling 目录：workspace_outside_root", async () => {
      await expectRejected(manager, outside, "workspace_outside_root");
      await expectRejected(
        manager,
        path.join(outside, "KEY"),
        "workspace_outside_root",
      );
    });

    it("前缀混淆（<root>2 形态）：segment 级判定拒绝，证明非裸 startsWith(root)", async () => {
      const confuser = `${root}2`;
      await fs.mkdir(confuser);

      await expectRejected(manager, confuser, "workspace_outside_root");
      await expectRejected(
        manager,
        path.join(confuser, "KEY"),
        "workspace_outside_root",
      );
    });

    it("root 的父目录：workspace_outside_root", async () => {
      await expectRejected(manager, tmpRoot, "workspace_outside_root");
    });
  });

  describe.skipIf(!symlinkSupport.supported)(
    "验收 4：workspace symlink 指向 root 外被拒绝（真实 symlink）",
    () => {
      it("symlink 指向 root 外已存在目录：workspace_symlink_escape，且链接不被删除", async () => {
        const link = path.join(root, "ESC-1");
        await fs.symlink(outside, link, "dir");

        const err = await expectRejected(
          manager,
          link,
          "workspace_symlink_escape",
        );
        expect(err.canonicalRoot).toBe(await fs.realpath(root));

        // 重读世界：symlink 与外部目录均未被删除 / 替换
        const linkStat = await fs.lstat(link);
        expect(linkStat.isSymbolicLink()).toBe(true);
        expect((await fs.lstat(outside)).isDirectory()).toBe(true);
      });

      it("symlink 指向 root 外文件：workspace_symlink_escape", async () => {
        const outsideFile = path.join(outside, "secret.txt");
        await fs.writeFile(outsideFile, "precious");
        const link = path.join(root, "ESC-2");
        await fs.symlink(outsideFile, link, "file");

        await expectRejected(manager, link, "workspace_symlink_escape");

        const content = await fs.readFile(outsideFile, "utf8");
        expect(content).toBe("precious");
      });

      it("dangling symlink（目标不存在）：无法 canonicalize，fail-closed 为 workspace_path_unreadable 且保留 cause", async () => {
        const link = path.join(root, "ESC-DANGLING");
        await fs.symlink(path.join(outside, "ghost"), link, "dir");

        const err = await expectRejected(
          manager,
          link,
          "workspace_path_unreadable",
        );
        expect(err.cause).toBeDefined();
      });

      it("symlink 环（ELOOP）：workspace_path_unreadable 且保留 cause", async () => {
        const loopA = path.join(root, "LOOP-A");
        const loopB = path.join(root, "LOOP-B");
        await fs.symlink(loopB, loopA, "dir");
        await fs.symlink(loopA, loopB, "dir");

        const err = await expectRejected(
          manager,
          loopA,
          "workspace_path_unreadable",
        );
        expect(err.cause).toBeDefined();
      });

      it("symlink 指向 root 内另一位置：canonical 仍在 root 下，放行", async () => {
        const realDir = path.join(root, "real-dir");
        await fs.mkdir(realDir);
        const link = path.join(root, "internal-link");
        await fs.symlink(realDir, link, "dir");

        const validation = await manager.validateWorkspacePath(link);
        expect(validation.safe).toBe(true);
        if (validation.safe) {
          expect(validation.exists).toBe(true);
          expect(validation.canonicalPath).toBe(await fs.realpath(realDir));
        }
        await expect(manager.assertWorkspacePathSafe(link)).resolves.toBeUndefined();
      });

      it("多跳内部 symlink 链（a→b→c 均在 root 内）：放行，canonicalPath 为最终真实路径", async () => {
        const dirC = path.join(root, "chain-c");
        await fs.mkdir(dirC);
        const linkB = path.join(root, "chain-b");
        const linkA = path.join(root, "chain-a");
        await fs.symlink(dirC, linkB, "dir");
        await fs.symlink(linkB, linkA, "dir");

        // 已存在形态：a 本身
        const validationA = await manager.validateWorkspacePath(linkA);
        expect(validationA.safe).toBe(true);
        if (validationA.safe) {
          expect(validationA.canonicalPath).toBe(await fs.realpath(dirC));
        }

        // 尚不存在形态：链下 KEY 的推定落点 = canonical 链尾 + KEY
        const validationKey = await manager.validateWorkspacePath(
          path.join(linkA, "KEY"),
        );
        expect(validationKey.safe).toBe(true);
        if (validationKey.safe) {
          expect(validationKey.exists).toBe(false);
          expect(validationKey.canonicalPath).toBe(
            path.join(await fs.realpath(dirC), "KEY"),
          );
        }
      });

      it("symlink 绕回 root 本身：workspace_equals_root", async () => {
        const loop = path.join(root, "loop-to-root");
        await fs.symlink(root, loop, "dir");

        await expectRejected(manager, loop, "workspace_equals_root");
      });

      it("尚不存在路径的已存在 ancestor 经 symlink 逃逸：workspace_symlink_escape", async () => {
        const linkDir = path.join(root, "linkdir-out");
        await fs.symlink(outside, linkDir, "dir");

        // KEY 在 outside 下尚不存在：不得因目标缺失跳过 ancestor canonical 校验
        await expectRejected(
          manager,
          path.join(linkDir, "KEY"),
          "workspace_symlink_escape",
        );
      });

      it("尚不存在路径的已存在 ancestor 是内部 symlink：按 canonical 推定落点，放行", async () => {
        const realDir = path.join(root, "real-ancestor");
        await fs.mkdir(realDir);
        const linkDir = path.join(root, "linkdir-in");
        await fs.symlink(realDir, linkDir, "dir");

        const validation = await manager.validateWorkspacePath(
          path.join(linkDir, "KEY"),
        );
        expect(validation.safe).toBe(true);
        if (validation.safe) {
          expect(validation.exists).toBe(false);
          expect(validation.canonicalPath).toBe(
            path.join(await fs.realpath(realDir), "KEY"),
          );
        }
      });

      it("已存在目录经中间 symlink 到达但 canonical 逃逸：workspace_symlink_escape（canonical 校验不只看最终元素）", async () => {
        const innerDir = path.join(outside, "inner");
        await fs.mkdir(innerDir);
        const tunnel = path.join(root, "tunnel-out");
        await fs.symlink(outside, tunnel, "dir");

        await expectRejected(
          manager,
          path.join(tunnel, "inner"),
          "workspace_symlink_escape",
        );
      });
    },
  );

  describe.skipIf(!symlinkSupport.supported)(
    "验收 5：configured root 自身经 symlink 解析后以 canonical root 判定",
    () => {
      it("root（symlink 形态）下的合法 workspace 通过，canonicalRoot 为解析后的真实目录", async () => {
        const realRoot = path.join(tmpRoot, "real-root");
        await fs.mkdir(realRoot);
        const linkRoot = path.join(tmpRoot, "link-root");
        await fs.symlink(realRoot, linkRoot, "dir");
        const linkManager = createWorkspaceManager({
          workspace: { root: linkRoot },
        });

        const ws = path.join(linkRoot, "NEST-66");
        const validation = await linkManager.validateWorkspacePath(ws);
        expect(validation.safe).toBe(true);
        if (validation.safe) {
          expect(validation.canonicalRoot).toBe(await fs.realpath(realRoot));
          expect(validation.canonicalPath).toBe(
            path.join(await fs.realpath(realRoot), "NEST-66"),
          );
        }

        // createWorkspace 端到端：path 保持 configured root 的 lexical 形态，
        // 真实目录落在 canonical root 下
        const created = await linkManager.createWorkspace("NEST-66");
        expect(created.path).toBe(ws);
        expect(created.createdNow).toBe(true);
        const canonicalStat = await fs.stat(
          path.join(await fs.realpath(realRoot), "NEST-66"),
        );
        expect(canonicalStat.isDirectory()).toBe(true);
      });

      it("root（symlink 形态）下 workspace symlink 指向真实 root 外：workspace_symlink_escape", async () => {
        const realRoot = path.join(tmpRoot, "real-root-2");
        await fs.mkdir(realRoot);
        const linkRoot = path.join(tmpRoot, "link-root-2");
        await fs.symlink(realRoot, linkRoot, "dir");
        const linkManager = createWorkspaceManager({
          workspace: { root: linkRoot } });

        const esc = path.join(linkRoot, "ESC-ROOT");
        await fs.symlink(outside, esc, "dir");

        await expectRejected(linkManager, esc, "workspace_symlink_escape");
      });

      it("canonical 形态直书路径（绕过 configured root 的 lexical 前缀）：workspace_outside_root", async () => {
        const realRoot = path.join(tmpRoot, "real-root-3");
        await fs.mkdir(realRoot);
        const linkRoot = path.join(tmpRoot, "link-root-3");
        await fs.symlink(realRoot, linkRoot, "dir");
        const linkManager = createWorkspaceManager({
          workspace: { root: linkRoot },
        });

        // 不变量要求 lexical 与 canonical 同时成立：调用方应使用
        // resolveWorkspacePath 的产物（configured root 前缀），而非自行拼 canonical 路径
        await expectRejected(
          linkManager,
          path.join(realRoot, "NEST-67"),
          "workspace_outside_root",
        );
      });
    },
  );

  describe.skipIf(!symlinkSupport.supported)(
    "验收 6：破坏性动作前重验可阻止创建后被替换的 symlink escape（TOCTOU）",
    () => {
      it("目录创建并通过校验后被替换为 root 外 symlink：重验必须失败", async () => {
        const ws = path.join(root, "TOCTOU-1");
        await fs.mkdir(ws);
        await manager.assertWorkspacePathSafe(ws); // 创建时点校验通过

        // 模拟攻击窗口：目录被替换为指向 root 外的 symlink
        await fs.rm(ws, { recursive: true, force: true });
        await fs.symlink(outside, ws, "dir");

        // launch / cleanup 前的重验入口必须拦截（字符串路径相同、语义已变）
        const err = await expectRejected(
          manager,
          ws,
          "workspace_symlink_escape",
        );
        expect(err.path).toBe(ws);

        // 重读世界：symlink 未被删除，外部目录未被触碰
        expect((await fs.lstat(ws)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(outside)).isDirectory()).toBe(true);
      });

      it("目录创建后被替换为 dangling symlink：重验 fail-closed 为 workspace_path_unreadable", async () => {
        const ws = path.join(root, "TOCTOU-2");
        await fs.mkdir(ws);
        await manager.assertWorkspacePathSafe(ws);

        await fs.rm(ws, { recursive: true, force: true });
        await fs.symlink(path.join(outside, "ghost"), ws, "dir");

        await expectRejected(manager, ws, "workspace_path_unreadable");
      });

      it("校验是无状态纯 fs 判定：目录被替换为 root 内另一真实目录后重验仍通过", async () => {
        const ws = path.join(root, "TOCTOU-3");
        await fs.mkdir(ws);
        await manager.assertWorkspacePathSafe(ws);

        await fs.rm(ws, { recursive: true, force: true });
        await fs.mkdir(ws);

        const validation = await manager.validateWorkspacePath(ws);
        expect(validation.safe).toBe(true);
      });
    },
  );

  describe("错误面：四类 reason、invalid_root 映射与 cause 保留", () => {
    it("root 是常规文件：validate 返回 invalid_root，assert 抛 invalid_root_path（M3.1 错误面保持）", async () => {
      const rootAsFile = path.join(tmpRoot, "root-as-file.txt");
      await fs.writeFile(rootAsFile, "not-a-directory");
      const fileRootManager = createWorkspaceManager({
        workspace: { root: rootAsFile },
      });

      const validation = await fileRootManager.validateWorkspacePath(
        path.join(rootAsFile, "KEY"),
      );
      expect(validation.safe).toBe(false);
      if (!validation.safe) {
        expect(validation.reason).toBe("invalid_root");
      }

      let caught: unknown;
      try {
        await fileRootManager.assertWorkspacePathSafe(
          path.join(rootAsFile, "KEY"),
        );
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkspaceError);
      expect((caught as WorkspaceError).code).toBe("invalid_root_path");
    });

    it("中间 ancestor 是普通文件（ENOTDIR）：workspace_path_unreadable 且保留 cause", async () => {
      const blocker = path.join(root, "blocker.txt");
      await fs.writeFile(blocker, "file-not-dir");

      const err = await expectRejected(
        manager,
        path.join(blocker, "KEY"),
        "workspace_path_unreadable",
      );
      expect(err.cause).toBeDefined();
    });

    it.skipIf(runsAsRoot)(
      "不可读目录（chmod 000）ancestor：workspace_path_unreadable（root 运行时权限位不适用，显式 skip）",
      async () => {
        const locked = path.join(root, "locked");
        await fs.mkdir(locked);
        await fs.chmod(locked, 0o000);
        try {
          await expectRejected(
            manager,
            path.join(locked, "KEY"),
            "workspace_path_unreadable",
          );
        } finally {
          await fs.chmod(locked, 0o755);
        }
      },
    );

    it("assert 的 options 透传 workspaceKey / identifier 诊断上下文", async () => {
      let caught: unknown;
      try {
        await manager.assertWorkspacePathSafe(root, {
          workspaceKey: "KEY-CTX",
          identifier: "ID-CTX",
        });
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkspaceError);
      const wsErr = caught as WorkspaceError;
      expect(wsErr.code).toBe("unsafe_path");
      expect(wsErr.unsafeReason).toBe("workspace_equals_root");
      expect(wsErr.workspaceKey).toBe("KEY-CTX");
      expect(wsErr.identifier).toBe("ID-CTX");
    });

    it("resolveWorkspacePathFromKey 的同步 lexical 拒绝同样携带 unsafeReason 细分", () => {
      try {
        manager.resolveWorkspacePathFromKey("..");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        const wsErr = err as WorkspaceError;
        expect(wsErr.code).toBe("unsafe_path");
        expect(wsErr.unsafeReason).toBe("workspace_outside_root");
      }

      try {
        manager.resolveWorkspacePathFromKey(".");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).unsafeReason).toBe(
          "workspace_equals_root",
        );
      }
    });
  });

  describe.skipIf(!symlinkSupport.supported)(
    "root 自身形态的 invalid_root 错误面（symlink）",
    () => {
      it("root 是 dangling symlink：invalid_root / invalid_root_path", async () => {
        const danglingRoot = path.join(tmpRoot, "dangling-root");
        await fs.symlink(
          path.join(tmpRoot, "nowhere"),
          danglingRoot,
          "dir",
        );
        const danglingManager = createWorkspaceManager({
          workspace: { root: danglingRoot },
        });

        const validation = await danglingManager.validateWorkspacePath(
          path.join(danglingRoot, "KEY"),
        );
        expect(validation.safe).toBe(false);
        if (!validation.safe) {
          expect(validation.reason).toBe("invalid_root");
        }

        let caught: unknown;
        try {
          await danglingManager.assertWorkspacePathSafe(
            path.join(danglingRoot, "KEY"),
          );
        } catch (err: unknown) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(WorkspaceError);
        expect((caught as WorkspaceError).code).toBe("invalid_root_path");
      });
    },
  );

  describe("createWorkspace 接入 safety gate 与 M4 / M5 复用（验收 7）", () => {
    it.skipIf(!symlinkSupport.supported)(
      "逃逸 symlink 占据 workspace path：createWorkspace 抛 unsafe_path 且不删除不替换",
      async () => {
        const wsPath = manager.resolveWorkspacePath("ESC-WS-1");
        await fs.symlink(outside, wsPath, "dir");

        let caught: unknown;
        try {
          await manager.createWorkspace("ESC-WS-1");
        } catch (err: unknown) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(WorkspaceError);
        const wsErr = caught as WorkspaceError;
        expect(wsErr.code).toBe("unsafe_path");
        expect(wsErr.unsafeReason).toBe("workspace_symlink_escape");
        expect(wsErr.workspaceKey).toBe("ESC-WS-1");
        expect(wsErr.identifier).toBe("ESC-WS-1");

        // 重读世界：symlink 未被删除、外部目录未被触碰
        expect((await fs.lstat(wsPath)).isSymbolicLink()).toBe(true);
        expect((await fs.lstat(outside)).isDirectory()).toBe(true);
      },
    );

    it.skipIf(!symlinkSupport.supported)(
      "root 内 symlink 占据 workspace path：containment 放行后仍按 M3.1 语义 existing_non_directory",
      async () => {
        const realDir = path.join(root, "internal-real");
        await fs.mkdir(realDir);
        const wsPath = manager.resolveWorkspacePath("LINK-WS-2");
        await fs.symlink(realDir, wsPath, "dir");

        let caught: unknown;
        try {
          await manager.createWorkspace("LINK-WS-2");
        } catch (err: unknown) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(WorkspaceError);
        expect((caught as WorkspaceError).code).toBe("existing_non_directory");
        expect((await fs.lstat(wsPath)).isSymbolicLink()).toBe(true);
      },
    );

    it("API 不依赖 orchestrator / agent：resolve → assert（launch 前）→ create → assert（cleanup 前）复用模式", async () => {
      // 结构面：两个入口挂在 WorkspaceManager 公共 API 上，仅 import 本包即可复用
      expect(typeof manager.validateWorkspacePath).toBe("function");
      expect(typeof manager.assertWorkspacePathSafe).toBe("function");

      // M4 launch 模式：以 per-issue workspace path 为 cwd 前必须重新校验
      const wsPath = manager.resolveWorkspacePath("NEST-68");
      await manager.assertWorkspacePathSafe(wsPath);

      const created = await manager.createWorkspace("NEST-68");
      expect(created.path).toBe(wsPath);

      // #29 / M5 cleanup 模式：destructive 动作前必须重新校验
      await manager.assertWorkspacePathSafe(created.path, {
        workspaceKey: created.workspaceKey,
        identifier: "NEST-68",
      });
    });
  });
});
