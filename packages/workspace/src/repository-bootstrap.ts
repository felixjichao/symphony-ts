import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deriveWorkspaceKey } from "@symphony/domain";

/**
 * 仓库 bootstrap 错误码（SPEC §9 / §17.2）。
 */
export type RepositoryBootstrapErrorCode =
  | "invalid_repository_url"
  | "invalid_workspace_path"
  | "unrecognized_non_empty_directory"
  | "repository_url_mismatch"
  | "git_operation_in_progress"
  | "dirty_working_tree_on_switch"
  | "invalid_branch_name"
  | "missing_remote_default_branch"
  | "git_not_found"
  | "git_command_failed"
  | "git_command_timeout";

/**
 * 仓库 bootstrap 专用类型化错误。
 */
export class RepositoryBootstrapError extends Error {
  readonly code: RepositoryBootstrapErrorCode;
  readonly phase?: string | undefined;
  readonly sanitizedUrl?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: RepositoryBootstrapErrorCode,
    message: string,
    options?: {
      phase?: string | undefined;
      sanitizedUrl?: string | undefined;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RepositoryBootstrapError";
    this.code = code;
    if (options?.phase !== undefined) {
      this.phase = options.phase;
    }
    if (options?.sanitizedUrl !== undefined) {
      this.sanitizedUrl = options.sanitizedUrl;
    }
    this.details = {
      ...(options?.details ?? {}),
      ...(options?.phase !== undefined ? { phase: options.phase } : {}),
      ...(options?.sanitizedUrl !== undefined ? { sanitizedUrl: options.sanitizedUrl } : {}),
    };
  }
}

/**
 * {@link bootstrapRepository} 的调用参数。
 */
export interface BootstrapRepositoryOptions {
  /** 目标工作区目录，默认为 `process.cwd()`。 */
  readonly cwd?: string | undefined;
  /** 目标 Git 仓库地址（如 https://github.com/org/repo.git 或本地 path）。必填。 */
  readonly repoUrl: string;
  /** 确定性 issue 分支名。缺省时默认使用 `symphony/${workspaceKey}`。 */
  readonly issueBranch?: string | undefined;
  /** 确定性 workspaceKey（净化后 identifier）。缺省时从 SYMPHONY_WORKSPACE_KEY 或 cwd basename 推导。 */
  readonly workspaceKey?: string | undefined;
  /** 关联 issue 真实 identifier（如 GH-79），可选。 */
  readonly identifier?: string | undefined;
  /** 本地 git 配置 user.name，默认为 `symphony[bot]`。 */
  readonly userName?: string | undefined;
  /** 本地 git 配置 user.email，默认为 `symphony[bot]@users.noreply.github.com`。 */
  readonly userEmail?: string | undefined;
  /** 每条 Git 命令超时（毫秒），默认为 60_000。 */
  readonly timeoutMs?: number | undefined;
  /** 安全日志回调（不泄露凭据）。 */
  readonly log?: ((message: string) => void) | undefined;
}

/**
 * {@link bootstrapRepository} 的结构化返回结果。
 */
export interface BootstrapRepositoryResult {
  /** 运行状态：cloned（全新拉取）、reused（复用分支）、fast_forwarded（快进同步默认分支）。 */
  readonly status: "cloned" | "reused" | "fast_forwarded";
  /** 工作区绝对路径。 */
  readonly workspacePath: string;
  /** 目标仓库地址（未脱敏的入参值，供调用方比对）。 */
  readonly repoUrl: string;
  /** 远端发现的默认分支（如 main、master 等）。 */
  readonly defaultBranch: string;
  /** 当前切入的确定性 issue 分支。 */
  readonly issueBranch: string;
  /** 当前 HEAD commit SHA。 */
  readonly headCommit: string;
}

/**
 * {@link BootstrapRepositoryOptions} 的别名。
 */
export type RepositoryBootstrapOptions = BootstrapRepositoryOptions;

/**
 * {@link BootstrapRepositoryResult} 的别名。
 */
export type RepositoryBootstrapResult = BootstrapRepositoryResult;

