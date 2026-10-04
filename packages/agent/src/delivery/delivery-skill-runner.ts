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
  readonly log?: (msg: string) => void;
}

const DEFAULT_READY_LABEL = "symphony-ready";
const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_MAX_WAIT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

function repoMatches(remoteUrl: string, expectedRepo: string): boolean {
  const normalizedUrl = remoteUrl.trim().toLowerCase();
  const normalizedExpected = expectedRepo.trim().toLowerCase();
  return (
    normalizedUrl.endsWith(`/${normalizedExpected}`) ||
    normalizedUrl.endsWith(`/${normalizedExpected}.git`) ||
    normalizedUrl.endsWith(`:${normalizedExpected}`) ||
    normalizedUrl.endsWith(`:${normalizedExpected}.git`)
  );
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
  const persisted = stateStorage ? await stateStorage.readState() : null;

  let spentRepairs = 0;
  let initialSpentWaitSeconds = 0;

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
  }

  const startTimeMs = Date.now();
  const getElapsedWaitSeconds = (): number => {
    return initialSpentWaitSeconds + Math.floor((Date.now() - startTimeMs) / 1000);
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
    try {
      const removeRes = await runner.gh(
        ["issue", "edit", String(context.issueNumber), "--repo", context.repo, "--remove-label", readyLabel],
        options.cwd,
      );
      if (removeRes.exitCode === 0) {
        readyLabelRemoved = true;
      }
      // 重读 Issue 标签事实以确认移除成功
      const checkRes = await runner.gh(
        ["issue", "view", String(context.issueNumber), "--repo", context.repo, "--json", "labels"],
        options.cwd,
      );
      if (checkRes.exitCode === 0) {
        try {
          const parsed = JSON.parse(checkRes.stdout || "{}");
          const labels: Array<{ name: string } | string> = Array.isArray(parsed.labels) ? parsed.labels : [];
          const hasLabel = labels.some((l) => (typeof l === "string" ? l : l.name) === readyLabel);
          if (hasLabel) {
            readyLabelRemoved = false;
          }
        } catch {
          // ignore parse error
        }
      }
      if (readyLabelRemoved) {
        log(`[delivery-skill] Successfully verified removal of label '${readyLabel}' from issue #${context.issueNumber}`);
      } else {
        log(`[delivery-skill] Warning: Label '${readyLabel}' could not be verified as removed from issue #${context.issueNumber}`);
      }
    } catch (err) {
      log(`[delivery-skill] Warning: Exception while removing label '${readyLabel}': ${String(err)}`);
      readyLabelRemoved = false;
    }

    // 发表交接评论
    let commentPosted = false;
    const handoff: DeliveryHandoff = {
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
      commentPosted: false,
    };

    let handoffMarkdown = formatDeliveryHandoffMarkdown(handoff);

    try {
      const commentTarget = prNumber !== null ? ["pr", "comment", String(prNumber)] : ["issue", "comment", String(context.issueNumber)];
      const commentRes = await runner.gh(
        [...commentTarget, "--repo", context.repo, "--body", handoffMarkdown],
        options.cwd,
      );
      if (commentRes.exitCode === 0) {
        commentPosted = true;
      }
    } catch (err) {
      log(`[delivery-skill] Warning: Failed to post handoff comment: ${String(err)}`);
      commentPosted = false;
    }

    // 更新包含真实 commentPosted 的 markdown
    handoffMarkdown = formatDeliveryHandoffMarkdown({ ...handoff, commentPosted });

    // 持久化 paused 状态
    if (stateStorage) {
      await stateStorage.writeState({
        repo: context.repo,
        issueNumber: context.issueNumber,
        workspaceKey: context.workspaceKey,
        spentRepairs,
        spentWaitSeconds,
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

  // 1b. 校验 remote origin
  const remoteRes = await runner.git(["remote", "get-url", "origin"], options.cwd);
  if (remoteRes.exitCode !== 0 || !repoMatches(remoteRes.stdout, context.repo)) {
    return haltDispatch(
      "manual_intervention_required",
      `Working directory origin URL '${remoteRes.stdout.trim()}' does not match expected repo '${context.repo}'.`,
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
  try {
    const issueData = JSON.parse(issueRes.stdout || "{}");
    if (issueData.state === "CLOSED") {
      return haltDispatch(
        "manual_intervention_required",
        `Issue #${context.issueNumber} is already CLOSED on GitHub. Delivery aborted.`,
      );
    }
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
      log(`[delivery-skill] Existing PR #${candidate.number} is already MERGED. Returning completed.`);
      return {
        status: "completed",
        prNumber: candidate.number,
        prUrl: candidate.url,
        headSha: candidate.headRefOid ?? null,
        mergeSha: candidate.headRefOid ?? null,
        spentRepairs,
        spentWaitSeconds: getElapsedWaitSeconds(),
        reason: "already_merged",
      };
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

  while (true) {
    const elapsedWait = getElapsedWaitSeconds();
    if (elapsedWait >= maxWaitSeconds) {
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

    // 核对 PR 上的 headRefOid 是否已对应当前已推送的 head SHA
    if (prViewData.headRefOid && prViewData.headRefOid !== currentHeadSha) {
      log(`[delivery-skill] CI checks pending: PR headRefOid (${prViewData.headRefOid}) does not match current HEAD (${currentHeadSha}) yet. Waiting ${pollInterval}s...`);
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
        Boolean(options.requiredChecks && options.requiredChecks.includes(name));

      return {
        name,
        status,
        conclusion,
        detailsUrl,
        isRequired,
      };
    });

    const evaluation = evaluateCiChecksPolicy(parsedChecks, { requiredChecks: options.requiredChecks });

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

      // 如果未配置 repairFn 也未配置 repairCommand，绝不凭空宣称 repair 成功并重复空提交！
      if (!options.repairFn && !options.repairCommand) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `CI checks failed on [${evaluation.failedChecks.map((c) => c.name).join(", ")}], but no repairFn or repairCommand was provided to execute repair. Halting dispatch.`,
        );
      }

      spentRepairs++;
      log(`[delivery-skill] Entering repair attempt ${spentRepairs}/${maxRepairs}...`);

      const failureDetails = evaluation.failedChecks
        .map((c) => `${c.name}: status=${c.status}, conclusion=${c.conclusion ?? "none"}, url=${c.detailsUrl ?? "none"}`)
        .join("; ");

      let repairSuccess = false;
      if (options.repairFn) {
        repairSuccess = await options.repairFn(failureDetails);
      } else if (options.repairCommand) {
        log(`[delivery-skill] Executing repair command: ${options.repairCommand}`);
        const repairRes = await runner.exec(options.repairCommand, options.cwd);
        repairSuccess = repairRes.exitCode === 0;
        if (!repairSuccess) {
          log(`[delivery-skill] Repair command failed (${repairRes.exitCode}): ${repairRes.stderr || repairRes.stdout}`);
        }
      }

      if (!repairSuccess) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `Repair attempt ${spentRepairs} failed to fix CI failure: ${failureDetails}`,
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
      isPaused: false,
      lastUpdated: new Date().toISOString(),
    });
  }

  if (!issueClosed) {
    log(`[delivery-skill] Warning: PR #${prNumber} is merged, but issue #${context.issueNumber} remains open. Requires reconciliation or manual closure.`);
    return {
      status: "completed",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      mergeSha,
      spentRepairs,
      spentWaitSeconds: getElapsedWaitSeconds(),
      reason: "merged_issue_open_reconciliation",
    };
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
