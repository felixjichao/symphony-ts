/**
 * GitHub delivery execution service (SPEC §11.5 / MVP.3).
 *
 * Provides narrow delivery primitives for Codex and orchestrator:
 * - ensurePr: idempotent PR creation or precise ownership reuse
 * - readPr: read PR state and verify ownership marker
 * - readChecks: fetch required/current checks bound to head SHA & evaluate CI policy
 * - diagnoseFailedChecks: format safe, actionable failure diagnostics
 * - landPr: squash merge with server-side head matching and post-merge verification
 * - verifyMerged: verify merged state and commit SHA
 */
import {
  evaluateChecksAutoMergePolicy,
  formatPrBody,
  validatePrOwnership,
  DeliveryError,
  type CheckConclusion,
  type CheckState,
  type ChecksEvaluationResult,
  type DeliveryContext,
  type PrCheck,
  type PrMergeability,
  type PrRecord,
  type PrState,
} from "@symphony/domain";
import { type GhRunner, DefaultGhRunner, sanitizeCredentials } from "./gh-cli";

export interface EnsurePrOptions {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly draft?: boolean | undefined;
}

export interface ReadPrOptions {
  readonly prNumber?: number | undefined;
}

export interface ReadChecksOptions {
  readonly prNumber?: number | undefined;
  readonly expectedHeadSha?: string | undefined;
}

export interface PrChecksReport {
  readonly prNumber: number;
  readonly headSha: string;
  readonly status: ChecksEvaluationResult["status"];
  readonly canAutoMerge: boolean;
  readonly reason: string;
  readonly requiredChecks: readonly PrCheck[];
  readonly currentChecks: readonly PrCheck[];
  readonly failedOrPendingChecks: readonly PrCheck[];
}

export interface LandPrOptions {
  readonly optIn: boolean;
  readonly prNumber?: number | undefined;
  readonly expectedHeadSha?: string | undefined;
  readonly deleteBranch?: boolean | undefined;
}

export interface LandPrResult {
  readonly merged: true;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
}

export interface VerifyMergedResult {
  readonly merged: boolean;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string | null;
  readonly mergedAt: string | null;
}

interface RawPrJson {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly isDraft?: boolean | undefined;
  readonly mergeable?: string | undefined;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly url: string;
  readonly mergedAt?: string | null | undefined;
  readonly mergeCommit?: { readonly oid?: string | undefined } | null | undefined;
  readonly statusCheckRollup?: readonly RawStatusCheckItem[] | undefined;
}

interface RawCheckRunItem {
  readonly __typename: "CheckRun";
  readonly name: string;
  readonly workflowName?: string | null | undefined;
  readonly status: string;
  readonly conclusion?: string | null | undefined;
  readonly detailsUrl?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

interface RawStatusContextItem {
  readonly __typename: "StatusContext";
  readonly context: string;
  readonly state: string;
  readonly targetUrl?: string | null | undefined;
}

type RawStatusCheckItem = RawCheckRunItem | RawStatusContextItem;

export class GitHubDeliveryService {
  private readonly runner: GhRunner;

  constructor(runner?: GhRunner) {
    this.runner = runner ?? new DefaultGhRunner();
  }

  /**
   * Create or reuse an existing pull request for the issue/workspace branch.
   */
  async ensurePr(context: DeliveryContext, options: EnsurePrOptions = {}): Promise<PrRecord> {
    this.validateContext(context);

    // List candidate PRs on this repo with matching head branch
    const candidates = await this.listCandidatePrs(context);

    if (candidates.length === 0) {
      // Create new PR
      const title = options.title ?? `fix: issue #${context.issueNumber} (${context.workspaceKey})`;
      const body = formatPrBody({ body: options.body, context });

      const createArgs = [
        "pr",
        "create",
        "--repo",
        context.repo,
        "--head",
        context.headBranch,
        "--base",
        context.baseBranch,
        "--title",
        title,
        "--body",
        body,
      ];
      if (options.draft) {
        createArgs.push("--draft");
      }

      try {
        await this.runner.exec(createArgs);
      } catch (err: unknown) {
        // Handle race where PR was created concurrently
        const errMessage = (err as Error).message || "";
        if (errMessage.includes("already exists") || errMessage.includes("Pull request already exists")) {
          const freshCandidates = await this.listCandidatePrs(context);
          if (freshCandidates.length === 1) {
            return this.validateAndConvertCandidate(freshCandidates[0]!, context);
          }
        }
        throw err;
      }

      // Re-query newly created PR to obtain full details
      const freshCandidates = await this.listCandidatePrs(context);
      const created = freshCandidates.find(c => c.headRefName === context.headBranch);
      if (!created) {
        throw new DeliveryError("PR was created but could not be retrieved from repository", {
          code: "cli_malformed_response",
        });
      }
      return this.validateAndConvertCandidate(created, context);
    }

    if (candidates.length === 1) {
      return this.validateAndConvertCandidate(candidates[0]!, context);
    }

    throw new DeliveryError(
      `Multiple candidate PRs found matching head branch '${context.headBranch}'; refusal to prevent hijacking`,
      {
        code: "ownership_refusal",
        details: { count: candidates.length, numbers: candidates.map(c => c.number) },
      },
    );
  }