/**
 * 脱敏 URL 中的凭据（token / 密码）。
 */
export function sanitizeRepoUrl(url: string): string {
  return url.replace(/(https?:\/\/)([^@\s/]+)@/gi, (_match, proto, userinfo: string) => {
    return userinfo.includes(":") ? `${proto}***:***@` : `${proto}***@`;
  });
}

/**
 * 规范化 Git URL 用于同源匹配比较。
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.trim();
  normalized = normalized.replace(/\/+$/, "");
  normalized = normalized.replace(/^(https?:\/\/)[^@]+@/, "$1");
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  return normalized;
}

function sanitizeText(text: string, repoUrl: string): string {
  let result = text;
  const credMatch = repoUrl.match(/https?:\/\/([^@\s/]+)@/i);
  if (credMatch && credMatch[1]) {
    const userinfo = credMatch[1];
    result = result.split(userinfo).join("***");
    try {
      result = result.split(encodeURIComponent(userinfo)).join("***");
    } catch {
      // ignore URI decode error
    }
    if (userinfo.includes(":")) {
      const parts = userinfo.split(":");
      for (const part of parts) {
        if (part.length > 0) {
          result = result.split(part).join("***");
          try {
            result = result.split(encodeURIComponent(part)).join("***");
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return sanitizeRepoUrl(result);
}

interface GitExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 忽略已退出
    }
  }
}

async function execGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  envOverride?: Record<string, string>,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn("git", args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...envOverride,
      },
    });

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (result: GitExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      killProcessGroup(child.pid);
      fail(
        new RepositoryBootstrapError(
          "git_command_timeout",
          `Git command "git ${args[0] ?? ""}" timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 1024 * 1024) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 1024 * 1024) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        fail(new RepositoryBootstrapError("git_not_found", "git executable not found in PATH", { cause: err }));
      } else {
        fail(new RepositoryBootstrapError("git_command_failed", `Failed to spawn git: ${err.message}`, { cause: err }));
      }
    });

    child.on("close", (code, signal) => {
      finish({
        exitCode: code ?? (signal ? 128 : 0),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function discoverDefaultBranch(
  cwd: string,
  timeoutMs: number,
  repoUrl: string,
): Promise<string> {
  // 1. 尝试主动向远端刷新 origin/HEAD（覆盖远端默认分支变更场景）
  await execGit(["remote", "set-head", "origin", "--auto"], cwd, timeoutMs);
  let res = await execGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd, timeoutMs);
  if (res.exitCode === 0 && res.stdout) {
    const prefix = "origin/";
    if (res.stdout.startsWith(prefix)) {
      return res.stdout.slice(prefix.length);
    }
    return res.stdout;
  }

  // 2. 尝试通过 git ls-remote --symref origin HEAD 实时查询远端 HEAD
  const lsRes = await execGit(["ls-remote", "--symref", "origin", "HEAD"], cwd, timeoutMs);
  if (lsRes.exitCode === 0 && lsRes.stdout) {
    const match = lsRes.stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    if (match && match[1]) {
      const branch = match[1];
      // 同步更新本地 origin/HEAD
      await execGit(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], cwd, timeoutMs);
      return branch;
    }
  }

  // 3. 检查本地既有 refs/remotes/origin/HEAD（离线/网络受限下的安全降级）
  res = await execGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd, timeoutMs);
  if (res.exitCode === 0 && res.stdout) {
    const prefix = "origin/";
    if (res.stdout.startsWith(prefix)) {
      return res.stdout.slice(prefix.length);
    }
    return res.stdout;
  }

  // 严禁以当前 issue branch 冒充远端默认分支！无法确定时明确失败
  throw new RepositoryBootstrapError(
    "missing_remote_default_branch",
    `Could not determine default branch for repository ${sanitizeRepoUrl(repoUrl)}`,
    { sanitizedUrl: sanitizeRepoUrl(repoUrl) },
  );
}

async function validateBranchName(branch: string, cwd: string, timeoutMs: number): Promise<void> {
  if (!branch || branch.trim().length === 0) {
    throw new RepositoryBootstrapError("invalid_branch_name", "Branch name cannot be empty");
  }
  const res = await execGit(["check-ref-format", "--branch", branch], cwd, timeoutMs);
  if (res.exitCode !== 0) {
    throw new RepositoryBootstrapError(
      "invalid_branch_name",
      `Invalid git branch name "${branch}": does not conform to git check-ref-format rules`,
    );
  }
}

async function checkIntermediateGitState(gitDir: string): Promise<void> {
  const intermediateMarkers = [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
  ];
  for (const marker of intermediateMarkers) {
    try {
      await fs.stat(path.join(gitDir, marker));
      throw new RepositoryBootstrapError(
        "git_operation_in_progress",
        `Git repository is in an intermediate state (${marker} exists); bootstrap refused to alter working state`,
      );
    } catch (err) {
      if (err instanceof RepositoryBootstrapError) throw err;
      // ENOENT 属正常状态
    }
  }
}

async function isWorkingTreeClean(cwd: string, timeoutMs: number): Promise<boolean> {
  const res = await execGit(["status", "--porcelain"], cwd, timeoutMs);
  if (res.exitCode !== 0) {
    throw new RepositoryBootstrapError(
      "git_command_failed",
      `Failed to check git status in ${cwd}: ${res.stderr}`,
    );
  }
  return res.stdout.length === 0;
}

async function isAncestor(ancestor: string, descendant: string, cwd: string, timeoutMs: number): Promise<boolean> {
  const res = await execGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd, timeoutMs);
  return res.exitCode === 0;
}

async function localBranchExists(branch: string, cwd: string, timeoutMs: number): Promise<boolean> {
  const res = await execGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd, timeoutMs);
  return res.exitCode === 0;
}

async function remoteBranchExists(remoteBranch: string, cwd: string, timeoutMs: number): Promise<boolean> {
  const res = await execGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${remoteBranch}`], cwd, timeoutMs);
  return res.exitCode === 0;
}

/**
 * 执行目标 Git 仓库在 per-issue workspace 目录的 bootstrap 与 issue 分支维护（SPEC §9 / §17.2）。
 *
 * 保证：
 * 1. 全新目录：clone 目标仓库，通过 remote HEAD 发现默认分支，建立确定性 issue 分支；
 * 2. 既有目录：校验仓库根目录与 origin 一致性，防串仓；中间态安全拒绝；
 * 3. 默认分支同步：工作区干净且 HEAD 为默认分支祖先时安全 fast-forward；存在工作区修改或独立提交时不破坏；
 * 4. 凭据隔离：不把密码/token 输出至日志；
 * 5. Git identity：在 repo 内设置 local user.name / user.email。
 */
