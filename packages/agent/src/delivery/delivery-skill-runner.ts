import {
  evaluateCiChecksPolicy,
  formatDeliveryHandoffMarkdown,
  formatPrBody,
  parsePrOwnershipMarker,
  validatePrOwnership,
  type CiCheckItem,
  type CiCheckStatus,
  type DeliveryContext,
  type DeliveryHandoff,
  type DeliverySkillConfig,
  type DeliverySkillResult,
  type PersistedDeliveryState,
} from "@symphony/domain";

import type { DeliveryGitGhRunner } from "./git-gh-runner";

export interface DeliveryStateStorage {
  readState(): Promise<PersistedDeliveryState | null> | PersistedDeliveryState | null;
  writeState(state: PersistedDeliveryState): Promise<void> | void;
}

export interface RunDeliverySkillOptions extends DeliverySkillConfig {
  readonly cwd: string;
  readonly runner: DeliveryGitGhRunner;
  readonly stateStorage?: DeliveryStateStorage | undefined;
  readonly repairFn?: (failureContext: string) => Promise<boolean> | boolean;
  readonly sleepFn?: (seconds: number) => Promise<void>;
  readonly nowFn?: (() => number) | undefined;
  readonly log?: (msg: string) => void;
}

const DEFAULT_READY_LABEL = "symphony-ready";
const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_MAX_WAIT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export function parseGitHubRepoFromRemote(remoteUrl: string): { host: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  // 1. SSH format: git@github.com:owner/repo.git
  const scpMatch = trimmed.match(/^(?:[\w.-]+@)?([^:/]+):([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (scpMatch) {
    return {
      host: scpMatch[1]!.toLowerCase(),
      repo: scpMatch[2]!,
    };
  }

  // 2. URL format: https://github.com/owner/repo.git
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const cleanPath = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length === 2) {
      return {
        host,
        repo: `${parts[0]}/${parts[1]}`,
      };
    }
  } catch {
    // invalid URL or local directory
  }

  return null;
}

function repoOriginMatches(remoteUrl: string, expectedRepo: string): boolean {
  const parsed = parseGitHubRepoFromRemote(remoteUrl);
  if (!parsed) return false;
  if (parsed.host !== "github.com") return false;
  return parsed.repo.toLowerCase() === expectedRepo.trim().toLowerCase();
}

async function fetchCiFailureDiagnostics(
  runner: DeliveryGitGhRunner,
  repo: string,
  headSha: string,
  failedChecks: readonly CiCheckItem[],
  cwd: string,
): Promise<{ diagnostics: string; isInfraOrPermissionFailure: boolean }> {
  let logExcerpt = "";
  let isInfraOrPermission = false;

  try {
    const runListRes = await runner.gh(
      ["run", "list", "--repo", repo, "--commit", headSha, "--json", "databaseId,name,status,conclusion"],
      cwd,
    );
    if (runListRes.exitCode === 0) {
      const runs = JSON.parse(runListRes.stdout || "[]");
      const failedRun = Array.isArray(runs)
        ? runs.find((r: { conclusion?: string }) => {
            const c = String(r.conclusion || "").toUpperCase();
            return c === "FAILURE" || c === "TIMED_OUT" || c === "STARTUP_FAILURE";
          })
        : undefined;
      if (failedRun && failedRun.databaseId) {
        const runLogRes = await runner.gh(
          ["run", "view", String(failedRun.databaseId), "--repo", repo, "--log-failed"],
          cwd,
        );
        if (runLogRes.exitCode === 0 && runLogRes.stdout.trim()) {
          const lines = runLogRes.stdout.split("\n");
          logExcerpt = lines.slice(-100).join("\n");
        }
      }
    }
  } catch {
    // ignore
  }

  const combinedText =
    logExcerpt ||
    failedChecks
      .map((c) => `${c.name}: status=${c.status}, conclusion=${c.conclusion ?? "none"}, url=${c.detailsUrl ?? "none"}`)
      .join("; ");

  const lower = combinedText.toLowerCase();
  if (
    lower.includes("resource not accessible by integration") ||
    lower.includes("permission denied") ||
    lower.includes("bad credentials") ||
    lower.includes("runner system failure") ||
    lower.includes("no space left on device") ||
    lower.includes("billing")
  ) {
    isInfraOrPermission = true;
  }

  return {
    diagnostics: combinedText,
    isInfraOrPermissionFailure: isInfraOrPermission,
  };
}

/**
 * 执行 Codex Delivery + Land Workflow Skill 主链路。
 *
 * 核心阶段：
 * 1. Pre-mutation Inspection: 核对当前分支、origin 仓库、Issue 状态以及现有 PR（--state all 覆盖终态与 foreign PR）。
 * 2. Run Project Validation: 真实执行项目验证命令，失败时禁止 commit/push/merge。
 * 3. Commit: 检查工作区脏状态，提交改动。
 * 4. Push: 推送到远端。
 * 5. Ensure PR: 创建新 PR 或复用合法 PR。
 * 6. CI Inspection & Repair Loop:
 *    - 通过 `gh pr view --json statusCheckRollup,headRefOid,mergeable,state` 兼容各版本 gh 并关联推送 SHA。
 *    - 严格检查所有 observed 与 required checks（均为 success）。
 *    - CI 失败时，读取诊断，调用 repairFn 或 repairCommand，重新运行验证，确认生成新 commit 与新 SHA 后再重新推测 CI。
 *    - 维护跨尝试持久化预算与实际墙上时钟 deadline。
 * 7. Land when policy satisfied:
 *    - 仅在明确 optInLand 时执行 squash merge。
 *    - 校验 mergeability，校验 merge 退出码与 MERGED 终态，校验关联 Issue 关闭状态。
 * 8. Blocker/Budget Exhausted:
 *    - 尝试移除 ready 标签，重新核对标签状态，诚实记录移除与评论结果。
 *    - 持久化 paused 状态，阻止未显式 --resume 的重入。
 */
export async function runDeliverySkill(
  options: RunDeliverySkillOptions,
): Promise<DeliverySkillResult> {
  const runner = options.runner;
  const sleep = options.sleepFn ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000)));
  const log = options.log ?? (() => {});

  const readyLabel = options.readyLabel ?? DEFAULT_READY_LABEL;
  const maxRepairs = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIRS;
  const maxWaitSeconds = options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const pollInterval = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;

  const context: DeliveryContext = {
    repo: options.repo,
    issueNumber: options.issueNumber,
    workspaceKey: options.workspaceKey,
    headBranch: options.headBranch,
    baseBranch: options.baseBranch,
  };

  const stateStorage = options.stateStorage;
  let persisted: PersistedDeliveryState | null = null;
  if (stateStorage) {
    try {
      persisted = await stateStorage.readState();
    } catch (err) {
      log(`[delivery-skill] Error reading state storage: ${String(err)}`);
      return {
        status: "blocked",
        prNumber: null,
        prUrl: null,
        headSha: null,
        spentRepairs: 0,
        spentWaitSeconds: 0,
        reason: "manual_intervention_required",
        handoffMarkdown: `Failed to read persisted delivery state: ${String(err)}`,
      };
    }
  }

  let spentRepairs = 0;
  let initialSpentWaitSeconds = 0;
  let deadlineTimestampMs: number | undefined;

  if (persisted && persisted.repo === context.repo && persisted.issueNumber === context.issueNumber) {
    if (persisted.isPaused && !options.resume) {
      log(`[delivery-skill] Previous delivery paused (${persisted.pauseReason ?? "unknown"}). Refusing to dispatch without resume.`);
      return {
        status: "blocked",
        prNumber: null,
        prUrl: null,
        headSha: null,
        spentRepairs: persisted.spentRepairs,
        spentWaitSeconds: persisted.spentWaitSeconds,
        reason: "manual_intervention_required",
        handoffMarkdown: `Delivery is paused from previous run (${persisted.pauseReason}). Pass --resume to restart.`,
      };
    }
    spentRepairs = persisted.spentRepairs;
    initialSpentWaitSeconds = persisted.spentWaitSeconds;
    deadlineTimestampMs = persisted.deadlineTimestampMs;
  }

  const now = options.nowFn ?? Date.now;
  const startTimeMs = now();
  if (!deadlineTimestampMs || options.resume) {
    deadlineTimestampMs = startTimeMs + Math.max(0, maxWaitSeconds - initialSpentWaitSeconds) * 1000;
  }

  const getElapsedWaitSeconds = (): number => {
    return initialSpentWaitSeconds + Math.floor((now() - startTimeMs) / 1000);
  };

  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let currentHeadSha: string | null = null;

  // 辅助函数：触发 Blocker / 预算耗尽处理并移除 ready 标签停止派发
  const haltDispatch = async (
    reason: DeliveryHandoff["reason"],
    details: string,
  ): Promise<DeliverySkillResult> => {
    log(`[delivery-skill] Blocker/budget reached: ${reason}. Halting dispatch...`);
    const spentWaitSeconds = getElapsedWaitSeconds();

    // 关键动作：从 GitHub Issue 尝试移除 symphony-ready 标签
    let readyLabelRemoved = false;
    let labelVerifyError: string | null = null;
    try {
      const removeRes = await runner.gh(
        ["issue", "edit", String(context.issueNumber), "--repo", context.repo, "--remove-label", readyLabel],
        options.cwd,
      );
      if (removeRes.exitCode !== 0) {
        labelVerifyError = `gh issue edit failed: ${removeRes.stderr}`;
      } else {
        // 重读 Issue 标签事实以确认移除成功
        const checkRes = await runner.gh(
          ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "labels"],
          options.cwd,
        );
        if (checkRes.exitCode !== 0) {
          labelVerifyError = `gh issue view failed: ${checkRes.stderr}`;
        } else {
          try {
            const parsed = JSON.parse(checkRes.stdout || "{}");
            if (!Array.isArray(parsed.labels)) {
              labelVerifyError = "Corrupted labels payload from gh issue view";
            } else {
              const labels: Array<{ name: string } | string> = parsed.labels;
              const hasLabel = labels.some((l) => (typeof l === "string" ? l : l.name) === readyLabel);
              if (hasLabel) {
                labelVerifyError = `Label '${readyLabel}' still present on issue #${context.issueNumber}`;
              } else {
                readyLabelRemoved = true;
              }
            }
          } catch (e) {
            labelVerifyError = `Failed to parse issue labels: ${String(e)}`;
          }
        }
      }
      if (readyLabelRemoved) {
        log(`[delivery-skill] Successfully verified removal of label '${readyLabel}' from issue #${context.issueNumber}`);
      } else {
        log(`[delivery-skill] Warning: Label '${readyLabel}' could not be verified as removed (${labelVerifyError ?? "unverified"})`);
      }
    } catch (err) {
      log(`[delivery-skill] Warning: Exception while removing label '${readyLabel}': ${String(err)}`);
      readyLabelRemoved = false;
    }

    // 发表交接评论（发给 GitHub 时不带 commentPosted 字段，避免预先输出失败警告）
    let commentPosted = false;
    const handoffForRemote: DeliveryHandoff = {
      reason,
      details,
      repo: context.repo,
      issueNumber: context.issueNumber,
      headBranch: context.headBranch,
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      maxRepairs,
      spentWaitSeconds,
      maxWaitSeconds,
      readyLabel,
      readyLabelRemoved,
    };

    const commentBody = formatDeliveryHandoffMarkdown(handoffForRemote);

    try {
      const commentTarget = prNumber !== null ? ["pr", "comment", String(prNumber)] : ["issue", "comment", String(context.issueNumber)];
      const commentRes = await runner.gh(
        [...commentTarget, "--repo", context.repo, "--body", commentBody],
        options.cwd,
      );
      if (commentRes.exitCode === 0) {
        commentPosted = true;
      }
    } catch (err) {
      log(`[delivery-skill] Warning: Failed to post handoff comment: ${String(err)}`);
      commentPosted = false;
    }

    // 更新包含真实 commentPosted 的 markdown 供本地返回
    const handoffMarkdown = formatDeliveryHandoffMarkdown({ ...handoffForRemote, commentPosted });

    // 持久化 paused 状态
    if (stateStorage) {
      await stateStorage.writeState({
        repo: context.repo,
        issueNumber: context.issueNumber,
        workspaceKey: context.workspaceKey,
        spentRepairs,
        spentWaitSeconds,
        deadlineTimestampMs,
        isPaused: true,
        pauseReason: reason,
        lastUpdated: new Date().toISOString(),
      });
    }

    return {
      status: "blocked",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      spentWaitSeconds,
      reason,
      handoffMarkdown,
    };
  };

  // ==========================================
  // Phase 1: Pre-mutation Inspection
  // ==========================================
  log("[delivery-skill] Phase 1: Pre-mutation inspection (branch, remote origin, issue, PRs)...");

  // 1a. 校验 cwd 当前分支
  const branchRes = await runner.git(["branch", "--show-current"], options.cwd);
  if (branchRes.exitCode !== 0 || branchRes.stdout.trim() !== context.headBranch) {
    return haltDispatch(
      "manual_intervention_required",
      `Working directory current branch '${branchRes.stdout.trim()}' does not match target head branch '${context.headBranch}'.`,
    );
  }

  // 1b. 校验 remote origin（严格要求 host 为 github.com 且目标仓库完全一致）
  const remoteRes = await runner.git(["remote", "get-url", "origin"], options.cwd);
  if (remoteRes.exitCode !== 0 || !repoOriginMatches(remoteRes.stdout, context.repo)) {
    return haltDispatch(
      "manual_intervention_required",
      `Working directory origin URL '${remoteRes.stdout.trim()}' does not match expected GitHub repo '${context.repo}'.`,
    );
  }

  // 1c. 校验 Issue 状态
  const issueRes = await runner.gh(
    ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "state,labels,title"],
    options.cwd,
  );
  if (issueRes.exitCode !== 0) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to query GitHub issue #${context.issueNumber}: ${issueRes.stderr}`,
    );
  }

  let issueState = "OPEN";
  try {
    const issueData = JSON.parse(issueRes.stdout || "{}");
    issueState = String(issueData.state || "OPEN").toUpperCase();
  } catch (err) {
    return haltDispatch(
      "manual_intervention_required",
      `Corrupted issue JSON response from gh: ${String(err)}`,
    );
  }

  // 1d. 检查既有 PRs（覆盖 --state all，严格识别已合入、已关闭、冲突与外来 PR）
  const prListRes = await runner.gh(
    [
      "pr",
      "list",
      "--repo",
      context.repo,
      "--head",
      context.headBranch,
      "--base",
      context.baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,title,body,state,headRefOid",
    ],
    options.cwd,
  );

  if (prListRes.exitCode !== 0) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to query pull requests for branch '${context.headBranch}': ${prListRes.stderr}`,
    );
  }

  let existingPrs: Array<{
    number: number;
    url: string;
    title: string;
    body: string;
    state: string;
    headRefOid?: string;
  }> = [];

  try {
    existingPrs = JSON.parse(prListRes.stdout || "[]");
  } catch (err) {
    return haltDispatch(
      "manual_intervention_required",
      `Failed to parse PR list response: ${String(err)}`,
    );
  }

  if (existingPrs.length > 1) {
    return haltDispatch(
      "manual_intervention_required",
      `Ambiguous PR state: found multiple PR candidates (${existingPrs.map((p) => `#${p.number}`).join(", ")}) for branch '${context.headBranch}'.`,
    );
  }

  if (existingPrs.length === 1) {
    const candidate = existingPrs[0]!;
    const marker = parsePrOwnershipMarker(candidate.body);
    // 严格所有权校验：绝不以普通 body 包含 issue 引用绕过 marker！
    const isOwner = validatePrOwnership(marker, context);
    if (!isOwner) {
      return haltDispatch(
        "foreign_pr_conflict",
        `Existing PR #${candidate.number} does not match ownership marker for issue #${context.issueNumber} and workspace '${context.workspaceKey}'. Foreign PR rejected.`,
      );
    }

    if (candidate.state === "MERGED") {
      // 重新从 PR 查询真实 merge commit SHA
      const viewMerged = await runner.gh(
        ["pr", "view", String(candidate.number), "--repo", context.repo, "--json", "state,mergeCommit"],
        options.cwd,
      );
      let realMergeSha: string | null = null;
      if (viewMerged.exitCode === 0) {
        try {
          const v = JSON.parse(viewMerged.stdout || "{}");
          realMergeSha = (v.mergeCommit?.oid as string) ?? null;
        } catch {
          // ignore
        }
      }

      if (issueState === "CLOSED") {
        log(`[delivery-skill] PR #${candidate.number} is MERGED and issue #${context.issueNumber} is CLOSED. Completed.`);
        return {
          status: "completed",
          prNumber: candidate.number,
          prUrl: candidate.url,
          headSha: candidate.headRefOid ?? null,
          mergeSha: realMergeSha,
          spentRepairs,
          spentWaitSeconds: getElapsedWaitSeconds(),
          reason: "already_merged_and_closed",
        };
      }

      // PR 已合入但 Issue 仍为 OPEN 或未知状态：输出明确 reconciliation 并停止派发
      return haltDispatch(
        "reconciliation_needed",
        `PR #${candidate.number} is already MERGED (merge commit: ${realMergeSha ?? "unknown"}), but issue #${context.issueNumber} remains open. Requires reconciliation or manual closure.`,
      );
    }

    if (candidate.state === "CLOSED") {
      return haltDispatch(
        "manual_intervention_required",
        `Existing PR #${candidate.number} is closed without merge. Cannot reuse closed PR.`,
      );
    }

    prNumber = candidate.number;
    prUrl = candidate.url;
    log(`[delivery-skill] Reusing verified existing open PR #${prNumber} (${prUrl})`);
  }

  // 若未曾被本分支合法合入，Issue 必须处于 OPEN 状态
  if (issueState === "CLOSED") {
    return haltDispatch(
      "manual_intervention_required",
      `Issue #${context.issueNumber} is already CLOSED on GitHub without merged PR. Delivery aborted.`,
    );
  }

  // ==========================================
  // Phase 2: Run Project Validation
  // ==========================================
  log("[delivery-skill] Phase 2: Running project validation...");
  if (options.validationCommand) {
    log(`[delivery-skill] Executing validation command: ${options.validationCommand}`);
    const valRes = await runner.exec(options.validationCommand, options.cwd);
    if (valRes.exitCode !== 0) {
      return haltDispatch(
        "manual_intervention_required",
        `Project validation command '${options.validationCommand}' failed with exit code ${valRes.exitCode}: ${valRes.stderr || valRes.stdout}`,
      );
    }
    log("[delivery-skill] Project validation succeeded.");
  }

  // ==========================================
  // Phase 3: Commit Changes
  // ==========================================
  log("[delivery-skill] Phase 3: Committing changes...");
  const statusRes = await runner.git(["status", "--porcelain"], options.cwd);
  if (statusRes.stdout.trim().length > 0) {
    await runner.git(["add", "-A"], options.cwd);
    const commitType = options.commitType ?? "feat";
    const commitMsg =
      options.commitMessage ?? `${commitType}: implement delivery for issue #${context.issueNumber} (${context.workspaceKey})`;
    const commitRes = await runner.git(["commit", "-m", commitMsg], options.cwd);
    if (commitRes.exitCode !== 0 && !commitRes.stdout.includes("nothing to commit")) {
      return haltDispatch("manual_intervention_required", `Git commit failed: ${commitRes.stderr}`);
    }
  }

  // ==========================================
  // Phase 4: Push to Remote
  // ==========================================
  log("[delivery-skill] Phase 4: Pushing branch to remote...");
  const pushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
  if (pushRes.exitCode !== 0) {
    const pushUpstream = await runner.git(["push", "-u", "origin", context.headBranch], options.cwd);
    if (pushUpstream.exitCode !== 0) {
      return haltDispatch("manual_intervention_required", `Git push failed: ${pushUpstream.stderr}`);
    }
  }

  const revParse = await runner.git(["rev-parse", "HEAD"], options.cwd);
  currentHeadSha = revParse.stdout.trim();
  log(`[delivery-skill] Pushed HEAD commit: ${currentHeadSha}`);

  // ==========================================
  // Phase 5: Ensure PR (Create if not exists)
  // ==========================================
  if (prNumber === null) {
    log("[delivery-skill] Phase 5: Creating Pull Request...");
    const prTitle = options.prTitle ?? `feat: delivery for #${context.issueNumber} (${context.workspaceKey})`;
    const prBody = formatPrBody({
      description: `Automated delivery for issue #${context.issueNumber}`,
      issueNumber: context.issueNumber,
      repo: context.repo,
      workspaceKey: context.workspaceKey,
      headBranch: context.headBranch,
      baseBranch: context.baseBranch,
    });

    const createRes = await runner.gh(
      [
        "pr",
        "create",
        "--repo",
        context.repo,
        "--head",
        context.headBranch,
        "--base",
        context.baseBranch,
        "--title",
        prTitle,
        "--body",
        prBody,
      ],
      options.cwd,
    );

    if (createRes.exitCode !== 0) {
      return haltDispatch("manual_intervention_required", `Failed to create PR: ${createRes.stderr}`);
    }

    const urlMatch = createRes.stdout.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      prUrl = urlMatch[0];
      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      if (numMatch && numMatch[1]) {
        prNumber = parseInt(numMatch[1], 10);
      }
    }

    if (!prNumber) {
      const recheck = await runner.gh(
        ["pr", "list", "--repo", context.repo, "--head", context.headBranch, "--json", "number,url"],
        options.cwd,
      );
      try {
        const list = JSON.parse(recheck.stdout || "[]");
        if (list[0]) {
          prNumber = list[0].number;
          prUrl = list[0].url;
        }
      } catch {
        // ignore
      }
    }

    if (!prNumber) {
      return haltDispatch("manual_intervention_required", "PR creation succeeded but failed to parse PR number");
    }
    log(`[delivery-skill] Created PR #${prNumber} (${prUrl})`);
  }

  // ==========================================
  // Phase 6: Inspect CI checks & Repair Loop
  // ==========================================
  log("[delivery-skill] Phase 6: Monitoring CI checks and executing repair loop...");

  // 权威确定 requiredChecks（若调用方未显式提供，向 GitHub 保护分支 API 查询）
  let effectiveRequiredChecks = options.requiredChecks ? [...options.requiredChecks] : undefined;
  if (effectiveRequiredChecks === undefined) {
    const checksRes = await runner.gh(
      ["api", `repos/${context.repo}/branches/${context.baseBranch}/protection/required_status_checks`],
      options.cwd,
    );
    if (checksRes.exitCode === 0) {
      try {
        const parsedChecks = JSON.parse(checksRes.stdout || "{}");
        const list: string[] = [];
        if (Array.isArray(parsedChecks.contexts)) {
          list.push(...parsedChecks.contexts.map(String));
        }
        if (Array.isArray(parsedChecks.checks)) {
          for (const c of parsedChecks.checks) {
            if (c && typeof c.context === "string") {
              list.push(c.context);
            }
          }
        }
        effectiveRequiredChecks = list;
      } catch (err) {
        return haltDispatch(
          "manual_intervention_required",
          `Failed to parse authoritative required status checks: ${String(err)}`,
        );
      }
    } else {
      const errOut = (checksRes.stderr + " " + checksRes.stdout).toLowerCase();
      if (errOut.includes("404") || errOut.includes("branch not protected") || errOut.includes("not found")) {
        effectiveRequiredChecks = [];
      } else {
        return haltDispatch(
          "manual_intervention_required",
          `Failed to determine authoritative required status checks for base branch '${context.baseBranch}': ${checksRes.stderr}`,
        );
      }
    }
  }

  while (true) {
    const elapsedWait = getElapsedWaitSeconds();
    if (elapsedWait >= maxWaitSeconds || (deadlineTimestampMs !== undefined && now() >= deadlineTimestampMs)) {
      return haltDispatch(
        "ci_wait_timeout",
        `Timed out waiting for CI checks after ${elapsedWait}s (max ${maxWaitSeconds}s).`,
      );
    }

    // 采用 gh pr view --json statusCheckRollup,headRefOid,mergeable,state
    // 兼容所有 gh 版本并绑定 headRefOid 与当前 head SHA
    const prViewRes = await runner.gh(
      ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "headRefOid,statusCheckRollup,mergeable,state"],
      options.cwd,
    );

    if (prViewRes.exitCode !== 0) {
      log(`[delivery-skill] Warning: Failed to fetch PR view for checks: ${prViewRes.stderr}. Retrying in ${pollInterval}s...`);
      await sleep(pollInterval);
      continue;
    }

    let prViewData: {
      headRefOid?: string;
      mergeable?: string;
      state?: string;
      statusCheckRollup?: Array<Record<string, unknown>>;
    } = {};

    try {
      prViewData = JSON.parse(prViewRes.stdout || "{}");
    } catch (err) {
      log(`[delivery-skill] Warning: Failed to parse PR view response: ${String(err)}`);
      await sleep(pollInterval);
      continue;
    }

    // 严格核对 PR 上的 headRefOid 必须存在且与当前已推送 head SHA 完全一致
    if (!prViewData.headRefOid || prViewData.headRefOid !== currentHeadSha) {
      log(
        `[delivery-skill] CI checks pending: PR headRefOid (${prViewData.headRefOid ?? "missing"}) does not match current HEAD (${currentHeadSha}) yet. Waiting ${pollInterval}s...`,
      );
      await sleep(pollInterval);
      continue;
    }

    const rawRollup = Array.isArray(prViewData.statusCheckRollup) ? prViewData.statusCheckRollup : [];
    const parsedChecks: CiCheckItem[] = rawRollup.map((rc) => {
      const name = String(rc["name"] || rc["context"] || "unnamed");
      const typename = String(rc["__typename"] || "");
      const detailsUrl = (rc["detailsUrl"] || rc["targetUrl"] || null) as string | null;

      let status: CiCheckStatus = "unknown";
      let conclusion: string | null = null;

      if (typename === "StatusContext" || (!rc["status"] && rc["state"])) {
        const stateStr = String(rc["state"] || "").toUpperCase();
        if (stateStr === "SUCCESS") {
          status = "success";
          conclusion = "SUCCESS";
        } else if (stateStr === "FAILURE" || stateStr === "ERROR") {
          status = "failure";
          conclusion = "FAILURE";
        } else if (stateStr === "PENDING") {
          status = "pending";
          conclusion = null;
        }
      } else {
        const rawStatus = String(rc["status"] || "").toUpperCase();
        const rawConclusion = String(rc["conclusion"] || "").toUpperCase();
        conclusion = rc["conclusion"] ? String(rc["conclusion"]) : null;

        if (rawStatus === "COMPLETED") {
          if (rawConclusion === "SUCCESS") {
            status = "success";
          } else if (
            rawConclusion === "FAILURE" ||
            rawConclusion === "TIMED_OUT" ||
            rawConclusion === "ACTION_REQUIRED"
          ) {
            status = "failure";
          } else if (rawConclusion === "CANCELLED") {
            status = "cancelled";
          } else if (rawConclusion === "SKIPPED" || rawConclusion === "NEUTRAL") {
            status = "neutral";
          }
        } else if (
          rawStatus === "IN_PROGRESS" ||
          rawStatus === "QUEUED" ||
          rawStatus === "PENDING" ||
          rawStatus === "WAITING" ||
          rawStatus === ""
        ) {
          status = "pending";
        }
      }

      const isRequired =
        Boolean(rc["isRequired"]) ||
        Boolean(effectiveRequiredChecks && effectiveRequiredChecks.includes(name));

      return {
        name,
        status,
        conclusion,
        detailsUrl,
        isRequired,
      };
    });

    const evaluation = evaluateCiChecksPolicy(parsedChecks, { requiredChecks: effectiveRequiredChecks });

    // 6a. Checks Green -> 进入 Land 阶段
    if (evaluation.canLand) {
      log(`[delivery-skill] CI checks green! (${evaluation.reason})`);
      break;
    }

    // 6b. Checks Failed -> 进入 Repair Loop
    if (evaluation.failedChecks.length > 0) {
      log(`[delivery-skill] CI checks failed: ${evaluation.failedChecks.map((c) => c.name).join(", ")}`);
      if (spentRepairs >= maxRepairs) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `CI failed on checks [${evaluation.failedChecks.map((c) => c.name).join(", ")}] and reached max repair attempts (${spentRepairs}/${maxRepairs}).`,
        );
      }

      // 提取真实失败日志诊断
      const { diagnostics, isInfraOrPermissionFailure } = await fetchCiFailureDiagnostics(
        runner,
        context.repo,
        currentHeadSha ?? "",
        evaluation.failedChecks,
        options.cwd,
      );

      // 区分 infra/permission 失败，避免无效消耗代码修复预算
      if (isInfraOrPermissionFailure) {
        return haltDispatch(
          "manual_intervention_required",
          `CI failed with infrastructure or permission error (requires operator intervention): ${diagnostics.slice(0, 300)}`,
        );
      }

      // 如果未配置 repairFn 也未配置 repairCommand，绝不凭空宣称 repair 成功并重复空提交！
      if (!options.repairFn && !options.repairCommand) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `CI checks failed on [${evaluation.failedChecks.map((c) => c.name).join(", ")}], but no repairFn or repairCommand was provided to execute repair. Diagnostic: ${diagnostics.slice(0, 300)}. Halting dispatch.`,
        );
      }

      spentRepairs++;
      log(`[delivery-skill] Entering repair attempt ${spentRepairs}/${maxRepairs}...`);

      // 在修复副作用执行前立即持久化预算消耗
      if (stateStorage) {
        await stateStorage.writeState({
          repo: context.repo,
          issueNumber: context.issueNumber,
          workspaceKey: context.workspaceKey,
          spentRepairs,
          spentWaitSeconds: getElapsedWaitSeconds(),
          deadlineTimestampMs,
          isPaused: false,
          lastUpdated: new Date().toISOString(),
        });
      }

      let repairSuccess = false;
      try {
        if (options.repairFn) {
          repairSuccess = await options.repairFn(diagnostics);
        } else if (options.repairCommand) {
          log(`[delivery-skill] Executing repair command: ${options.repairCommand}`);
          const repairRes = await runner.exec(
            options.repairCommand,
            options.cwd,
            undefined,
            { SYMPHONY_CI_FAILURE_DIAGNOSTICS: diagnostics },
          );
          repairSuccess = repairRes.exitCode === 0;
          if (!repairSuccess) {
            log(`[delivery-skill] Repair command failed (${repairRes.exitCode}): ${repairRes.stderr || repairRes.stdout}`);
          }
        }
      } catch (err) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `Repair attempt ${spentRepairs} failed with exception: ${String(err)}`,
        );
      }

      if (!repairSuccess) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `Repair attempt ${spentRepairs} failed to fix CI failure: ${diagnostics.slice(0, 300)}`,
        );
      }

      // 修复完成后重新执行项目验证
      if (options.validationCommand) {
        log(`[delivery-skill] Re-running validation command after repair: ${options.validationCommand}`);
        const valRes = await runner.exec(options.validationCommand, options.cwd);
        if (valRes.exitCode !== 0) {
          return haltDispatch(
            "ci_failed_max_repairs",
            `Project validation failed after repair attempt ${spentRepairs}: ${valRes.stderr || valRes.stdout}`,
          );
        }
      }

      // 核对是否有代码改动
      const diffCheck = await runner.git(["status", "--porcelain"], options.cwd);
      if (diffCheck.stdout.trim().length === 0) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `Repair attempt ${spentRepairs} produced no new working tree changes. Aborting empty repair loop.`,
        );
      }

      await runner.git(["add", "-A"], options.cwd);
      const fixCommitRes = await runner.git(
        ["commit", "-m", `fix(ci): repair failed checks (attempt ${spentRepairs})`],
        options.cwd,
      );
      if (fixCommitRes.exitCode !== 0) {
        return haltDispatch("manual_intervention_required", `Failed to commit repair changes: ${fixCommitRes.stderr}`);
      }

      const fixPushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
      if (fixPushRes.exitCode !== 0) {
        return haltDispatch("manual_intervention_required", `Failed to push repair commit: ${fixPushRes.stderr}`);
      }

      const newHead = await runner.git(["rev-parse", "HEAD"], options.cwd);
      const newHeadSha = newHead.stdout.trim();
      if (newHeadSha === currentHeadSha) {
        return haltDispatch("ci_failed_max_repairs", "Repair push did not produce a new HEAD SHA.");
      }
      currentHeadSha = newHeadSha;
      log(`[delivery-skill] Pushed repaired commit ${currentHeadSha}. Waiting for new CI run to start...`);

      // 刷新持久化状态中的预算消耗
      if (stateStorage) {
        await stateStorage.writeState({
          repo: context.repo,
          issueNumber: context.issueNumber,
          workspaceKey: context.workspaceKey,
          spentRepairs,
          spentWaitSeconds: getElapsedWaitSeconds(),
          deadlineTimestampMs,
          isPaused: false,
          lastUpdated: new Date().toISOString(),
        });
      }

      await sleep(pollInterval);
      continue;
    }

    // 6c. Checks Pending -> 等待下一次轮询
    log(`[delivery-skill] CI checks pending (${evaluation.reason}). Waiting ${pollInterval}s... (${elapsedWait}/${maxWaitSeconds}s)`);
    await sleep(pollInterval);
  }

  // ==========================================
  // Phase 7: Land Evaluation & Squash Merge
  // ==========================================
  log("[delivery-skill] Phase 7: Land evaluation & squash merge...");

  // 默认绝不自动 land，必须显式 optInLand
  if (options.optInLand !== true) {
    log("[delivery-skill] optInLand is not true. PR is green and ready to land. Skipping merge.");
    return {
      status: "ready_to_land",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      spentWaitSeconds: getElapsedWaitSeconds(),
      reason: "ci_green_opt_in_disabled",
    };
  }

  if (prNumber === null) {
    return haltDispatch("manual_intervention_required", "Cannot land without PR number.");
  }

  // 校验 mergeability
  const checkMergeableRes = await runner.gh(
    ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "mergeable,state"],
    options.cwd,
  );
  if (checkMergeableRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to query PR #${prNumber} mergeability: ${checkMergeableRes.stderr}`);
  }
  try {
    const prStateObj = JSON.parse(checkMergeableRes.stdout || "{}");
    if (prStateObj.mergeable !== "MERGEABLE") {
      return haltDispatch("unmergeable", `PR #${prNumber} mergeable state is '${prStateObj.mergeable}', expected 'MERGEABLE'.`);
    }
  } catch (err) {
    return haltDispatch("unmergeable", `Failed to parse PR mergeability response: ${String(err)}`);
  }

  // 执行 squash merge
  const mergeArgs = ["pr", "merge", String(prNumber), "--repo", context.repo, "--squash"];
  if (currentHeadSha) {
    mergeArgs.push("--match-head-commit", currentHeadSha);
  }

  const mergeRes = await runner.gh(mergeArgs, options.cwd);
  if (mergeRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to squash merge PR #${prNumber}: ${mergeRes.stderr}`);
  }

  // 严格验证 PR 终态是否确实为 MERGED
  const verifyRes = await runner.gh(
    ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "state,mergeCommit"],
    options.cwd,
  );
  if (verifyRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to query PR #${prNumber} state after merge: ${verifyRes.stderr}`);
  }

  let mergeSha: string | null = null;
  try {
    const verified = JSON.parse(verifyRes.stdout || "{}");
    if (verified.state !== "MERGED") {
      return haltDispatch("unmergeable", `PR #${prNumber} state after merge is '${verified.state}', expected 'MERGED'.`);
    }
    mergeSha = (verified.mergeCommit?.oid as string | undefined) ?? null;
  } catch (err) {
    return haltDispatch("unmergeable", `Failed to parse post-merge verification response: ${String(err)}`);
  }

  // 核对关联 Issue 是否已自动关闭
  const issueVerifyRes = await runner.gh(
    ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "state"],
    options.cwd,
  );
  let issueClosed = false;
  if (issueVerifyRes.exitCode === 0) {
    try {
      const issueObj = JSON.parse(issueVerifyRes.stdout || "{}");
      issueClosed = issueObj.state === "CLOSED";
    } catch {
      // ignore
    }
  }

  // 记录完成状态
  if (stateStorage) {
    await stateStorage.writeState({
      repo: context.repo,
      issueNumber: context.issueNumber,
      workspaceKey: context.workspaceKey,
      spentRepairs,
      spentWaitSeconds: getElapsedWaitSeconds(),
      deadlineTimestampMs,
      isPaused: false,
      lastUpdated: new Date().toISOString(),
    });
  }

  if (!issueClosed) {
    log(`[delivery-skill] Warning: PR #${prNumber} is merged, but issue #${context.issueNumber} remains open. Halting dispatch for reconciliation...`);
    return haltDispatch(
      "reconciliation_needed",
      `PR #${prNumber} was successfully squash merged (merge commit: ${mergeSha ?? "unknown"}), but issue #${context.issueNumber} remains open or could not be verified as closed. Requires reconciliation or manual closure.`,
    );
  }

  log(`[delivery-skill] Successfully landed PR #${prNumber}! Merge commit: ${mergeSha ?? "verified"}. Issue #${context.issueNumber} closed.`);
  return {
    status: "completed",
    prNumber,
    prUrl,
    headSha: currentHeadSha,
    mergeSha,
    spentRepairs,
    spentWaitSeconds: getElapsedWaitSeconds(),
    reason: "successfully_merged",
  };
}