  /**
   * Read PR details and verify ownership marker.
   */
  async readPr(context: DeliveryContext, options: ReadPrOptions = {}): Promise<PrRecord> {
    this.validateContext(context);
    const target = options.prNumber !== undefined ? String(options.prNumber) : context.headBranch;

    const fields = [
      "number",
      "title",
      "body",
      "state",
      "isDraft",
      "mergeable",
      "headRefName",
      "headRefOid",
      "baseRefName",
      "url",
      "mergedAt",
      "mergeCommit",
      "statusCheckRollup",
    ].join(",");

    const res = await this.runner.exec(["pr", "view", target, "--repo", context.repo, "--json", fields]);
    let raw: RawPrJson;
    try {
      raw = JSON.parse(res.stdout) as RawPrJson;
    } catch (err) {
      throw new DeliveryError("Failed to parse JSON response from gh pr view", {
        code: "cli_malformed_response",
        cause: err,
      });
    }

    return this.validateAndConvertCandidate(raw, context);
  }

  /**
   * Fetch checks bound to head SHA and evaluate against CI policy.
   */
  async readChecks(context: DeliveryContext, options: ReadChecksOptions = {}): Promise<PrChecksReport> {
    const pr = await this.readPr(context, { prNumber: options.prNumber });

    if (options.expectedHeadSha && pr.headSha !== options.expectedHeadSha) {
      throw new DeliveryError(
        `PR head commit changed: expected ${options.expectedHeadSha}, current is ${pr.headSha}`,
        {
          code: "head_changed",
          details: { expected: options.expectedHeadSha, actual: pr.headSha },
        },
      );
    }

    // 1. Fetch required checks from gh pr checks --required
    const requiredCheckNames = await this.fetchRequiredCheckNames(context.repo, pr.number);

    // 2. Fetch all current checks from statusCheckRollup (from pr view)
    const viewFields = "statusCheckRollup,headRefOid";
    const res = await this.runner.exec([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      context.repo,
      "--json",
      viewFields,
    ]);

    let rawView: RawPrJson;
    try {
      rawView = JSON.parse(res.stdout) as RawPrJson;
    } catch (err) {
      throw new DeliveryError("Failed to parse JSON statusCheckRollup from gh pr view", {
        code: "cli_malformed_response",
        cause: err,
      });
    }

    const currentChecks: PrCheck[] = [];
    const seenNames = new Set<string>();

    if (rawView.statusCheckRollup && Array.isArray(rawView.statusCheckRollup)) {
      for (const item of rawView.statusCheckRollup) {
        const check = this.normalizeCheckItem(item, requiredCheckNames);
        if (check) {
          currentChecks.push(check);
          seenNames.add(check.name);
        }
      }
    }

    // If required checks are configured but not yet reported in rollup, represent as PENDING
    const requiredChecks: PrCheck[] = [];
    for (const reqName of requiredCheckNames) {
      const existing = currentChecks.find(c => c.name === reqName);
      if (existing) {
        requiredChecks.push(existing);
      } else {
        const pendingPlaceholder: PrCheck = {
          name: reqName,
          state: "PENDING",
          conclusion: null,
          isRequired: true,
        };
        requiredChecks.push(pendingPlaceholder);
        currentChecks.push(pendingPlaceholder);
      }
    }

    // Evaluate CI policy
    const evaluation = evaluateChecksAutoMergePolicy(requiredChecks, currentChecks);

    return {
      prNumber: pr.number,
      headSha: pr.headSha,
      status: evaluation.status,
      canAutoMerge: evaluation.canAutoMerge,
      reason: evaluation.reason,
      requiredChecks,
      currentChecks,
      failedOrPendingChecks: evaluation.failedOrPendingChecks,
    };
  }