export async function bootstrapRepository(
  options: BootstrapRepositoryOptions,
): Promise<BootstrapRepositoryResult> {
  const rawUrl = options.repoUrl?.trim();
  if (!rawUrl) {
    throw new RepositoryBootstrapError(
      "invalid_repository_url",
      "Repository URL must be a non-empty string",
    );
  }
  const sanitizedUrl = sanitizeRepoUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cwd = path.resolve(options.cwd ?? process.cwd());

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(cwd);
  } catch (err) {
    throw new RepositoryBootstrapError(
      "invalid_workspace_path",
      `Workspace directory does not exist or is inaccessible: ${cwd}`,
      { cause: err, sanitizedUrl },
    );
  }
  if (!stat.isDirectory()) {
    throw new RepositoryBootstrapError(
      "invalid_workspace_path",
      `Workspace path is not a directory: ${cwd}`,
      { sanitizedUrl },
    );
  }

  const gitDir = path.join(cwd, ".git");
  let gitDirExists = false;
  try {
    const gitStat = await fs.stat(gitDir);
    gitDirExists = gitStat.isDirectory();
  } catch {
    gitDirExists = false;
  }

  const workspaceKey =
    options.workspaceKey ??
    process.env.SYMPHONY_WORKSPACE_KEY ??
    (options.identifier ? deriveWorkspaceKey(options.identifier) : path.basename(cwd));
  const issueBranch = options.issueBranch ?? `symphony/${workspaceKey}`;

  let status: "cloned" | "reused" | "fast_forwarded";
  let defaultBranch: string;

  if (!gitDirExists) {
    const entries = await fs.readdir(cwd);
    if (entries.length > 0) {
      throw new RepositoryBootstrapError(
        "unrecognized_non_empty_directory",
        `Workspace directory is not empty and does not contain a git repository: ${cwd}`,
        { sanitizedUrl },
      );
    }

    await validateBranchName(issueBranch, cwd, timeoutMs);

    options.log?.(`Cloning repository from ${sanitizedUrl}...`);
    const cloneRes = await execGit(["clone", rawUrl, "."], cwd, timeoutMs);
    if (cloneRes.exitCode !== 0) {
      try {
        const remaining = await fs.readdir(cwd);
        for (const item of remaining) {
          await fs.rm(path.join(cwd, item), { recursive: true, force: true });
        }
      } catch {
        // 清理失败忽略
      }
      throw new RepositoryBootstrapError(
        "git_command_failed",
        `Failed to clone repository: ${sanitizeText(cloneRes.stderr, rawUrl)}`,
        { phase: "clone", sanitizedUrl },
      );
    }

    defaultBranch = await discoverDefaultBranch(cwd, timeoutMs, rawUrl);

    const hasRemoteIssueBranch = await remoteBranchExists(issueBranch, cwd, timeoutMs);
    if (hasRemoteIssueBranch) {
      const coRes = await execGit(["checkout", "-b", issueBranch, "--track", `origin/${issueBranch}`], cwd, timeoutMs);
      if (coRes.exitCode !== 0) {
        throw new RepositoryBootstrapError(
          "git_command_failed",
          `Failed to checkout remote issue branch ${issueBranch}: ${coRes.stderr}`,
          { phase: "checkout", sanitizedUrl },
        );
      }
      const canFf = await isAncestor("HEAD", `origin/${defaultBranch}`, cwd, timeoutMs);
      if (canFf) {
        const headRev = await execGit(["rev-parse", "HEAD"], cwd, timeoutMs);
        const remoteDefRev = await execGit(["rev-parse", `origin/${defaultBranch}`], cwd, timeoutMs);
        if (headRev.stdout === remoteDefRev.stdout) {
          status = "reused";
        } else {
          const ffRes = await execGit(["merge", "--ff-only", `origin/${defaultBranch}`], cwd, timeoutMs);
          if (ffRes.exitCode !== 0) {
            throw new RepositoryBootstrapError(
              "git_command_failed",
              `Failed to fast-forward remote issue branch ${issueBranch} to origin/${defaultBranch}: ${sanitizeText(ffRes.stderr, rawUrl)}`,
              { phase: "fast_forward", sanitizedUrl },
            );
          }
          status = "fast_forwarded";
        }
      } else {
        status = "reused";
      }
    } else {
      const coRes = await execGit(["checkout", "-b", issueBranch, `origin/${defaultBranch}`], cwd, timeoutMs);
      if (coRes.exitCode !== 0) {
        throw new RepositoryBootstrapError(
          "git_command_failed",
          `Failed to create issue branch ${issueBranch} from origin/${defaultBranch}: ${coRes.stderr}`,
          { phase: "checkout", sanitizedUrl },
        );
      }
      status = "cloned";
    }
  } else {
    const toplevelRes = await execGit(["rev-parse", "--show-toplevel"], cwd, timeoutMs);
    if (toplevelRes.exitCode !== 0) {
      throw new RepositoryBootstrapError(
        "unrecognized_non_empty_directory",
        `Workspace directory ${cwd} is not a valid git repository`,
        { sanitizedUrl },
      );
    }
    const realCwd = await fs.realpath(cwd);
    const realTop = await fs.realpath(toplevelRes.stdout);
    if (realCwd !== realTop) {
      throw new RepositoryBootstrapError(
        "unrecognized_non_empty_directory",
        `Workspace directory ${cwd} is inside git repo at ${realTop}, not its own repository root`,
        { sanitizedUrl },
      );
    }

    const remoteUrlRes = await execGit(["remote", "get-url", "origin"], cwd, timeoutMs);
    if (remoteUrlRes.exitCode !== 0) {
      throw new RepositoryBootstrapError(
        "repository_url_mismatch",
        `Existing git repository at ${cwd} has no origin remote configured`,
        { sanitizedUrl },
      );
    }
    const existingOrigin = remoteUrlRes.stdout;
    if (normalizeGitUrl(existingOrigin) !== normalizeGitUrl(rawUrl)) {
      const sanitizedExistingOrigin = sanitizeRepoUrl(existingOrigin);
      throw new RepositoryBootstrapError(
        "repository_url_mismatch",
        `Existing git repository origin "${sanitizedExistingOrigin}" does not match requested "${sanitizedUrl}"`,
        { sanitizedUrl, details: { existingOrigin: sanitizedExistingOrigin } },
      );
    }

    await checkIntermediateGitState(gitDir);
    await validateBranchName(issueBranch, cwd, timeoutMs);

    options.log?.(`Fetching origin for ${sanitizedUrl}...`);
    const fetchRes = await execGit(["fetch", "--prune", "origin"], cwd, timeoutMs);
    if (fetchRes.exitCode !== 0) {
      throw new RepositoryBootstrapError(
        "git_command_failed",
        `Failed to fetch from origin: ${sanitizeText(fetchRes.stderr, rawUrl)}`,
        { phase: "fetch", sanitizedUrl },
      );
    }

    defaultBranch = await discoverDefaultBranch(cwd, timeoutMs, rawUrl);

    const curBranchRes = await execGit(["symbolic-ref", "--short", "HEAD"], cwd, timeoutMs);
    const currentBranch = curBranchRes.exitCode === 0 ? curBranchRes.stdout : null;
    const hasLocalBranch = await localBranchExists(issueBranch, cwd, timeoutMs);

    if (currentBranch !== issueBranch) {
      const clean = await isWorkingTreeClean(cwd, timeoutMs);
      if (!clean) {
        throw new RepositoryBootstrapError(
          "dirty_working_tree_on_switch",
          `Cannot switch from current branch "${currentBranch ?? "detached HEAD"}" to "${issueBranch}": working tree contains uncommitted changes`,
          { sanitizedUrl },
        );
      }

      if (hasLocalBranch) {
        const coRes = await execGit(["checkout", issueBranch], cwd, timeoutMs);
        if (coRes.exitCode !== 0) {
          throw new RepositoryBootstrapError(
            "git_command_failed",
            `Failed to checkout existing branch ${issueBranch}: ${coRes.stderr}`,
            { phase: "checkout", sanitizedUrl },
          );
        }
      } else {
        const hasRemoteBranch = await remoteBranchExists(issueBranch, cwd, timeoutMs);
        if (hasRemoteBranch) {
          const coRes = await execGit(["checkout", "-b", issueBranch, "--track", `origin/${issueBranch}`], cwd, timeoutMs);
          if (coRes.exitCode !== 0) {
            throw new RepositoryBootstrapError(
              "git_command_failed",
              `Failed to checkout remote issue branch ${issueBranch}: ${coRes.stderr}`,
              { phase: "checkout", sanitizedUrl },
            );
          }
        } else {
          const coRes = await execGit(["checkout", "-b", issueBranch, `origin/${defaultBranch}`], cwd, timeoutMs);
          if (coRes.exitCode !== 0) {
            throw new RepositoryBootstrapError(
              "git_command_failed",
              `Failed to create issue branch ${issueBranch} from origin/${defaultBranch}: ${coRes.stderr}`,
              { phase: "checkout", sanitizedUrl },
            );
          }
        }
      }
    }

    const cleanOnIssueBranch = await isWorkingTreeClean(cwd, timeoutMs);
    if (!cleanOnIssueBranch) {
      status = "reused";
    } else {
      const canFf = await isAncestor("HEAD", `origin/${defaultBranch}`, cwd, timeoutMs);
      if (canFf) {
        const headRev = await execGit(["rev-parse", "HEAD"], cwd, timeoutMs);
        const remoteDefRev = await execGit(["rev-parse", `origin/${defaultBranch}`], cwd, timeoutMs);
        if (headRev.stdout === remoteDefRev.stdout) {
          status = "reused";
        } else {
          const mergeRes = await execGit(["merge", "--ff-only", `origin/${defaultBranch}`], cwd, timeoutMs);
          if (mergeRes.exitCode !== 0) {
            throw new RepositoryBootstrapError(
              "git_command_failed",
              `Failed to fast-forward issue branch ${issueBranch} to origin/${defaultBranch}: ${sanitizeText(mergeRes.stderr, rawUrl)}`,
              { phase: "fast_forward", sanitizedUrl },
            );
          }
          status = "fast_forwarded";
        }
      } else {
        status = "reused";
      }
    }
  }

  const userName =
    options.userName ??
    process.env.SYMPHONY_GIT_USER_NAME ??
    process.env.GIT_AUTHOR_NAME ??
    "symphony[bot]";
  const userEmail =
    options.userEmail ??
    process.env.SYMPHONY_GIT_USER_EMAIL ??
    process.env.GIT_AUTHOR_EMAIL ??
    "symphony[bot]@users.noreply.github.com";

  const nameRes = await execGit(["config", "user.name", userName], cwd, timeoutMs);
  if (nameRes.exitCode !== 0) {
    throw new RepositoryBootstrapError(
      "git_command_failed",
      `Failed to configure git user.name: ${sanitizeText(nameRes.stderr, rawUrl)}`,
      { phase: "config_identity", sanitizedUrl },
    );
  }
  const emailRes = await execGit(["config", "user.email", userEmail], cwd, timeoutMs);
  if (emailRes.exitCode !== 0) {
    throw new RepositoryBootstrapError(
      "git_command_failed",
      `Failed to configure git user.email: ${sanitizeText(emailRes.stderr, rawUrl)}`,
      { phase: "config_identity", sanitizedUrl },
    );
  }

  const headRes = await execGit(["rev-parse", "HEAD"], cwd, timeoutMs);
  if (headRes.exitCode !== 0 || !headRes.stdout) {
    throw new RepositoryBootstrapError(
      "git_command_failed",
      `Failed to resolve HEAD commit: ${sanitizeText(headRes.stderr, rawUrl)}`,
      { phase: "resolve_head", sanitizedUrl },
    );
  }
  const headCommit = headRes.stdout;

  return {
    status,
    workspacePath: cwd,
    repoUrl: rawUrl,
    defaultBranch,
    issueBranch,
    headCommit,
  };
}

