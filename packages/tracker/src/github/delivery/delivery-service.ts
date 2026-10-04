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
  readonly isCrossRepository?: boolean | undefined;
  readonly headRepository?: { readonly name?: string | undefined } | null | undefined;
  readonly headRepositoryOwner?: { readonly login?: string | undefined } | null | undefined;
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
        // Handle race or uncertain outcome (e.g. timeout, network error, already exists): re-query facts
        try {
          const freshCandidates = await this.listCandidatePrs(context);
          if (freshCandidates.length === 1) {
            return this.validateAndConvertCandidate(freshCandidates[0]!, context);
          }
          if (freshCandidates.length > 1) {
            throw new DeliveryError(
              `Multiple candidate PRs found matching head branch '${context.headBranch}' after PR creation error; refusal to prevent hijacking`,
              {
                code: "ownership_refusal",
                details: { count: freshCandidates.length, numbers: freshCandidates.map(c => c.number) },
              },
            );
          }
        } catch (recoveryErr) {
          if (recoveryErr instanceof DeliveryError && recoveryErr.code === "ownership_refusal") {
            throw recoveryErr;
          }
        }
        throw err;
      }

      // Re-query newly created PR to obtain full details
      const freshCandidates = await this.listCandidatePrs(context);
      if (freshCandidates.length === 1) {
        return this.validateAndConvertCandidate(freshCandidates[0]!, context);
      }
      if (freshCandidates.length > 1) {
        throw new DeliveryError(
          `Multiple candidate PRs found matching head branch '${context.headBranch}' after PR creation; refusal to prevent hijacking`,
          {
            code: "ownership_refusal",
            details: { count: freshCandidates.length, numbers: freshCandidates.map(c => c.number) },
          },
        );
      }
      throw new DeliveryError("PR was created but could not be retrieved from repository", {
        code: "cli_malformed_response",
      });
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
      "isCrossRepository",
      "headRepository",
      "headRepositoryOwner",
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

    // 1. Fetch authoritative required checks configuration
    const requiredCheckNames = await this.fetchRequiredCheckNames(
      context.repo,
      pr.number,
      context.baseBranch,
    );

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

    // Verify checks belong to the expected head SHA
    if (!rawView.headRefOid || typeof rawView.headRefOid !== "string") {
      throw new DeliveryError(
        `PR checks query response missing headRefOid for PR #${pr.number}`,
        { code: "checks_unknown" },
      );
    }
    if (rawView.headRefOid !== pr.headSha) {
      throw new DeliveryError(
        `PR head commit changed during checks query: expected ${pr.headSha}, observed ${rawView.headRefOid}`,
        {
          code: "head_changed",
          details: { expected: pr.headSha, actual: rawView.headRefOid },
        },
      );
    }

    const currentChecks: PrCheck[] = [];
    const seenNames = new Set<string>();

    if (rawView.statusCheckRollup && Array.isArray(rawView.statusCheckRollup)) {
      for (const item of rawView.statusCheckRollup) {
        const check = this.normalizeCheckItem(item, requiredCheckNames);
        currentChecks.push(check);
        seenNames.add(check.name);
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
      if (!pr.mergeCommitSha || !pr.mergedAt) {
        throw new DeliveryError(`PR #${pr.number} is merged, but merge commit SHA or timestamp is missing`, {
          code: "verification_unknown",
        });
      }
      return {
        merged: true,
        prNumber: pr.number,
        headSha: pr.headSha,
        mergeCommitSha: pr.mergeCommitSha,
        mergedAt: pr.mergedAt,
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

    // 3. Re-read PR state after reading checks and immediately before merge
    const rePr = await this.readPr(context, { prNumber: pr.number });
    if (rePr.headSha !== targetHeadSha) {
      throw new DeliveryError(
        `PR head commit changed between check verification and merge: expected ${targetHeadSha}, current is ${rePr.headSha}`,
        {
          code: "head_changed",
          details: { expected: targetHeadSha, actual: rePr.headSha },
        },
      );
    }
    if (rePr.state !== "OPEN") {
      throw new DeliveryError(`PR state changed to ${rePr.state} before merge`, {
        code: "merge_rejected",
        details: { state: rePr.state },
      });
    }
    if (rePr.isDraft) {
      throw new DeliveryError("PR was switched to draft mode before merge", {
        code: "merge_rejected",
      });
    }
    if (rePr.mergeable !== "MERGEABLE") {
      throw new DeliveryError(`PR mergeability changed to ${rePr.mergeable} before merge`, {
        code: "merge_rejected",
        details: { mergeable: rePr.mergeable },
      });
    }

    // 4. Execute squash merge using direct REST API (never gh pr merge --squash, avoiding deferred merge/queue)
    let mergeErr: unknown;
    try {
      await this.runner.exec([
        "api",
        `repos/${context.repo}/pulls/${pr.number}/merge`,
        "-X",
        "PUT",
        "-F",
        "merge_method=squash",
        "-F",
        `sha=${targetHeadSha}`,
      ]);
    } catch (err) {
      mergeErr = err;
    }

    // 5. Post-merge verification (CRITICAL invariant: exit code 0 alone is not proof of merge)
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
      if (!freshPr.mergeCommitSha || !freshPr.mergedAt) {
        throw new DeliveryError(
          `PR #${freshPr.number} was merged, but merge commit SHA or timestamp is missing`,
          { code: "verification_unknown" },
        );
      }

      if (options.deleteBranch) {
        try {
          await this.runner.exec([
            "api",
            `repos/${context.repo}/git/refs/heads/${encodeURIComponent(context.headBranch)}`,
            "-X",
            "DELETE",
          ]);
        } catch {
          // Non-fatal if branch deletion fails or was already deleted
        }
      }

      return {
        merged: true,
        prNumber: freshPr.number,
        headSha: targetHeadSha,
        mergeCommitSha: freshPr.mergeCommitSha,
        mergedAt: freshPr.mergedAt,
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
    if (pr.state === "MERGED") {
      if (!pr.mergeCommitSha || !pr.mergedAt) {
        throw new DeliveryError(
          `PR #${pr.number} is reported as MERGED, but mergeCommitSha or mergedAt is missing from GitHub API response`,
          {
            code: "verification_unknown",
            details: {
              prNumber: pr.number,
              mergeCommitSha: pr.mergeCommitSha,
              mergedAt: pr.mergedAt,
            },
          },
        );
      }
      return {
        merged: true,
        prNumber: pr.number,
        headSha: pr.headSha,
        mergeCommitSha: pr.mergeCommitSha,
        mergedAt: pr.mergedAt,
      };
    }
    return {
      merged: false,
      prNumber: pr.number,
      headSha: pr.headSha,
      mergeCommitSha: null,
      mergedAt: null,
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
      "isCrossRepository",
      "headRepository",
      "headRepositoryOwner",
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
    // 1. Verify head branch matches context
    if (candidate.headRefName !== context.headBranch) {
      throw new DeliveryError(
        `PR #${candidate.number} head branch mismatch: expected '${context.headBranch}', got '${candidate.headRefName}'`,
        { code: "ownership_refusal" },
      );
    }

    // 2. Reject fork / cross-repository PRs - strictly verify candidate.isCrossRepository === false
    if (candidate.isCrossRepository !== false) {
      throw new DeliveryError(
        `PR #${candidate.number} is from a cross-repository fork or has unverified repository boundary; refusal to prevent foreign takeover`,
        { code: "ownership_refusal" },
      );
    }

    // 3. Verify head repository strictly matches target repository
    if (!candidate.headRepositoryOwner?.login || !candidate.headRepository?.name) {
      throw new DeliveryError(
        `PR #${candidate.number} has missing head repository identity; refusal to prevent foreign takeover`,
        { code: "ownership_refusal" },
      );
    }
    const headRepoSlug = `${candidate.headRepositoryOwner.login}/${candidate.headRepository.name}`.toLowerCase();
    if (headRepoSlug !== context.repo.toLowerCase()) {
      throw new DeliveryError(
        `PR #${candidate.number} head repository mismatch: expected '${context.repo}', got '${headRepoSlug}'`,
        { code: "ownership_refusal" },
      );
    }

    // 4. Verify base branch matches
    if (candidate.baseRefName !== context.baseBranch) {
      throw new DeliveryError(
        `PR #${candidate.number} base branch mismatch: expected '${context.baseBranch}', got '${candidate.baseRefName}'`,
        { code: "ownership_refusal" },
      );
    }

    // 5. Verify headRefOid exists and is valid string
    if (!candidate.headRefOid || typeof candidate.headRefOid !== "string") {
      throw new DeliveryError(
        `PR #${candidate.number} is missing headRefOid`,
        { code: "cli_malformed_response" },
      );
    }

    // 5. Verify ownership marker and exact closing issue association
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

  private async fetchRequiredCheckNames(repo: string, prNumber: number, baseBranch: string): Promise<Set<string>> {
    const requiredNames = new Set<string>();
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      throw new DeliveryError(`Invalid repository slug '${repo}'`, { code: "invalid_context" });
    }

    // 1. Query GraphQL for branchProtectionRule on baseRef
    const query = `query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          baseRef {
            branchProtectionRule {
              requiredStatusCheckContexts
              requiredStatusChecks { context }
            }
          }
        }
      }
    }`;

    try {
      const res = await this.runner.exec([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repoName}`,
        "-F",
        `pr=${prNumber}`,
      ]);

      interface GraphQLResponse {
        readonly data?: {
          readonly repository?: {
            readonly pullRequest?: {
              readonly baseRef?: {
                readonly branchProtectionRule?: {
                  readonly requiredStatusCheckContexts?: readonly string[] | null;
                  readonly requiredStatusChecks?: ReadonlyArray<{ readonly context: string }> | null;
                } | null;
              } | null;
            } | null;
          } | null;
        } | null;
        readonly errors?: ReadonlyArray<{ readonly message?: string }> | null;
      }

      let json: GraphQLResponse;
      try {
        json = JSON.parse(res.stdout) as GraphQLResponse;
      } catch (err) {
        throw new DeliveryError("Failed to parse GraphQL response for branch protection checks", {
          code: "checks_unknown",
          cause: err,
        });
      }

      if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
        throw new DeliveryError(
          `GraphQL error querying branch protection checks: ${json.errors[0]?.message ?? "unknown"}`,
          { code: "checks_unknown" },
        );
      }

      if (!json || typeof json !== "object" || !json.data || typeof json.data !== "object") {
        throw new DeliveryError(
          `Malformed GraphQL response when querying branch protection: missing data`,
          { code: "checks_unknown" },
        );
      }

      const repoData = json.data.repository;
      if (!repoData || typeof repoData !== "object") {
        throw new DeliveryError(
          `Malformed GraphQL response when querying branch protection: missing repository`,
          { code: "checks_unknown" },
        );
      }

      const pr = repoData.pullRequest;
      if (!pr || typeof pr !== "object") {
        throw new DeliveryError(
          `Malformed GraphQL response when querying branch protection: missing pullRequest`,
          { code: "checks_unknown" },
        );
      }

      if (!("baseRef" in pr) || pr.baseRef === undefined || pr.baseRef === null) {
        throw new DeliveryError(
          `Malformed GraphQL response when querying branch protection: missing or null baseRef`,
          { code: "checks_unknown" },
        );
      }

      const baseRef = pr.baseRef;
      if (typeof baseRef !== "object" || !("branchProtectionRule" in baseRef) || baseRef.branchProtectionRule === undefined) {
        throw new DeliveryError(
          `Malformed GraphQL response when querying branch protection: missing branchProtectionRule on baseRef`,
          { code: "checks_unknown" },
        );
      }

      const bpr = baseRef.branchProtectionRule;
      if (bpr !== null) {
        if (typeof bpr !== "object") {
          throw new DeliveryError(
            `Malformed branchProtectionRule in GraphQL response`,
            { code: "checks_unknown" },
          );
        }

        const hasContexts = "requiredStatusCheckContexts" in bpr && bpr.requiredStatusCheckContexts !== undefined;
        const hasChecks = "requiredStatusChecks" in bpr && bpr.requiredStatusChecks !== undefined;

        if (!hasContexts && !hasChecks) {
          throw new DeliveryError(
            `Malformed branchProtectionRule in GraphQL response: missing check fields`,
            { code: "checks_unknown" },
          );
        }

        if (hasContexts && bpr.requiredStatusCheckContexts !== null) {
          if (!Array.isArray(bpr.requiredStatusCheckContexts)) {
            throw new DeliveryError(
              `Malformed requiredStatusCheckContexts in GraphQL response`,
              { code: "checks_unknown" },
            );
          }
          for (const ctx of bpr.requiredStatusCheckContexts) {
            if (typeof ctx !== "string" || !ctx.trim()) {
              throw new DeliveryError(
                `Invalid requiredStatusCheckContexts entry in GraphQL response`,
                { code: "checks_unknown" },
              );
            }
            requiredNames.add(ctx.trim());
          }
        }

        if (hasChecks && bpr.requiredStatusChecks !== null) {
          if (!Array.isArray(bpr.requiredStatusChecks)) {
            throw new DeliveryError(
              `Malformed requiredStatusChecks in GraphQL response`,
              { code: "checks_unknown" },
            );
          }
          for (const check of bpr.requiredStatusChecks) {
            if (!check || typeof check !== "object" || typeof check.context !== "string" || !check.context.trim()) {
              throw new DeliveryError(
                `Invalid requiredStatusChecks entry in GraphQL response`,
                { code: "checks_unknown" },
              );
            }
            requiredNames.add(check.context.trim());
          }
        }
      }
    } catch (err) {
      if (err instanceof DeliveryError && err.code === "checks_unknown") {
        throw err;
      }
      throw new DeliveryError(
        `Failed to query branch protection required checks for PR #${prNumber}: ${(err as Error).message}`,
        {
          code: "checks_unknown",
          cause: err,
        },
      );
    }

    // 2. Query repository branch rulesets (REST) with pagination
    try {
      const rulesRes = await this.runner.exec([
        "api",
        `repos/${repo}/rules/branches/${encodeURIComponent(baseBranch)}`,
        "--paginate",
      ]);

      interface RulesetItem {
        readonly type?: string;
        readonly parameters?: {
          readonly required_status_checks?: ReadonlyArray<{ readonly context?: string }>;
        };
      }

      let rules: unknown[];
      try {
        rules = parseJsonStream(rulesRes.stdout);
      } catch (err) {
        throw new DeliveryError(
          `Failed to parse ruleset response: ${(err as Error).message}`,
          { code: "checks_unknown", cause: err },
        );
      }

      if (!Array.isArray(rules)) {
        throw new DeliveryError(
          `Expected array response from branch rulesets API, got ${typeof rules}`,
          { code: "checks_unknown" },
        );
      }

      for (const rule of rules) {
        if (!rule || typeof rule !== "object") {
          throw new DeliveryError(
            `Malformed ruleset item in branch rulesets API`,
            { code: "checks_unknown" },
          );
        }
        const r = rule as RulesetItem;
        if (!r.type || typeof r.type !== "string" || !r.type.trim()) {
          throw new DeliveryError(
            `Malformed rule type in branch rulesets API`,
            { code: "checks_unknown" },
          );
        }
        if (r.type === "required_status_checks") {
          if (!r.parameters || typeof r.parameters !== "object" || !Array.isArray(r.parameters.required_status_checks)) {
            throw new DeliveryError(
              `Malformed required_status_checks parameters in branch rulesets API`,
              { code: "checks_unknown" },
            );
          }
          for (const item of r.parameters.required_status_checks) {
            if (!item || typeof item !== "object" || typeof item.context !== "string" || !item.context.trim()) {
              throw new DeliveryError(
                `Malformed required_status_checks entry in branch rulesets API`,
                { code: "checks_unknown" },
              );
            }
            requiredNames.add(item.context.trim());
          }
        }
      }
    } catch (err) {
      if (err instanceof DeliveryError && err.code === "checks_unknown") {
        throw err;
      }
      throw new DeliveryError(
        `Failed to query branch rulesets for required checks: ${(err as Error).message}`,
        { code: "checks_unknown", cause: err },
      );
    }

    return requiredNames;
  }

  private normalizeCheckItem(
    item: RawStatusCheckItem,
    requiredNames: ReadonlySet<string>,
  ): PrCheck {
    if (!item || typeof item !== "object") {
      throw new DeliveryError("Malformed item in statusCheckRollup", {
        code: "checks_unknown",
      });
    }

    if (item.__typename === "CheckRun") {
      if (!item.name || typeof item.name !== "string") {
        throw new DeliveryError("CheckRun item missing name in statusCheckRollup", {
          code: "checks_unknown",
        });
      }
      const name = item.name.trim();
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
      if (!item.context || typeof item.context !== "string") {
        throw new DeliveryError("StatusContext item missing context in statusCheckRollup", {
          code: "checks_unknown",
        });
      }
      const name = item.context.trim();
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

    throw new DeliveryError(
      `Unknown status check item __typename '${(item as { readonly __typename?: string }).__typename}' in statusCheckRollup`,
      { code: "checks_unknown" },
    );
  }
}

export function parseJsonStream(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty response from branch rulesets API");
  }
  try {
    const single = JSON.parse(trimmed);
    if (!Array.isArray(single)) {
      throw new Error(`Expected JSON array, got ${typeof single}`);
    }
    return single;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Expected JSON array")) {
      throw err;
    }
    // Handle concatenated JSON arrays produced by gh api --paginate
  }

  const results: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let startIndex = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (depth === 0) {
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        continue;
      }
      if (char !== "[") {
        throw new Error(`Unexpected character '${char}' outside of JSON array at index ${i}`);
      }
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "[") {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        const chunk = trimmed.slice(startIndex, i + 1);
        const parsed = JSON.parse(chunk);
        if (!Array.isArray(parsed)) {
          throw new Error("Expected chunk to be JSON array");
        }
        results.push(...parsed);
        startIndex = -1;
      }
    }
  }

  if (inString || depth !== 0 || startIndex !== -1 || results.length === 0) {
    throw new Error("Malformed JSON stream in response");
  }

  return results;
}
