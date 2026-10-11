/**
 * CLI runner for GitHub delivery commands (SPEC §11.5 / MVP.3):
 *   symphony pr ensure ...
 *   symphony pr read ...
 *   symphony pr checks ...
 *   symphony pr diagnostics ...
 *   symphony pr land ...
 *   symphony pr verify ...
 */
import {
  DecisionBridgeClient,
  DecisionReviewGate,
} from "@symphony/decision";
import {
  DeliveryError,
  type DeliveryContext,
  type DeliveryReviewGate,
} from "@symphony/domain";
import {
  GitHubDeliveryService,
  sanitizeCredentials,
} from "@symphony/tracker";

/**
 * Recursively sanitizes sensitive credentials in all string fields of a data structure.
 */
export function sanitizeData<T>(val: T): T {
  if (typeof val === "string") {
    return sanitizeCredentials(val) as unknown as T;
  }
  if (val === null || val === undefined || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(item => sanitizeData(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    result[k] = sanitizeData(v);
  }
  return result as T;
}

export interface DeliveryCliOutput {
  readonly write: (text: string) => unknown;
}

export interface RunDeliveryCliOptions {
  readonly stdout?: DeliveryCliOutput | undefined;
  readonly stderr?: DeliveryCliOutput | undefined;
  readonly service?: GitHubDeliveryService | undefined;
  readonly reviewGate?: DeliveryReviewGate | undefined;
}

export interface ParsedDeliveryArgs {
  readonly action?: string | undefined;
  readonly repo?: string | undefined;
  readonly issueNumber?: number | undefined;
  readonly workspaceKey?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly expectedHeadSha?: string | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly draft?: boolean | undefined;
  readonly optIn?: boolean | undefined;
  readonly deleteBranch?: boolean | undefined;
  readonly bridgeUrl?: string | undefined;
  readonly bridgeToken?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly json?: boolean | undefined;
  readonly help?: boolean | undefined;
}

export function parseDeliveryArgs(argv: readonly string[]): ParsedDeliveryArgs {
  let action: string | undefined;
  let repo: string | undefined;
  let issueNumber: number | undefined;
  let workspaceKey: string | undefined;
  let headBranch: string | undefined;
  let baseBranch: string | undefined;
  let prNumber: number | undefined;
  let expectedHeadSha: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  let draft = false;
  let optIn = false;
  let deleteBranch = false;
  let bridgeUrl: string | undefined;
  let bridgeToken: string | undefined;
  let sessionId: string | undefined;
  let json = false;
  let help = false;

  let i = 0;
  if (argv.length > 0 && !argv[0]!.startsWith("-")) {
    action = argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--draft") {
      draft = true;
    } else if (arg === "--opt-in") {
      optIn = true;
    } else if (arg === "--delete-branch") {
      deleteBranch = true;
    } else if (arg === "--bridge-url" && i + 1 < argv.length) {
      bridgeUrl = argv[++i];
    } else if (arg === "--bridge-token" && i + 1 < argv.length) {
      bridgeToken = argv[++i];
    } else if (arg === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg === "--issue" && i + 1 < argv.length) {
      const parsed = parseInt(argv[++i]!, 10);
      if (!isNaN(parsed)) issueNumber = parsed;
    } else if (arg === "--workspace-key" && i + 1 < argv.length) {
      workspaceKey = argv[++i];
    } else if (arg === "--head" && i + 1 < argv.length) {
      headBranch = argv[++i];
    } else if (arg === "--base" && i + 1 < argv.length) {
      baseBranch = argv[++i];
    } else if (arg === "--pr" && i + 1 < argv.length) {
      const parsed = parseInt(argv[++i]!, 10);
      if (!isNaN(parsed)) prNumber = parsed;
    } else if (arg === "--expected-head" && i + 1 < argv.length) {
      expectedHeadSha = argv[++i];
    } else if (arg === "--title" && i + 1 < argv.length) {
      title = argv[++i];
    } else if (arg === "--body" && i + 1 < argv.length) {
      body = argv[++i];
    }
  }

  return {
    action,
    repo,
    issueNumber,
    workspaceKey,
    headBranch,
    baseBranch,
    prNumber,
    expectedHeadSha,
    title,
    body,
    draft,
    optIn,
    deleteBranch,
    bridgeUrl,
    bridgeToken,
    sessionId,
    json,
    help,
  };
}

export async function runDeliveryCli(argv: readonly string[], options: RunDeliveryCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const service = options.service ?? new GitHubDeliveryService();

  const args = parseDeliveryArgs(argv);

  if (args.help) {
    if (args.json) {
      stdout.write(`${JSON.stringify({ help: true, usage: "symphony pr <action> [options]", actions: ["ensure", "read", "checks", "diagnostics", "land", "verify"] }, null, 2)}\n`);
    } else {
      stdout.write(
        "Usage: symphony pr <action> [options]\n" +
        "       symphony delivery <action> [options]\n\n" +
        "Actions:\n" +
        "  ensure        Ensure pull request exists (create or reuse)\n" +
        "  read          Read pull request details and state\n" +
        "  checks        Fetch CI checks bound to head and evaluate policy\n" +
        "  diagnostics   Print actionable diagnostics for failed or pending checks\n" +
        "  land          Squash merge PR when policy is satisfied (--opt-in required)\n" +
        "  verify        Verify whether PR is in final merged state\n\n" +
        "Options:\n" +
        "  --repo <owner/repo>       Repository slug (required)\n" +
        "  --issue <number>          GitHub issue number (required)\n" +
        "  --workspace-key <key>     Symphony workspace key (required)\n" +
        "  --head <branch>           Head branch (default: symphony/<workspace-key>)\n" +
        "  --base <branch>           Base branch (default: main)\n" +
        "  --pr <number>             Specific PR number\n" +
        "  --expected-head <sha>     Expected head commit SHA\n" +
        "  --title <text>            PR title for ensure\n" +
        "  --body <text>             PR body text for ensure\n" +
        "  --draft                   Create PR as draft\n" +
        "  --opt-in                  Explicit opt-in required for land\n" +
        "  --delete-branch           Delete head branch on merge\n" +
        "  --json                    Output pure JSON\n" +
        "  -h, --help                Show help\n"
      );
    }
    return 0;
  }

  if (!args.action) {
    if (args.json) {
      stderr.write(`${JSON.stringify({ error: "missing_action", message: "Action is required (ensure, read, checks, diagnostics, land, verify)" })}\n`);
    } else {
      stderr.write("symphony pr error: action is required (ensure, read, checks, diagnostics, land, verify)\n");
    }
    return 1;
  }

  // Validate required context fields
  if (!args.repo || !args.issueNumber || !args.workspaceKey) {
    if (args.json) {
      stderr.write(`${JSON.stringify({ error: "invalid_arguments", message: "missing required options (--repo, --issue, --workspace-key)" })}\n`);
    } else {
      stderr.write("symphony pr error: missing required options (--repo, --issue, --workspace-key)\n");
    }
    return 1;
  }

  const context: DeliveryContext = {
    repo: args.repo,
    issueNumber: args.issueNumber,
    workspaceKey: args.workspaceKey,
    headBranch: args.headBranch ?? `symphony/${args.workspaceKey}`,
    baseBranch: args.baseBranch ?? "main",
  };

  try {
    switch (args.action) {
      case "ensure": {
        const pr = await service.ensurePr(context, {
          title: args.title,
          body: args.body,
          draft: args.draft,
        });
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData(pr), null, 2)}\n`);
        } else {
          stdout.write(sanitizeCredentials(`PR #${pr.number} ensured: ${pr.url} [state: ${pr.state}, mergeable: ${pr.mergeable}]\n`));
        }
        return 0;
      }

      case "read": {
        const pr = await service.readPr(context, { prNumber: args.prNumber });
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData(pr), null, 2)}\n`);
        } else {
          stdout.write(
            sanitizeCredentials(
              `PR #${pr.number}: ${pr.title}\n` +
              `URL: ${pr.url}\n` +
              `State: ${pr.state}\n` +
              `Mergeable: ${pr.mergeable}\n` +
              `Head: ${pr.headBranch} (${pr.headSha})\n` +
              `Base: ${pr.baseBranch}\n`
            )
          );
        }
        return 0;
      }

      case "checks": {
        const report = await service.readChecks(context, {
          prNumber: args.prNumber,
          expectedHeadSha: args.expectedHeadSha,
        });
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData(report), null, 2)}\n`);
        } else {
          stdout.write(
            sanitizeCredentials(
              `Checks for PR #${report.prNumber} @ ${report.headSha.slice(0, 8)}:\n` +
              `Status: ${report.status.toUpperCase()}\n` +
              `Can auto-merge: ${report.canAutoMerge ? "YES" : "NO"}\n` +
              `Reason: ${report.reason}\n` +
              `Required checks: ${report.requiredChecks.length}, Current checks: ${report.currentChecks.length}\n`
            )
          );
        }
        return report.canAutoMerge ? 0 : 2;
      }

      case "diagnostics": {
        const report = await service.readChecks(context, {
          prNumber: args.prNumber,
          expectedHeadSha: args.expectedHeadSha,
        });
        const diagnostics = service.diagnoseFailedChecks(report);
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData({
            prNumber: report.prNumber,
            headSha: report.headSha,
            status: report.status,
            canAutoMerge: report.canAutoMerge,
            reason: report.reason,
            failedOrPendingChecks: report.failedOrPendingChecks,
            diagnostics,
          }), null, 2)}\n`);
        } else {
          stdout.write(sanitizeCredentials(`${diagnostics}\n`));
        }
        return report.canAutoMerge ? 0 : 2;
      }

      case "land": {
        if (!args.optIn) {
          if (args.json) {
            stderr.write(`${JSON.stringify(sanitizeData({ error: "opt_in_required", message: "land requires explicit opt-in (--opt-in)" }))}\n`);
          } else {
            stderr.write("symphony pr error: land requires explicit opt-in (--opt-in)\n");
          }
          return 1;
        }
        let reviewGate = options.reviewGate;
        const bridgeUrl = args.bridgeUrl ?? process.env.DECISION_BRIDGE_URL;
        if (!reviewGate && bridgeUrl) {
          const token = args.bridgeToken ?? process.env.DECISION_BRIDGE_TOKEN;
          const client = new DecisionBridgeClient(bridgeUrl, ...(token ? [{ authToken: token }] : []));
          reviewGate = new DecisionReviewGate(client);
        }

        const result = await service.landPr(context, {
          optIn: true,
          prNumber: args.prNumber,
          expectedHeadSha: args.expectedHeadSha,
          deleteBranch: args.deleteBranch,
          reviewGate,
          sessionId: args.sessionId,
        });
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData(result), null, 2)}\n`);
        } else {
          stdout.write(
            sanitizeCredentials(
              `PR #${result.prNumber} successfully merged!\n` +
              `Merge commit: ${result.mergeCommitSha}\n` +
              `Merged at: ${result.mergedAt}\n`
            )
          );
        }
        return 0;
      }

      case "verify": {
        const result = await service.verifyMerged(context, { prNumber: args.prNumber });
        if (args.json) {
          stdout.write(`${JSON.stringify(sanitizeData(result), null, 2)}\n`);
        } else {
          stdout.write(
            sanitizeCredentials(
              `PR #${result.prNumber} merged: ${result.merged ? "YES" : "NO"}\n` +
              (result.mergeCommitSha ? `Commit SHA: ${result.mergeCommitSha}\n` : "") +
              (result.mergedAt ? `Merged at: ${result.mergedAt}\n` : "")
            )
          );
        }
        return result.merged ? 0 : 2;
      }

      default: {
        const errText = sanitizeCredentials(`symphony pr error: unrecognized action '${args.action}'`);
        if (args.json) {
          stderr.write(`${JSON.stringify(sanitizeData({ error: "unrecognized_action", message: errText }))}\n`);
        } else {
          stderr.write(`${errText}\n`);
        }
        return 1;
      }
    }
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    const cleanMessage = sanitizeCredentials(message);
    const code = err instanceof DeliveryError ? err.code : "delivery_error";
    if (args.json) {
      stderr.write(`${JSON.stringify(sanitizeData({ error: code, message: cleanMessage }))}\n`);
    } else {
      stderr.write(sanitizeCredentials(`symphony pr error [${code}]: ${cleanMessage}\n`));
    }
    return 1;
  }
}
