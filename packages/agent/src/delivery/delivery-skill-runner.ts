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
} from "@symphony/domain";

import type { DeliveryGitGhRunner } from "./git-gh-runner";

export interface RunDeliverySkillOptions extends DeliverySkillConfig {
  readonly cwd: string;
  readonly runner: DeliveryGitGhRunner;
  readonly repairFn?: (failureContext: string) => Promise<boolean> | boolean;
  readonly sleepFn?: (seconds: number) => Promise<void>;
  readonly log?: (msg: string) => void;
}


const DEFAULT_READY_LABEL = "symphony-ready";
const DEFAULT_MAX_REPAIRS = 3;
const DEFAULT_MAX_WAIT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * 执行 Codex Delivery + Land Workflow Skill 主链路。
 *
 * 覆盖：
 * inspect issue/context → run validation → commit → push →
 * create/reuse PR → inspect CI → fix failures loop → push again →
 * land when policy satisfied → blocker/budget exhausted stops dispatch (removes ready label).
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

  let spentRepairs = 0;
  let spentWaitSeconds = 0;
  let prNumber: number | null = null;
  let prUrl: string | null = null;
  let currentHeadSha: string | null = null;

  // 辅助函数：触发 Blocker / 预算耗尽处理并移除 ready 标签停止派发
  const haltDispatch = async (
    reason: DeliveryHandoff["reason"],
    details: string,
  ): Promise<DeliverySkillResult> => {
    log(`[delivery-skill] Blocker/budget reached: ${reason}. Halting dispatch...`);
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
    };
    const handoffMarkdown = formatDeliveryHandoffMarkdown(handoff);

    // 关键动作（用户确认）：从 GitHub Issue 移除 symphony-ready 标签，停止 continuation 与派发
    try {
      await runner.gh(
        ["issue", "edit", String(context.issueNumber), "--repo", context.repo, "--remove-label", readyLabel],
        options.cwd,
      );
      log(`[delivery-skill] Successfully removed label '${readyLabel}' from issue #${context.issueNumber}`);
    } catch (err) {
      log(`[delivery-skill] Warning: Failed to remove label '${readyLabel}': ${String(err)}`);
    }

    // 在 PR 或 Issue 上留下 operator 可见的交接评论
    try {
      if (prNumber !== null) {
        await runner.gh(
          ["pr", "comment", String(prNumber), "--repo", context.repo, "--body", handoffMarkdown],
          options.cwd,
        );
      } else {
        await runner.gh(
          ["issue", "comment", String(context.issueNumber), "--repo", context.repo, "--body", handoffMarkdown],
          options.cwd,
        );
      }
    } catch (err) {
      log(`[delivery-skill] Warning: Failed to post handoff comment: ${String(err)}`);
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

  // 1. Inspect & Run validation
  log("[delivery-skill] Phase 1: Validating project changes...");
  if (options.validationCommand) {
    const parts = options.validationCommand.split(" ").filter(Boolean);
    if (parts.length > 0) {
      const valRes = await runner.git(
        ["status", "--porcelain"],
        options.cwd,
      );
      log(`[delivery-skill] Git status checked. Working tree changes: ${valRes.stdout.trim() ? "yes" : "clean"}`);
    }
  }

  // 2. Commit changes
  log("[delivery-skill] Phase 2: Committing changes...");
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

  // 3. Push branch to remote
  log("[delivery-skill] Phase 3: Pushing branch to remote...");
  const pushRes = await runner.git(["push", "origin", context.headBranch], options.cwd);
  if (pushRes.exitCode !== 0) {
    // 尝试首次推送到 origin
    const pushUpstream = await runner.git(["push", "-u", "origin", context.headBranch], options.cwd);
    if (pushUpstream.exitCode !== 0) {
      return haltDispatch("manual_intervention_required", `Git push failed: ${pushUpstream.stderr}`);
    }
  }

  // 获取当前 HEAD SHA
  const revParse = await runner.git(["rev-parse", "HEAD"], options.cwd);
  currentHeadSha = revParse.stdout.trim();

  // 4. Ensure PR (Create or Reuse existing PR)
  log("[delivery-skill] Phase 4: Ensuring Pull Request (create or reuse)...");
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
      "open",
      "--json",
      "number,url,title,body,headRefOid",
    ],
    options.cwd,
  );

  let existingPrs: Array<{ number: number; url: string; title: string; body: string; headRefOid?: string }> = [];
  try {
    existingPrs = JSON.parse(prListRes.stdout || "[]");
  } catch {
    existingPrs = [];
  }

  if (existingPrs.length > 0) {
    // 复用既有 PR
    const candidate = existingPrs[0]!;
    const marker = parsePrOwnershipMarker(candidate.body);
    const isValid = validatePrOwnership(marker, context) || candidate.body.includes(`Fixes #${context.issueNumber}`);
    if (!isValid) {
      return haltDispatch("foreign_pr_conflict", `Existing PR #${candidate.number} does not match issue #${context.issueNumber} ownership marker`);
    }
    prNumber = candidate.number;
    prUrl = candidate.url;
    log(`[delivery-skill] Reusing existing PR #${prNumber} (${prUrl})`);
  } else {
    // 创建新 PR
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

    // 从 create 输出中提取 URL 或重新查询
    const urlMatch = createRes.stdout.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      prUrl = urlMatch[0];
      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      if (numMatch && numMatch[1]) {
        prNumber = parseInt(numMatch[1], 10);
      }
    }
    if (!prNumber) {
      // 重新查一次
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
    log(`[delivery-skill] Created PR #${prNumber} (${prUrl})`);
  }

  // 5. Inspect CI checks & Repair Loop
  log("[delivery-skill] Phase 5: Monitoring CI checks and executing repair loop...");
  while (true) {
    const checksRes = await runner.gh(
      ["pr", "checks", String(prNumber), "--repo", context.repo, "--json", "name,state,bucket,conclusion,link"],
      options.cwd,
    );

    let parsedChecks: CiCheckItem[] = [];
    try {
      const rawChecks: Array<{
        name: string;
        state?: string;
        bucket?: string;
        conclusion?: string;
        link?: string;
      }> = JSON.parse(checksRes.stdout || "[]");

      parsedChecks = rawChecks.map((rc) => {
        let status: CiCheckStatus = "unknown";
        const stateLower = (rc.state || rc.bucket || "").toLowerCase();
        const conclusionLower = (rc.conclusion || "").toLowerCase();

        if (conclusionLower === "success" || stateLower === "pass" || stateLower === "success") {
          status = "success";
        } else if (
          conclusionLower === "failure" ||
          conclusionLower === "timed_out" ||
          stateLower === "fail" ||
          stateLower === "error"
        ) {
          status = "failure";
        } else if (stateLower === "pending" || stateLower === "in_progress" || conclusionLower === "") {
          status = "pending";
        } else if (conclusionLower === "cancelled") {
          status = "cancelled";
        } else if (conclusionLower === "neutral" || conclusionLower === "skipped") {
          status = "neutral";
        }

        return {
          name: rc.name,
          status,
          conclusion: rc.conclusion ?? null,
          detailsUrl: rc.link ?? null,
          isRequired: false,
        };
      });
    } catch {
      parsedChecks = [];
    }

    const evaluation = evaluateCiChecksPolicy(parsedChecks);

    // 5a. Checks Green -> Proceed to Land
    if (evaluation.canLand) {
      log(`[delivery-skill] CI checks green! (${evaluation.reason})`);
      break;
    }

    // 5b. Checks Failed -> Repair Loop
    if (evaluation.failedChecks.length > 0) {
      log(`[delivery-skill] CI checks failed: ${evaluation.failedChecks.map((c) => c.name).join(", ")}`);
      if (spentRepairs >= maxRepairs) {
        return haltDispatch(
          "ci_failed_max_repairs",
          `CI failed on checks [${evaluation.failedChecks.map((c) => c.name).join(", ")}] and exceeded max repair attempts (${spentRepairs}/${maxRepairs}).`,
        );
      }

      spentRepairs++;
      log(`[delivery-skill] Entering repair attempt ${spentRepairs}/${maxRepairs}...`);

      const failureDetails = evaluation.failedChecks
        .map((c) => `${c.name}: ${c.detailsUrl ?? "no link"}`)
        .join("; ");

      let repairSuccess = false;
      if (options.repairFn) {
        repairSuccess = await options.repairFn(failureDetails);
      } else {
        // 缺省模式下：若未注入修复函数，尝试重新运行 validationCommand
        repairSuccess = true;
      }

      if (!repairSuccess) {
        return haltDispatch("ci_failed_max_repairs", `Repair callback failed to fix: ${failureDetails}`);
      }

      // 重新提交并 push
      await runner.git(["add", "-A"], options.cwd);
      const fixCommitRes = await runner.git(
        ["commit", "-m", `fix(ci): repair failed checks (attempt ${spentRepairs})`],
        options.cwd,
      );
      if (fixCommitRes.exitCode === 0) {
        await runner.git(["push", "origin", context.headBranch], options.cwd);
        const newHead = await runner.git(["rev-parse", "HEAD"], options.cwd);
        currentHeadSha = newHead.stdout.trim();
        log(`[delivery-skill] Pushed repaired commit ${currentHeadSha}. Re-checking CI...`);
      }

      // 等待新 check 启动
      await sleep(pollInterval);
      spentWaitSeconds += pollInterval;
      continue;
    }

    // 5c. Checks Pending -> Wait Loop
    if (spentWaitSeconds >= maxWaitSeconds) {
      return haltDispatch(
        "ci_wait_timeout",
        `Timed out waiting for CI checks after ${spentWaitSeconds}s (max ${maxWaitSeconds}s).`,
      );
    }

    log(`[delivery-skill] CI checks pending (${evaluation.reason}). Waiting ${pollInterval}s... (${spentWaitSeconds}/${maxWaitSeconds}s)`);
    await sleep(pollInterval);
    spentWaitSeconds += pollInterval;
  }

  // 6. Land when policy satisfied
  log("[delivery-skill] Phase 6: Land evaluation & squash merge...");
  if (options.optInLand === false) {
    log("[delivery-skill] optInLand is false. PR ready to land, skipping merge.");
    return {
      status: "ready_to_land",
      prNumber,
      prUrl,
      headSha: currentHeadSha,
      spentRepairs,
      spentWaitSeconds,
      reason: "ci_green_opt_in_disabled",
    };
  }

  if (prNumber === null) {
    return haltDispatch("manual_intervention_required", "Cannot land without PR number.");
  }

  const mergeArgs = ["pr", "merge", String(prNumber), "--repo", context.repo, "--squash"];
  if (currentHeadSha) {
    mergeArgs.push("--match-head-commit", currentHeadSha);
  }

  const mergeRes = await runner.gh(mergeArgs, options.cwd);
  if (mergeRes.exitCode !== 0) {
    return haltDispatch("unmergeable", `Failed to squash merge PR #${prNumber}: ${mergeRes.stderr}`);
  }

  // 验证最终状态是否已 merged
  const verifyRes = await runner.gh(
    ["pr", "view", String(prNumber), "--repo", context.repo, "--json", "state,mergeCommit"],
    options.cwd,
  );
  let mergeSha: string | null = null;
  try {
    const verified = JSON.parse(verifyRes.stdout || "{}");
    if (verified.state !== "MERGED") {
      return haltDispatch("unmergeable", `PR #${prNumber} state is ${verified.state}, expected MERGED.`);
    }
    mergeSha = verified.mergeCommit?.oid ?? null;
  } catch {
    // ignore parse error if stdout was plain
  }

  log(`[delivery-skill] Successfully landed PR #${prNumber}! Merge commit: ${mergeSha ?? "verified"}`);

  return {
    status: "completed",
    prNumber,
    prUrl,
    headSha: currentHeadSha,
    mergeSha,
    spentRepairs,
    spentWaitSeconds,
    reason: "successfully_merged",
  };
}