  /**
   * Formats safe, actionable diagnostic information for failed or pending checks.
   */
  diagnoseFailedChecks(report: PrChecksReport): string {
    if (report.canAutoMerge) {
      return "All checks passed. PR is ready for auto-merge.";
    }

    const lines: string[] = [
      `CI Check Policy Evaluation: ${report.status.toUpperCase()}`,
      `Reason: ${report.reason}`,
      `Head SHA: ${report.headSha}`,
      "",
    ];

    if (report.failedOrPendingChecks.length > 0) {
      lines.push("Unresolved checks:");
      for (const check of report.failedOrPendingChecks) {
        const reqStr = check.isRequired ? "[REQUIRED]" : "[OPTIONAL]";
        const statusStr = check.state === "PENDING" ? "PENDING" : check.conclusion ?? "UNKNOWN";
        const wfStr = check.workflowName ? ` (${check.workflowName})` : "";
        const urlStr = check.detailsUrl ? ` -> ${sanitizeCredentials(check.detailsUrl)}` : "";
        lines.push(`  - ${reqStr} ${check.name}${wfStr}: ${statusStr}${urlStr}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Execute squash merge with strict policy checks, server-side expected-head matching,
   * and post-merge verification.
   */
  async landPr(context: DeliveryContext, options: LandPrOptions): Promise<LandPrResult> {
    if (!options.optIn) {
      throw new DeliveryError("Auto-merge refused: explicit opt-in (--opt-in) is required", {
        code: "opt_in_required",
      });
    }

    // 1. Read fresh PR state
    const pr = await this.readPr(context, { prNumber: options.prNumber });

    if (pr.state === "MERGED") {
      return {
        merged: true,
        prNumber: pr.number,
        headSha: pr.headSha,
        mergeCommitSha: pr.mergeCommitSha ?? pr.headSha,
        mergedAt: pr.mergedAt ?? new Date().toISOString(),
      };
    }

    if (pr.state !== "OPEN") {
      throw new DeliveryError(`PR #${pr.number} is not open (current state: ${pr.state})`, {
        code: "merge_rejected",
        details: { state: pr.state },
      });
    }

    if (pr.isDraft) {
      throw new DeliveryError(`PR #${pr.number} is in draft mode; cannot auto-merge draft PR`, {
        code: "merge_rejected",
        details: { isDraft: true },
      });
    }

    if (pr.mergeable === "CONFLICTING") {
      throw new DeliveryError(`PR #${pr.number} has merge conflicts with ${context.baseBranch}`, {
        code: "merge_rejected",
        details: { mergeable: pr.mergeable },
      });
    }

    if (pr.mergeable === "UNKNOWN") {
      throw new DeliveryError(
        `PR #${pr.number} mergeability is UNKNOWN; GitHub is calculating merge status`,
        {
          code: "merge_rejected",
          details: { mergeable: pr.mergeable },
        },
      );
    }

    const targetHeadSha = options.expectedHeadSha ?? pr.headSha;
    if (pr.headSha !== targetHeadSha) {
      throw new DeliveryError(
        `PR head commit changed before merge: expected ${targetHeadSha}, found ${pr.headSha}`,
        {
          code: "head_changed",
          details: { expected: targetHeadSha, actual: pr.headSha },
        },
      );
    }

    // 2. Read checks and verify CI policy
    const checks = await this.readChecks(context, {
      prNumber: pr.number,
      expectedHeadSha: targetHeadSha,
    });

    if (!checks.canAutoMerge) {
      const code = checks.status === "pending" ? "checks_waiting" : "checks_failing";
      throw new DeliveryError(`Cannot auto-merge PR #${pr.number}: ${checks.reason}`, {
        code,
        details: { status: checks.status, reason: checks.reason },
      });
    }

    // 3. Execute squash merge using --match-head-commit
    const mergeArgs = [
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      context.repo,
      "--squash",
      "--match-head-commit",
      targetHeadSha,
    ];
    if (options.deleteBranch) {
      mergeArgs.push("--delete-branch");
    }

    let mergeErr: unknown;
    try {
      await this.runner.exec(mergeArgs);
    } catch (err) {
      mergeErr = err;
    }

    // 4. Post-merge verification (CRITICAL invariant: exit code 0 alone is not proof of merge)
    let freshPr: PrRecord;
    try {
      freshPr = await this.readPr(context, { prNumber: pr.number });
    } catch {
      if (mergeErr) {
        throw mergeErr;
      }
      throw new DeliveryError(`Merge command executed for PR #${pr.number}, but verification read failed`, {
        code: "verification_unknown",
      });
    }

    if (freshPr.state === "MERGED") {
      return {
        merged: true,
        prNumber: freshPr.number,
        headSha: targetHeadSha,
        mergeCommitSha: freshPr.mergeCommitSha ?? targetHeadSha,
        mergedAt: freshPr.mergedAt ?? new Date().toISOString(),
      };
    }

    if (mergeErr) {
      throw mergeErr;
    }

    throw new DeliveryError(
      `PR #${pr.number} merge command executed, but PR state is still ${freshPr.state}`,
      {
        code: "verification_unknown",
        details: { state: freshPr.state },
      },
    );
  }

