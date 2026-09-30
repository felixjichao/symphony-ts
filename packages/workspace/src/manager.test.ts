import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveWorkspaceKey as domainDeriveWorkspaceKey } from "@symphony/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceManager,
  WorkspaceError,
  type WorkspaceErrorCode,
  WorkspaceManager,
} from "./index";

describe("WorkspaceManager (SPEC §9.1–§9.2 / §17.2)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sym-workspace-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in test teardown
    }
  });

  describe("构造与配置校验", () => {
    it("接受合法的绝对路径 root 并规范化", () => {
      const manager = createWorkspaceManager({
        workspace: { root: tmpRoot },
      });
      expect(manager.root).toBe(path.resolve(tmpRoot));
      expect(manager.workspaceConfig.root).toBe(tmpRoot);
      expect(manager.hooksConfig).toBeUndefined();
    });

    it("接受带有 hooks 配置的选项", () => {
      const hooks = {
        afterCreate: "echo created",
        beforeRun: "echo before",
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 30000,
      };
      const manager = new WorkspaceManager({
        workspace: { root: tmpRoot },
        hooks,
      });
      expect(manager.hooksConfig).toBe(hooks);
    });

    it("拒绝空配置、缺失 workspace 或非法 root", () => {
      // @ts-expect-error 测试非法运行时入参
      expect(() => new WorkspaceManager()).toThrow(WorkspaceError);
      // @ts-expect-error 测试非法运行时入参
      expect(() => new WorkspaceManager({})).toThrow(WorkspaceError);
      // @ts-expect-error 测试非法运行时入参
      expect(() => new WorkspaceManager({ workspace: {} })).toThrow(WorkspaceError);

      try {
        new WorkspaceManager({ workspace: { root: "" } });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("invalid_root_path");
      }

      try {
        new WorkspaceManager({ workspace: { root: "   " } });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("invalid_root_path");
      }

      try {
        // 相对路径必须被拒绝（SPEC §9.1: normalized absolute path）
        new WorkspaceManager({ workspace: { root: "relative/path/to/root" } });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("invalid_root_path");
      }
    });
  });

  describe("确定性 key 派生与 domain 权威复用（SPEC §4.2 / §9.1）", () => {
    it("直接复用 @symphony/domain 的 deriveWorkspaceKey", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const testCases = [
        "ISSUE-1",
        "nested/issue-2",
        "special:name#123",
        "already_clean.123-abc",
      ];

      for (const id of testCases) {
        expect(manager.deriveWorkspaceKey(id)).toBe(domainDeriveWorkspaceKey(id));
      }
    });

    it("未被净化的合法字符 identifier 保持原 key（无后缀）", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      expect(manager.deriveWorkspaceKey("NEST-61")).toBe("NEST-61");
      expect(manager.deriveWorkspaceKey("alpha.beta_1-2")).toBe("alpha.beta_1-2");
    });

    it("含非允许字符的 identifier 被净化并追加 16-hex hash 稳定后缀（防碰撞）", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const key = manager.deriveWorkspaceKey("issue/123#456");
      expect(key).toMatch(/^issue_123_456--[0-9a-f]{16}$/);

      // 幂等：同一 identifier 恒得同一 key
      expect(manager.deriveWorkspaceKey("issue/123#456")).toBe(key);
    });

    it("净化后同文的不同 identifier 通过 domain hash 得到不同 key（SPEC §17.2）", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const id1 = "issue/1";
      const id2 = "issue#1";
      const id3 = "issue:1";

      const key1 = manager.deriveWorkspaceKey(id1);
      const key2 = manager.deriveWorkspaceKey(id2);
      const key3 = manager.deriveWorkspaceKey(id3);

      expect(key1).not.toBe(key2);
      expect(key2).not.toBe(key3);
      expect(key1).not.toBe(key3);

      expect(key1.startsWith("issue_1--")).toBe(true);
      expect(key2.startsWith("issue_1--")).toBe(true);
      expect(key3.startsWith("issue_1--")).toBe(true);
    });

    it("空字符串或非法 identifier 抛出类型化 invalid_identifier 错误", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      try {
        manager.deriveWorkspaceKey("");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("invalid_identifier");
        expect((err as WorkspaceError).cause).toBeDefined();
      }

      try {
        // @ts-expect-error 测试非法运行时入参
        manager.deriveWorkspaceKey(null);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("invalid_identifier");
      }
    });
  });

  describe("确定性路径解析与基础安全边界（SPEC §9.1 / §9.5 Invariant 2）", () => {
    it("相同 identifier + root 稳定得到相同 path", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const path1 = manager.resolveWorkspacePath("NEST-61");
      const path2 = manager.resolveWorkspacePath("NEST-61");
      expect(path1).toBe(path2);
      expect(path1).toBe(path.join(tmpRoot, "NEST-61"));
      expect(manager.resolvePath("NEST-61")).toBe(path1);
    });

    it("冲突 identifier 得到不同路径", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const path1 = manager.resolveWorkspacePath("proj/task");
      const path2 = manager.resolveWorkspacePath("proj#task");
      expect(path1).not.toBe(path2);
      expect(path1.startsWith(tmpRoot)).toBe(true);
      expect(path2.startsWith(tmpRoot)).toBe(true);
    });

    it("拒绝逃逸或等同于 workspace.root 的不安全路径（SPEC §9.5）", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      // "." 净化后为 "."，路径等于 root 本身 -> 拒绝
      try {
        manager.resolveWorkspacePath(".");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("unsafe_path");
      }

      // ".." 净化后为 ".."，路径逃逸出 root -> 拒绝
      try {
        manager.resolveWorkspacePath("..");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("unsafe_path");
      }
    });

    it("resolveWorkspacePathFromKey 校验入参并阻止逃逸", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      expect(manager.resolveWorkspacePathFromKey("valid-key")).toBe(
        path.join(tmpRoot, "valid-key"),
      );

      expect(() => manager.resolveWorkspacePathFromKey("")).toThrow(
        WorkspaceError,
      );
      expect(() => manager.resolveWorkspacePathFromKey("..")).toThrow(
        WorkspaceError,
      );
    });
  });

  describe("本地文件系统 provisioning：创建与复用（SPEC §9.2 / §17.2）", () => {
    it("首次创建缺失目录：createdNow=true 且真实目录就绪", () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      return manager.createWorkspace("NEST-100").then(async (ws) => {
        expect(ws.workspaceKey).toBe("NEST-100");
        expect(ws.path).toBe(path.join(tmpRoot, "NEST-100"));
        expect(ws.createdNow).toBe(true);

        // 重读世界：真实文件系统上必须是目录
        const stat = await fs.stat(ws.path);
        expect(stat.isDirectory()).toBe(true);
      });
    });

    it("再次调用创建：同路径原样复用且 createdNow=false", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const first = await manager.createWorkspace("NEST-100");
      expect(first.createdNow).toBe(true);

      // 在目录中写入文件以验证原样复用
      const markerFile = path.join(first.path, "marker.txt");
      await fs.writeFile(markerFile, "workspace-content");

      const second = await manager.createWorkspace("NEST-100");
      expect(second.createdNow).toBe(false);
      expect(second.path).toBe(first.path);
      expect(second.workspaceKey).toBe(first.workspaceKey);

      // 验证已有文件完好无损
      const content = await fs.readFile(markerFile, "utf8");
      expect(content).toBe("workspace-content");
    });

    it("ensureWorkspace 为 createWorkspace 别名，行为一致", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const ws = await manager.ensureWorkspace("NEST-200");
      expect(ws.createdNow).toBe(true);
      const stat = await fs.stat(ws.path);
      expect(stat.isDirectory()).toBe(true);

      const wsReused = await manager.ensureWorkspace("NEST-200");
      expect(wsReused.createdNow).toBe(false);
      expect(wsReused.path).toBe(ws.path);
    });

    it("当 workspace.root 尚未在磁盘上创建时，自动递归创建 root 与 workspace", async () => {
      const nestedRoot = path.join(tmpRoot, "nested", "workspaces", "root");
      const manager = createWorkspaceManager({ workspace: { root: nestedRoot } });

      const ws = await manager.createWorkspace("NEST-300");
      expect(ws.createdNow).toBe(true);
      const stat = await fs.stat(ws.path);
      expect(stat.isDirectory()).toBe(true);
      expect(ws.path.startsWith(nestedRoot)).toBe(true);
    });
  });

  describe("安全失败策略：已存在非目录对象不删除不替换（SPEC §17.2 Implementation Policy）", () => {
    it("同路径已有 regular file 时安全失败：不被删除，抛出 existing_non_directory", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });
      const targetPath = manager.resolveWorkspacePath("BLOCKED-FILE-1");

      // 事先在 targetPath 创建一个常规文件
      await fs.writeFile(targetPath, "precious-user-data", { encoding: "utf8" });

      try {
        await manager.createWorkspace("BLOCKED-FILE-1");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        const wsErr = err as WorkspaceError;
        expect(wsErr.code).toBe("existing_non_directory");
        expect(wsErr.path).toBe(targetPath);
        expect(wsErr.workspaceKey).toBe("BLOCKED-FILE-1");
        expect(wsErr.identifier).toBe("BLOCKED-FILE-1");
      }

      // 重读世界：文件必须未被删除、未被替换，内容完好无损
      const fileStat = await fs.lstat(targetPath);
      expect(fileStat.isFile()).toBe(true);
      expect(fileStat.isDirectory()).toBe(false);
      const content = await fs.readFile(targetPath, "utf8");
      expect(content).toBe("precious-user-data");
    });

    it("同路径已有符号链接时安全失败：不被删除，抛出 existing_non_directory", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });
      const targetPath = manager.resolveWorkspacePath("BLOCKED-LINK-1");

      const externalDir = path.join(tmpRoot, "external-target");
      await fs.mkdir(externalDir);
      await fs.symlink(externalDir, targetPath);

      try {
        await manager.createWorkspace("BLOCKED-LINK-1");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("existing_non_directory");
      }

      // 重读世界：符号链接未被删除
      const linkStat = await fs.lstat(targetPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
    });
  });

  describe("并发与竞态安全（SPEC §9.2 / §17.2）", () => {
    it("并发调用 createWorkspace 最终一致得到可用目录，无抛出且 createdNow 语义明确", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });

      const results = await Promise.all([
        manager.createWorkspace("CONCURRENT-1"),
        manager.createWorkspace("CONCURRENT-1"),
        manager.createWorkspace("CONCURRENT-1"),
        manager.createWorkspace("CONCURRENT-1"),
      ]);

      // 路径与 key 完全相同
      for (const res of results) {
        expect(res.path).toBe(path.join(tmpRoot, "CONCURRENT-1"));
        expect(res.workspaceKey).toBe("CONCURRENT-1");
      }

      // 至少有一个记录为新建
      const createdCount = results.filter((r) => r.createdNow).length;
      expect(createdCount).toBeGreaterThanOrEqual(1);

      // 磁盘上真实目录必须可用
      const stat = await fs.stat(path.join(tmpRoot, "CONCURRENT-1"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("EEXIST 重判逻辑：若并发冲突创建的是目录，成功复用（createdNow=false）", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });
      const targetPath = manager.resolveWorkspacePath("RACE-DIR-1");

      // 模拟探测后、mkdir 时的并发：此时目录已存在
      await fs.mkdir(targetPath);

      const ws = await manager.createWorkspace("RACE-DIR-1");
      expect(ws.createdNow).toBe(false);
      expect(ws.path).toBe(targetPath);

      const stat = await fs.stat(targetPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it("EEXIST 重判逻辑：若并发冲突创建的是非目录文件，安全失败为 existing_non_directory", async () => {
      const manager = createWorkspaceManager({ workspace: { root: tmpRoot } });
      const targetPath = manager.resolveWorkspacePath("RACE-FILE-1");

      // 放入文件
      await fs.writeFile(targetPath, "conflict-file");

      try {
        await manager.createWorkspace("RACE-FILE-1");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code).toBe("existing_non_directory");
      }

      const stat = await fs.lstat(targetPath);
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("文件系统异常与错误契约（SPEC §9 / §17.2）", () => {
    it("当 root 本身是文件（ENOTDIR）时抛出 invalid_root_path 并保留 cause", async () => {
      const rootAsFile = path.join(tmpRoot, "root-file.txt");
      await fs.writeFile(rootAsFile, "not-a-directory");

      const manager = createWorkspaceManager({
        workspace: { root: rootAsFile },
      });

      try {
        await manager.createWorkspace("FAIL-ROOT-1");
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError);
        const wsErr = err as WorkspaceError;
        expect(wsErr.code).toBe("invalid_root_path");
        expect(wsErr.cause).toBeDefined();
      }
    });

    it("错误码契约覆盖预留的 hook_execution_failed 与 hook_timeout", () => {
      const codes: WorkspaceErrorCode[] = [
        "invalid_identifier",
        "invalid_root_path",
        "existing_non_directory",
        "directory_creation_failed",
        "unsafe_path",
        "hook_execution_failed",
        "hook_timeout",
      ];

      for (const code of codes) {
        const err = new WorkspaceError(code, `test message for ${code}`);
        expect(err.code).toBe(code);
        expect(err.name).toBe("WorkspaceError");
      }
    });
  });
});
