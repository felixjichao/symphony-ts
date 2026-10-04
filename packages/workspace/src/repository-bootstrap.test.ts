import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapRepository,
  normalizeGitUrl,
  parseRepositoryBootstrapArgs,
  RepositoryBootstrapError,
  runRepositoryBootstrapCli,
  sanitizeRepoUrl,
} from "./index";

describe("Repository Workspace Bootstrap (SPEC §9 / §17.2)", () => {
  let tmpBase: string;
  let remoteRepoDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-bootstrap-test-"));
    remoteRepoDir = path.join(tmpBase, "remote.git");
    workspaceDir = path.join(tmpBase, "workspace-GH-79");

    // 创建测试用 bare 仓库并初始提交
    const initWorkDir = path.join(tmpBase, "init-work");
    await fs.mkdir(initWorkDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    execSync("git init -b main", { cwd: initWorkDir });
    execSync("git config user.name 'Test Committer'", { cwd: initWorkDir });
    execSync("git config user.email 'test@example.com'", { cwd: initWorkDir });
    await fs.writeFile(path.join(initWorkDir, "README.md"), "# Initial Commit\n", "utf8");
    execSync("git add README.md", { cwd: initWorkDir });
    execSync("git commit -m 'Initial commit on main'", { cwd: initWorkDir });

    // 初始化 bare 仓库并 push main
    execSync(`git clone --bare ${initWorkDir} ${remoteRepoDir}`);
    // 确保 HEAD 存在
    execSync("git symbolic-ref HEAD refs/heads/main", { cwd: remoteRepoDir });

    await fs.rm(initWorkDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  describe("URL 脱敏与规范化", () => {
    it("sanitizeRepoUrl 脱敏包含用户名密码的 URL", () => {
      expect(sanitizeRepoUrl("https://user:token123@github.com/org/repo.git")).toBe(
        "https://***:***@github.com/org/repo.git",
      );
      expect(sanitizeRepoUrl("https://github.com/org/repo.git")).toBe(
        "https://github.com/org/repo.git",
      );
    });

    it("normalizeGitUrl 正确消除 .git、尾斜杠与凭据", () => {
      expect(normalizeGitUrl("https://user:pass@github.com/org/repo.git/")).toBe(
        "https://github.com/org/repo",
      );
      expect(normalizeGitUrl("file:///tmp/repo.git")).toBe("/tmp/repo");
      expect(normalizeGitUrl("/tmp/repo")).toBe("/tmp/repo");
    });
  });

  describe("全新工作区检出 (AC #1, #2)", () => {
    it("全新工作区克隆仓库，发现默认分支并创建确定性 issue 分支", async () => {
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
        userName: "CustomBot",
        userEmail: "custombot@example.com",
      });

      expect(result.status).toBe("cloned");
      expect(result.defaultBranch).toBe("main");
      expect(result.issueBranch).toBe("symphony/GH-79");
      expect(result.workspacePath).toBe(workspaceDir);

      // 核验真实文件系统
      const readmeContent = await fs.readFile(path.join(workspaceDir, "README.md"), "utf8");
      expect(readmeContent).toBe("# Initial Commit\n");

      // 核验当前分支
      const currentBranch = execSync("git symbolic-ref --short HEAD", { cwd: workspaceDir })
        .toString()
        .trim();
      expect(currentBranch).toBe("symphony/GH-79");

      // 核验本地 git identity 配置
      const localName = execSync("git config --local user.name", { cwd: workspaceDir })
        .toString()
        .trim();
      const localEmail = execSync("git config --local user.email", { cwd: workspaceDir })
        .toString()
        .trim();
      expect(localName).toBe("CustomBot");
      expect(localEmail).toBe("custombot@example.com");
    });

    it("支持显式传入 issueBranch", async () => {
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        issueBranch: "feature/custom-task",
      });

      expect(result.status).toBe("cloned");
      expect(result.issueBranch).toBe("feature/custom-task");

      const currentBranch = execSync("git symbolic-ref --short HEAD", { cwd: workspaceDir })
        .toString()
        .trim();
      expect(currentBranch).toBe("feature/custom-task");
    });

    it("正确发现非 main 的默认分支（如 trunk）", async () => {
      const trunkRepo = path.join(tmpBase, "trunk.git");
      const initDir = path.join(tmpBase, "trunk-init");
      await fs.mkdir(initDir, { recursive: true });

      execSync("git init -b trunk", { cwd: initDir });
      execSync("git config user.name 'Test'", { cwd: initDir });
      execSync("git config user.email 'test@example.com'", { cwd: initDir });
      await fs.writeFile(path.join(initDir, "file.txt"), "trunk\n");
      execSync("git add file.txt && git commit -m 'trunk init'", { cwd: initDir });
      execSync(`git clone --bare ${initDir} ${trunkRepo}`);
      execSync("git symbolic-ref HEAD refs/heads/trunk", { cwd: trunkRepo });
      await fs.rm(initDir, { recursive: true, force: true });

      const trunkWs = path.join(tmpBase, "ws-trunk");
      await fs.mkdir(trunkWs, { recursive: true });

      const result = await bootstrapRepository({
        cwd: trunkWs,
        repoUrl: trunkRepo,
        workspaceKey: "TRUNK-1",
      });

      expect(result.defaultBranch).toBe("trunk");
      expect(result.issueBranch).toBe("symphony/TRUNK-1");
    });

    it("远端同名 issue 分支已存在时，全新工作区安全复用远端分支成果", async () => {
      // 预先在 remote 创建 symphony/GH-79 分支并提交一个成果文件
      const helperWork = path.join(tmpBase, "helper-work");
      execSync(`git clone ${remoteRepoDir} ${helperWork}`);
      execSync("git checkout -b symphony/GH-79", { cwd: helperWork });
      execSync("git config user.name 'Dev'", { cwd: helperWork });
      execSync("git config user.email 'dev@example.com'", { cwd: helperWork });
      await fs.writeFile(path.join(helperWork, "remote-work.txt"), "prior remote work\n");
      execSync("git add remote-work.txt && git commit -m 'prior work'", { cwd: helperWork });
      execSync("git push origin symphony/GH-79", { cwd: helperWork });
      await fs.rm(helperWork, { recursive: true, force: true });

      // 在空白 workspace 执行 bootstrap
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      expect(result.issueBranch).toBe("symphony/GH-79");
      const content = await fs.readFile(path.join(workspaceDir, "remote-work.txt"), "utf8");
      expect(content).toBe("prior remote work\n");
    });
  });

  describe("可重入与重启复用 (AC #3, #4)", () => {
    it("无新改动时重复执行可重入（status = reused）", async () => {
      const first = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });
      expect(first.status).toBe("cloned");

      const second = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });
      expect(second.status).toBe("reused");
      expect(second.headCommit).toBe(first.headCommit);
    });

    it("默认分支更新后，工作区干净且 HEAD 为祖先时安全快进 (fast_forwarded)", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      // 在远端 main 推进一个新 commit
      const pusherWork = path.join(tmpBase, "pusher-work");
      execSync(`git clone ${remoteRepoDir} ${pusherWork}`);
      execSync("git config user.name 'Main Dev'", { cwd: pusherWork });
      execSync("git config user.email 'main@example.com'", { cwd: pusherWork });
      await fs.writeFile(path.join(pusherWork, "NEW_ON_MAIN.md"), "main advanced\n");
      execSync("git add NEW_ON_MAIN.md && git commit -m 'advance main'", { cwd: pusherWork });
      execSync("git push origin main", { cwd: pusherWork });
      const newMainCommit = execSync("git rev-parse HEAD", { cwd: pusherWork }).toString().trim();
      await fs.rm(pusherWork, { recursive: true, force: true });

      // 重跑 bootstrap
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      expect(result.status).toBe("fast_forwarded");
      expect(result.headCommit).toBe(newMainCommit);
      const newFileContent = await fs.readFile(path.join(workspaceDir, "NEW_ON_MAIN.md"), "utf8");
      expect(newFileContent).toBe("main advanced\n");
    });

    it("有未提交或未跟踪工作时，默认分支更新不覆盖未提交内容 (status = reused)", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      // 在本地工作区留下未提交的文件
      await fs.writeFile(path.join(workspaceDir, "uncommitted.txt"), "agent in progress\n");

      // 在远端 main 推进一个新 commit
      const pusherWork = path.join(tmpBase, "pusher-work2");
      execSync(`git clone ${remoteRepoDir} ${pusherWork}`);
      execSync("git config user.name 'Main Dev'", { cwd: pusherWork });
      execSync("git config user.email 'main@example.com'", { cwd: pusherWork });
      await fs.writeFile(path.join(pusherWork, "NEW_ON_MAIN2.md"), "main advanced again\n");
      execSync("git add NEW_ON_MAIN2.md && git commit -m 'advance main again'", { cwd: pusherWork });
      execSync("git push origin main", { cwd: pusherWork });
      await fs.rm(pusherWork, { recursive: true, force: true });

      // 重跑 bootstrap：不应该 fast-forward 破坏未提交工作
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      expect(result.status).toBe("reused");
      const uncommitted = await fs.readFile(path.join(workspaceDir, "uncommitted.txt"), "utf8");
      expect(uncommitted).toBe("agent in progress\n");
    });

    it("已存在独立 issue 提交时，默认分支更新不覆盖已完成提交 (status = reused)", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      // 本地 issue 分支提交自己的改动
      await fs.writeFile(path.join(workspaceDir, "issue-feature.txt"), "feature code\n");
      execSync("git add issue-feature.txt && git commit -m 'commit on issue branch'", { cwd: workspaceDir });
      const localCommit = execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim();

      // 远端 main 推进
      const pusherWork = path.join(tmpBase, "pusher-work3");
      execSync(`git clone ${remoteRepoDir} ${pusherWork}`);
      execSync("git config user.name 'Main Dev'", { cwd: pusherWork });
      execSync("git config user.email 'main@example.com'", { cwd: pusherWork });
      await fs.writeFile(path.join(pusherWork, "MAIN_ADV.md"), "adv\n");
      execSync("git add MAIN_ADV.md && git commit -m 'adv'", { cwd: pusherWork });
      execSync("git push origin main", { cwd: pusherWork });
      await fs.rm(pusherWork, { recursive: true, force: true });

      // 重跑 bootstrap
      const result = await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      expect(result.status).toBe("reused");
      expect(result.headCommit).toBe(localCommit);
      const featureContent = await fs.readFile(path.join(workspaceDir, "issue-feature.txt"), "utf8");
      expect(featureContent).toBe("feature code\n");
    });
  });

  describe("边界保护与安全错误分类 (AC #5)", () => {
    it("空 URL 或空白 URL 抛出 invalid_repository_url", async () => {
      await expect(
        bootstrapRepository({ cwd: workspaceDir, repoUrl: "" }),
      ).rejects.toThrowError(RepositoryBootstrapError);

      try {
        await bootstrapRepository({ cwd: workspaceDir, repoUrl: "  " });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RepositoryBootstrapError);
        expect((err as RepositoryBootstrapError).code).toBe("invalid_repository_url");
      }
    });

    it("非空但无 .git 的目录拒绝执行并抛出 unrecognized_non_empty_directory", async () => {
      await fs.writeFile(path.join(workspaceDir, "stray-file.txt"), "dirty non git\n");

      await expect(
        bootstrapRepository({ cwd: workspaceDir, repoUrl: remoteRepoDir }),
      ).rejects.toMatchObject({
        code: "unrecognized_non_empty_directory",
      });
    });

    it("已存在仓库的 origin 与请求 URL 不匹配时拒绝并抛出 repository_url_mismatch", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      const anotherRepo = path.join(tmpBase, "another.git");
      await expect(
        bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: anotherRepo,
          workspaceKey: "GH-79",
        }),
      ).rejects.toMatchObject({
        code: "repository_url_mismatch",
      });
    });

    it("存在中间状态（如 MERGE_HEAD）时安全拒绝并抛出 git_operation_in_progress", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        workspaceKey: "GH-79",
      });

      // 模拟 MERGE_HEAD
      const mergeHeadPath = path.join(workspaceDir, ".git", "MERGE_HEAD");
      await fs.writeFile(mergeHeadPath, "0000000000000000000000000000000000000000\n");

      await expect(
        bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: remoteRepoDir,
          workspaceKey: "GH-79",
        }),
      ).rejects.toMatchObject({
        code: "git_operation_in_progress",
      });
    });

    it("工作区在非目标分支且包含未提交改动时拒绝切换分支 (dirty_working_tree_on_switch)", async () => {
      await bootstrapRepository({
        cwd: workspaceDir,
        repoUrl: remoteRepoDir,
        issueBranch: "symphony/GH-79",
      });

      // 切换到 main
      execSync("git checkout main", { cwd: workspaceDir });
      // 写入未提交文件
      await fs.writeFile(path.join(workspaceDir, "dirty.txt"), "modified on main\n");

      await expect(
        bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: remoteRepoDir,
          issueBranch: "symphony/GH-79",
        }),
      ).rejects.toMatchObject({
        code: "dirty_working_tree_on_switch",
      });
    });

    it("非法分支名通过 git check-ref-format 校验拒绝 (invalid_branch_name)", async () => {
      await expect(
        bootstrapRepository({
          cwd: workspaceDir,
          repoUrl: remoteRepoDir,
          issueBranch: "bad..branch",
        }),
      ).rejects.toMatchObject({
        code: "invalid_branch_name",
      });
    });

    it("带敏感 Token 的 URL 报错时不泄露密码", async () => {
      const sensitiveUrl = "https://bot:secret_gh_token_12345@github.com/org/nonexistent-repo.git";
      const emptyDir = path.join(tmpBase, "empty-ws");
      await fs.mkdir(emptyDir, { recursive: true });

      try {
        await bootstrapRepository({
          cwd: emptyDir,
          repoUrl: sensitiveUrl,
          timeoutMs: 5000,
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(RepositoryBootstrapError);
        const e = err as RepositoryBootstrapError;
        expect(e.message).not.toContain("secret_gh_token_12345");
        expect(e.sanitizedUrl).toBe("https://***:***@github.com/org/nonexistent-repo.git");
      }
    });
  });

  describe("CLI 执行入口 (runRepositoryBootstrapCli)", () => {
    it("parseRepositoryBootstrapArgs 正确解析选项与位置参数", () => {
      const parsed1 = parseRepositoryBootstrapArgs([
        "--repo",
        "https://github.com/org/repo.git",
        "--branch",
        "my-branch",
        "--user-name",
        "Alice",
      ]);
      expect(parsed1.repoUrl).toBe("https://github.com/org/repo.git");
      expect(parsed1.issueBranch).toBe("my-branch");
      expect(parsed1.userName).toBe("Alice");

      const parsed2 = parseRepositoryBootstrapArgs(["https://github.com/org/repo2.git"]);
      expect(parsed2.repoUrl).toBe("https://github.com/org/repo2.git");

      const parsedHelp = parseRepositoryBootstrapArgs(["--help"]);
      expect(parsedHelp.help).toBe(true);
    });

    it("执行 --help 输出使用说明并返回 0", async () => {
      let out = "";
      const code = await runRepositoryBootstrapCli(["--help"], {
        stdout: { write: (msg) => (out += msg) },
      });
      expect(code).toBe(0);
      expect(out).toContain("Usage: symphony repo-bootstrap");
    });

    it("缺少 repo URL 时输出错误并返回 1", async () => {
      let err = "";
      const code = await runRepositoryBootstrapCli([], {
        stderr: { write: (msg) => (err += msg) },
      });
      expect(code).toBe(1);
      expect(err).toContain("missing required repository URL");
    });

    it("成功执行 bootstrap 输出摘要并返回 0", async () => {
      let out = "";
      const code = await runRepositoryBootstrapCli(
        ["--repo", remoteRepoDir, "--cwd", workspaceDir, "--workspace-key", "GH-79"],
        { stdout: { write: (msg) => (out += msg) } },
      );
      expect(code).toBe(0);
      expect(out).toContain("repo-bootstrap: ready on branch symphony/GH-79");
    });
  });
});