  /**
   * Verify whether a PR has reached the final merged state.
   */
  async verifyMerged(context: DeliveryContext, options: ReadPrOptions = {}): Promise<VerifyMergedResult> {
    const pr = await this.readPr(context, options);
    return {
      merged: pr.state === "MERGED",
      prNumber: pr.number,
      headSha: pr.headSha,
      mergeCommitSha: pr.mergeCommitSha,
      mergedAt: pr.mergedAt,
    };
  }

  private validateContext(context: DeliveryContext): void {
    if (!context.repo || !context.repo.includes("/")) {
      throw new DeliveryError(`Invalid repository specifier '${context.repo}'; expected owner/repo`, {
        code: "invalid_context",
      });
    }
    if (!context.issueNumber || context.issueNumber <= 0) {
      throw new DeliveryError(`Invalid issue number '${context.issueNumber}'`, {
        code: "invalid_context",
      });
    }
    if (!context.workspaceKey || context.workspaceKey.trim() === "") {
      throw new DeliveryError("Workspace key must not be empty", {
        code: "invalid_context",
      });
    }
    if (!context.headBranch || context.headBranch.trim() === "") {
      throw new DeliveryError("Head branch must not be empty", {
        code: "invalid_context",
      });
    }
    if (!context.baseBranch || context.baseBranch.trim() === "") {
      throw new DeliveryError("Base branch must not be empty", {
        code: "invalid_context",
      });
    }
  }

  private async listCandidatePrs(context: DeliveryContext): Promise<RawPrJson[]> {
    const fields = [
      "number",
      "title",
      "body",
      "state",
      "isDraft",
      "mergeable",
      "headRefName",
      "headRefOid",
      "baseRefName",
      "url",
      "mergedAt",
      "mergeCommit",
    ].join(",");

    const res = await this.runner.exec([
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
      fields,
    ]);

    try {
      return JSON.parse(res.stdout) as RawPrJson[];
    } catch (err) {
      throw new DeliveryError("Failed to parse JSON list from gh pr list", {
        code: "cli_malformed_response",
        cause: err,
      });
    }
  }