/**
 * CLI I/O 抽象接口。
 */
export interface BootstrapCliIo {
  readonly stdout?: { write(text: string): unknown } | undefined;
  readonly stderr?: { write(text: string): unknown } | undefined;
}

/**
 * 解析后的命令行参数。
 */
export interface ParsedRepositoryBootstrapArgs {
  readonly help: boolean;
  readonly repoUrl?: string | undefined;
  readonly target?: string | undefined;
  readonly cwd?: string | undefined;
  readonly issueBranch?: string | undefined;
  readonly workspaceKey?: string | undefined;
  readonly userName?: string | undefined;
  readonly userEmail?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly error?: string | undefined;
}

/**
 * 解析 repository bootstrap 命令行参数。
 */
export function parseRepositoryBootstrapArgs(argv: readonly string[]): ParsedRepositoryBootstrapArgs {
  let help = false;
  let repoUrl: string | undefined;
  let issueBranch: string | undefined;
  let workspaceKey: string | undefined;
  let userName: string | undefined;
  let userEmail: string | undefined;
  let target: string | undefined;
  let timeoutMs: number | undefined;
  let error: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo" || arg === "-r") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --repo requires a value";
        break;
      }
      repoUrl = argv[++i];
    } else if (arg === "--branch" || arg === "-b") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --branch requires a value";
        break;
      }
      issueBranch = argv[++i];
    } else if (arg === "--workspace-key" || arg === "-k") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --workspace-key requires a value";
        break;
      }
      workspaceKey = argv[++i];
    } else if (arg === "--user-name") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --user-name requires a value";
        break;
      }
      userName = argv[++i];
    } else if (arg === "--user-email") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --user-email requires a value";
        break;
      }
      userEmail = argv[++i];
    } else if (arg === "--target" || arg === "-t" || arg === "--cwd") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = `Option ${arg} requires a value`;
        break;
      }
      target = argv[++i];
    } else if (arg === "--timeout-ms") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        error = "Option --timeout-ms requires a value";
        break;
      }
      const val = argv[++i]!;
      const parsed = parseInt(val, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        error = `Invalid --timeout-ms value "${val}": must be a positive integer`;
        break;
      }
      timeoutMs = parsed;
    } else if (arg.startsWith("-")) {
      error = `Unknown option: ${arg}`;
      break;
    } else {
      if (repoUrl === undefined) {
        repoUrl = arg;
      } else {
        error = `Unexpected positional argument: ${arg}`;
        break;
      }
    }
  }

  return {
    help,
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    ...(issueBranch !== undefined ? { issueBranch } : {}),
    ...(workspaceKey !== undefined ? { workspaceKey } : {}),
    ...(userName !== undefined ? { userName } : {}),
    ...(userEmail !== undefined ? { userEmail } : {}),
    ...(target !== undefined ? { target, cwd: target } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * 命令行执行入口。
 */
export async function runRepositoryBootstrapCli(
  argv: readonly string[],
  io: BootstrapCliIo = {},
): Promise<number> {
  const parsed = parseRepositoryBootstrapArgs(argv);

  if (parsed.help) {
    io.stdout?.write(
      "Usage: symphony repo-bootstrap [options] [repo-url]\n\n" +
      "Bootstrap git repository in workspace and create/reuse deterministic issue branch.\n\n" +
      "Options:\n" +
      "  --repo, -r <url>          Target repository URL\n" +
      "  --target, -t <path>       Workspace target directory (defaults to process.cwd())\n" +
      "  --branch, -b <name>       Issue branch name (defaults to symphony/<workspaceKey>)\n" +
      "  --workspace-key, -k <key> Workspace key (defaults to SYMPHONY_WORKSPACE_KEY or target basename)\n" +
      "  --user-name <name>        Git user.name (defaults to symphony[bot])\n" +
      "  --user-email <email>      Git user.email (defaults to symphony[bot]@users.noreply.github.com)\n" +
      "  --cwd <path>              Alias for --target\n" +
      "  --timeout-ms <ms>         Timeout in milliseconds for git operations\n" +
      "  -h, --help                Show this help message\n"
    );
    return 0;
  }

  if (parsed.error) {
    io.stderr?.write(`repo-bootstrap: ${parsed.error}\n`);
    return 1;
  }

  const repoUrl = parsed.repoUrl ?? process.env.SYMPHONY_REPO_URL ?? process.env.REPO_URL;
  if (!repoUrl || repoUrl.trim().length === 0) {
    io.stderr?.write("repo-bootstrap: missing required repository URL (--repo <url>)\n");
    return 1;
  }

  try {
    const targetDir = parsed.target ?? parsed.cwd;
    const result = await bootstrapRepository({
      cwd: targetDir,
      repoUrl,
      issueBranch: parsed.issueBranch,
      workspaceKey: parsed.workspaceKey,
      userName: parsed.userName,
      userEmail: parsed.userEmail,
      timeoutMs: parsed.timeoutMs,
      log: (msg) => io.stdout?.write(`repo-bootstrap: ${msg}\n`),
    });

    io.stdout?.write(
      `repo-bootstrap: ready on branch ${result.issueBranch} (${result.status}) at ${result.headCommit.slice(0, 8)}\n`
    );
    return 0;
  } catch (error) {
    const rawMessage =
      error instanceof RepositoryBootstrapError
        ? `repo-bootstrap failed (${error.code}): ${error.message}\n`
        : `repo-bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`;
    io.stderr?.write(sanitizeText(rawMessage, repoUrl));
    return 1;
  }
}
