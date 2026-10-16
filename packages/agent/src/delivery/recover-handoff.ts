import {
  formatDeliveryHandoffMarkdown,
  type DeliveryHandoff,
  type PersistedDeliveryState,
} from "@symphony/domain";

import type { DeliveryGitGhRunner } from "./git-gh-runner";
import type { DeliveryStateStorage } from "./delivery-skill-runner";

export interface RecoverDeliveryHandoffOptions {
  readonly cwd: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly workspaceKey?: string | undefined;
  readonly readyLabel?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly maxRepairs?: number | undefined;
  readonly maxWait?: number | undefined;
  readonly stateStorage: DeliveryStateStorage;
  readonly runner: DeliveryGitGhRunner;
  readonly log?: (msg: string) => void;
}

export interface RecoverDeliveryHandoffResult {
  readonly success: boolean;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly readyLabelRemoved: boolean;
  readonly commentPosted: boolean;
  readonly commentVerifyStatus: "posted" | "failed" | "unverified" | "pending";
  readonly pendingCompensation: boolean;
}

export async function recoverDeliveryHandoff(
  options: RecoverDeliveryHandoffOptions,
): Promise<RecoverDeliveryHandoffResult> {
  const { cwd, stateStorage, runner, log = () => {} } = options;

  let currentState: PersistedDeliveryState | null = null;
  try {
    currentState = await stateStorage.readState();
  } catch (err) {
    return {
      success: false,
      error: `error reading state: ${String(err)}`,
      readyLabelRemoved: false,
      commentPosted: false,
      commentVerifyStatus: "unverified",
      pendingCompensation: true,
    };
  }

  if (!currentState) {
    return {
      success: false,
      error: "error: no persisted delivery state found",
      readyLabelRemoved: false,
      commentPosted: false,
      commentVerifyStatus: "unverified",
      pendingCompensation: false,
    };
  }

  if (!currentState.isPaused) {
    return {
      success: true,
      message: "delivery state is not paused; no handoff recovery required",
      readyLabelRemoved: currentState.readyLabelRemoved ?? false,
      commentPosted: currentState.commentPosted ?? false,
      commentVerifyStatus: currentState.commentVerifyStatus ?? "unverified",
      pendingCompensation: false,
    };
  }

  // 1. Identity validation: repo, issueNumber, workspaceKey
  if (currentState.repo && currentState.repo !== options.repo) {
    return {
      success: false,
      error: `error: repository mismatch (persisted: ${currentState.repo}, argv: ${options.repo})`,
      readyLabelRemoved: currentState.readyLabelRemoved ?? false,
      commentPosted: currentState.commentPosted ?? false,
      commentVerifyStatus: currentState.commentVerifyStatus ?? "unverified",
      pendingCompensation: true,
    };
  }
  if (currentState.issueNumber && currentState.issueNumber !== options.issueNumber) {
    return {
      success: false,
      error: `error: issue number mismatch (persisted: ${currentState.issueNumber}, argv: ${options.issueNumber})`,
      readyLabelRemoved: currentState.readyLabelRemoved ?? false,
      commentPosted: currentState.commentPosted ?? false,
      commentVerifyStatus: currentState.commentVerifyStatus ?? "unverified",
      pendingCompensation: true,
    };
  }
  if (currentState.workspaceKey && options.workspaceKey && currentState.workspaceKey !== options.workspaceKey) {
    return {
      success: false,
      error: `error: workspace mismatch (persisted: ${currentState.workspaceKey}, argv: ${options.workspaceKey})`,
      readyLabelRemoved: currentState.readyLabelRemoved ?? false,
      commentPosted: currentState.commentPosted ?? false,
      commentVerifyStatus: currentState.commentVerifyStatus ?? "unverified",
      pendingCompensation: true,
    };
  }

  const repo = currentState.repo || options.repo;
  const issueNumber = currentState.issueNumber || options.issueNumber;
  const effectiveReadyLabel =
    currentState.handoff?.readyLabel ??
    (currentState as unknown as { readyLabel?: string }).readyLabel ??
    options.readyLabel ??
    "symphony-ready";
  const reason = (currentState.pauseReason as DeliveryHandoff["reason"]) ?? "manual_intervention_required";
  const prNumber = currentState.handoff?.prNumber ?? null;

  // 2. Ready label removal compensation
  let readyLabelRemoved = currentState.readyLabelRemoved ?? false;
  if (!readyLabelRemoved) {
    try {
      const editRes = await runner.gh(
        ["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", effectiveReadyLabel],
        cwd,
      );
      if (editRes.exitCode === 0) {
        readyLabelRemoved = true;
        log(`[delivery-recovery] Successfully removed label '${effectiveReadyLabel}' from issue #${issueNumber}`);
      } else {
        readyLabelRemoved = false;
        log(`[delivery-recovery] Warning: Failed to remove label '${effectiveReadyLabel}': ${editRes.stderr}`);
      }
    } catch (err) {
      readyLabelRemoved = false;
      log(`[delivery-recovery] Warning: Exception while removing label: ${String(err)}`);
    }
  }

  // 3. Comment post / verify compensation
  let commentPosted = currentState.commentPosted ?? false;
  let commentVerifyStatus: "posted" | "failed" | "unverified" | "pending" =
    currentState.commentVerifyStatus ?? "unverified";

  const handoffId = currentState.handoff?.handoffId;
  const headSha = currentState.handoff?.headSha;

  const viewTargetArgs = prNumber !== null
    ? ["pr", "view", String(prNumber), "--repo", repo, "--json", "comments"]
    : ["issue", "view", String(issueNumber), "--repo", repo, "--json", "comments"];

  const commentTargetArgs = prNumber !== null
    ? ["pr", "comment", String(prNumber), "--repo", repo]
    : ["issue", "comment", String(issueNumber), "--repo", repo];

  let handoffToPost: DeliveryHandoff | undefined;

  if (!commentPosted) {
    let querySuccess = false;
    let alreadyPosted = false;
    let canUniquelyVerify = false;

    try {
      const viewRes = await runner.gh(viewTargetArgs, cwd);
      if (viewRes.exitCode === 0) {
        querySuccess = true;
        const parsedView = JSON.parse(viewRes.stdout || "{}");
        if (Array.isArray(parsedView.comments)) {
          if (handoffId) {
            canUniquelyVerify = true;
            alreadyPosted = parsedView.comments.some(
              (c: { body?: string }) => typeof c.body === "string" && c.body.includes(handoffId),
            );
          } else if (headSha) {
            canUniquelyVerify = true;
            const shortSha = headSha.slice(0, 10);
            alreadyPosted = parsedView.comments.some(
              (c: { body?: string }) =>
                typeof c.body === "string" && (c.body.includes(shortSha) || c.body.includes(headSha)),
            );
          } else {
            // 旧状态无 handoffId 且无 headSha
            const hasAnyHandoffReport = parsedView.comments.some(
              (c: { body?: string }) =>
                typeof c.body === "string" &&
                (c.body.includes("## 🚨 Symphony Delivery Handoff Report") ||
                  c.body.includes("symphony-delivery-handoff")),
            );
            if (hasAnyHandoffReport) {
              // 远端已有交接报告，但旧状态无 ID/SHA，无法证明该报告属于本次交接还是历史交接
              // 按照审阅要求：旧状态不能凭通用 details/标题虚报完成，无法唯一确认时保留待核验
              canUniquelyVerify = false;
            } else {
              // 远端没有任何交接报告，确定未曾发布，可以安全补发
              canUniquelyVerify = true;
              alreadyPosted = false;
            }
          }
        }
      } else {
        querySuccess = false;
      }
    } catch {
      querySuccess = false;
    }

    if (!querySuccess) {
      commentVerifyStatus = "unverified";
      await stateStorage.writeState({
        ...currentState,
        readyLabelRemoved,
        commentPosted: false,
        commentVerifyStatus: "unverified",
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
      });
      return {
        success: false,
        error: "error querying remote comments; status remains unverified",
        readyLabelRemoved,
        commentPosted: false,
        commentVerifyStatus: "unverified",
        pendingCompensation: true,
      };
    }

    if (!canUniquelyVerify && !alreadyPosted) {
      // 无法唯一确认远端是否存在本次交接报告，不能盲目标记完成，保留待核验
      commentVerifyStatus = "unverified";
      await stateStorage.writeState({
        ...currentState,
        readyLabelRemoved,
        commentPosted: false,
        commentVerifyStatus: "unverified",
        pendingCompensation: true,
        lastUpdated: new Date().toISOString(),
      });
      return {
        success: false,
        error: "legacy handoff lacks unique identifier (handoffId/headSha); cannot verify remote comment; status remains unverified",
        readyLabelRemoved,
        commentPosted: false,
        commentVerifyStatus: "unverified",
        pendingCompensation: true,
      };
    }

    if (alreadyPosted) {
      commentPosted = true;
      commentVerifyStatus = "posted";
      log("[delivery-recovery] Handoff report already exists on remote; skipped duplicate post.");
    } else {
      const generatedHandoffId =
        handoffId ??
        `handoff-${repo.replace("/", "-")}-${issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const baseHandoff = currentState.handoff ?? {
        reason,
        details: currentState.pauseReason ?? "Delivery paused for manual intervention.",
        repo,
        issueNumber,
        headBranch: options.headBranch ?? `symphony/GH-${issueNumber}`,
        prNumber,
        prUrl: null,
        headSha: null,
        spentRepairs: currentState.spentRepairs,
        maxRepairs: options.maxRepairs ?? currentState.spentRepairs,
        spentWaitSeconds: currentState.spentWaitSeconds,
        maxWaitSeconds: options.maxWait ?? currentState.spentWaitSeconds,
        readyLabel: effectiveReadyLabel,
        readyLabelRemoved,
      };
      handoffToPost = {
        ...baseHandoff,
        handoffId: baseHandoff.handoffId ?? generatedHandoffId,
      };
      const commentBody = formatDeliveryHandoffMarkdown({ ...handoffToPost, readyLabelRemoved, commentPosted: true });
      try {
        const commentRes = await runner.gh([...commentTargetArgs, "--body", commentBody], cwd);
        if (commentRes.exitCode === 0) {
          commentPosted = true;
          commentVerifyStatus = "posted";
          log("[delivery-recovery] Successfully posted handoff report comment.");
        } else {
          commentPosted = false;
          commentVerifyStatus = "failed";
          log(`[delivery-recovery] Warning: Failed to post handoff comment (exit ${commentRes.exitCode}): ${commentRes.stderr}`);
        }
      } catch (err) {
        commentPosted = false;
        commentVerifyStatus = "failed";
        log(`[delivery-recovery] Warning: Exception posting comment: ${String(err)}`);
      }
    }
  }

  const pendingCompensation = !(readyLabelRemoved && commentPosted);

  await stateStorage.writeState({
    ...currentState,
    readyLabelRemoved,
    commentPosted,
    commentVerifyStatus,
    pendingCompensation,
    handoff: currentState.handoff ?? handoffToPost,
    lastUpdated: new Date().toISOString(),
  });

  return {
    success: readyLabelRemoved && commentPosted,
    readyLabelRemoved,
    commentPosted,
    commentVerifyStatus,
    pendingCompensation,
  };
}