  private validateAndConvertCandidate(candidate: RawPrJson, context: DeliveryContext): PrRecord {
    // Verify base branch matches
    if (candidate.baseRefName !== context.baseBranch) {
      throw new DeliveryError(
        `PR #${candidate.number} base branch mismatch: expected '${context.baseBranch}', got '${candidate.baseRefName}'`,
        { code: "ownership_refusal" },
      );
    }

    // Verify ownership marker
    const validation = validatePrOwnership(candidate.body ?? "", context);
    if (!validation.valid) {
      throw new DeliveryError(
        `PR #${candidate.number} failed Symphony ownership validation: ${validation.reason}`,
        {
          code: "ownership_refusal",
          details: { prNumber: candidate.number, reason: validation.reason },
        },
      );
    }

    const stateStr = (candidate.state || "").toUpperCase();
    const state: PrState = stateStr === "MERGED" ? "MERGED" : stateStr === "CLOSED" ? "CLOSED" : "OPEN";

    if (state === "CLOSED") {
      throw new DeliveryError(
        `PR #${candidate.number} was closed without being merged; cannot reuse or auto-merge closed PR`,
        {
          code: "pr_closed_unmerged",
          details: { prNumber: candidate.number },
        },
      );
    }

    const mergeableStr = (candidate.mergeable || "").toUpperCase();
    const mergeable: PrMergeability =
      mergeableStr === "MERGEABLE"
        ? "MERGEABLE"
        : mergeableStr === "CONFLICTING"
        ? "CONFLICTING"
        : "UNKNOWN";

    return {
      number: candidate.number,
      url: candidate.url,
      title: candidate.title,
      body: candidate.body ?? "",
      state,
      isDraft: Boolean(candidate.isDraft),
      mergeable,
      headBranch: candidate.headRefName,
      headSha: candidate.headRefOid,
      baseBranch: candidate.baseRefName,
      mergedAt: candidate.mergedAt ?? null,
      mergeCommitSha: candidate.mergeCommit?.oid ?? null,
      marker: validation.marker,
    };
  }

  private async fetchRequiredCheckNames(repo: string, prNumber: number): Promise<Set<string>> {
    const requiredNames = new Set<string>();

    try {
      const res = await this.runner.exec(
        ["pr", "checks", String(prNumber), "--repo", repo, "--required"],
        { allowedExitCodes: [0, 8, 1] },
      );

      const out = res.stdout;
      if (out.includes("no required checks reported")) {
        return requiredNames;
      }

      // Parse tab-delimited checks: name\tstatus\tduration\turl
      const lines = out.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = line.split("\t");
        const name = parts[0]?.trim();
        if (name && name !== "name") {
          requiredNames.add(name);
        }
      }
    } catch (err) {
      // If gh pr checks --required failed with fatal exit code, surface as error
      throw new DeliveryError(`Failed to query required checks for PR #${prNumber}: ${(err as Error).message}`, {
        code: "checks_unknown",
        cause: err,
      });
    }

    return requiredNames;
  }

  private normalizeCheckItem(
    item: RawStatusCheckItem,
    requiredNames: ReadonlySet<string>,
  ): PrCheck | null {
    if (item.__typename === "CheckRun") {
      const name = item.name;
      const statusUpper = (item.status || "").toUpperCase();
      const conclusionUpper = (item.conclusion || "").toUpperCase();

      const isCompleted = statusUpper === "COMPLETED";
      const state: CheckState = isCompleted ? "COMPLETED" : "PENDING";

      let conclusion: CheckConclusion | null = null;
      if (isCompleted) {
        switch (conclusionUpper) {
          case "SUCCESS":
            conclusion = "SUCCESS";
            break;
          case "FAILURE":
            conclusion = "FAILURE";
            break;
          case "SKIPPED":
            conclusion = "SKIPPED";
            break;
          case "NEUTRAL":
            conclusion = "NEUTRAL";
            break;
          case "CANCELLED":
            conclusion = "CANCELLED";
            break;
          case "TIMED_OUT":
            conclusion = "TIMED_OUT";
            break;
          case "ACTION_REQUIRED":
            conclusion = "ACTION_REQUIRED";
            break;
          default:
            conclusion = "UNKNOWN";
        }
      }

      return {
        name,
        workflowName: item.workflowName ?? null,
        state,
        conclusion,
        isRequired: requiredNames.has(name),
        detailsUrl: item.detailsUrl ?? null,
        startedAt: item.startedAt ?? null,
        completedAt: item.completedAt ?? null,
      };
    }

    if (item.__typename === "StatusContext") {
      const name = item.context;
      const stateUpper = (item.state || "").toUpperCase();

      const isPending = stateUpper === "PENDING";
      const state: CheckState = isPending ? "PENDING" : "COMPLETED";

      let conclusion: CheckConclusion | null = null;
      if (!isPending) {
        conclusion = stateUpper === "SUCCESS" ? "SUCCESS" : "FAILURE";
      }

      return {
        name,
        state,
        conclusion,
        isRequired: requiredNames.has(name),
        detailsUrl: item.targetUrl ?? null,
      };
    }

    return null;
  }
}
