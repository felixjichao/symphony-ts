import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  decisionSessionId,
  formatPlanCommentMarkdown,
  parsePlanCommentMarker,
  parseDecisionSessionRootFromId,
  type PlanCommentMarker,
  type DecisionMaterializedContext,
  type DecisionMaterializedPlan,
} from "@symphony/domain";
import {
  DecisionBridgeClient,
  DecisionPlanningGate,
  DecisionService,
  DurableDecisionStore,
  type DecisionPlanRecord,
} from "@symphony/decision";

function buildPlanningContext(params: {
  sessionId: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  clarifications?: readonly string[] | undefined;
  previousPlan?: DecisionPlanRecord | null | undefined;
}): DecisionMaterializedContext {
  const root = parseDecisionSessionRootFromId(params.sessionId);
  let enrichedBody = params.body;
  if (params.clarifications && params.clarifications.length > 0) {
    enrichedBody += "\n\n### Clarifications\n" + params.clarifications.map((c) => `- ${c}`).join("\n");
  }

  let priorMaterializedPlan: DecisionMaterializedPlan | null = null;
  if (params.previousPlan?.result && params.previousPlan.result.verdict === "ready") {
    priorMaterializedPlan = {
      taskId: params.previousPlan.taskId,
      revision: params.previousPlan.revision,
      plan: params.previousPlan.result.content.plan,
      acceptanceCriteria: params.previousPlan.result.content.acceptanceCriteria,
      risks: params.previousPlan.result.content.risks,
      clarifications: params.previousPlan.requirements.clarifications ?? [],
    };
  }

  return {
    strategy: "materialized",
    workItem: root,
    repository: params.repo,
    issue: {
      repository: params.repo,
      number: params.issueNumber,
      title: params.title,
      body: enrichedBody,
    },
    plan: priorMaterializedPlan,
    pullRequest: null,
    diff: null,
    ci: null,
    repositoryInstructions: null,
    previousReviews: [],
    unresolvedFindings: [],
  };
}

/**
 * Full validation of a published plan comment against the durable plan record.
 *
 * Reading a comment that merely contains a marker is not proof that the current
 * structured result is durably visible: the marker could carry a different
 * revision, fingerprint, verdict, or a body that does not render the durable
 * result. Fail closed unless every marker field and the readable body agree with
 * the durable record.
 */
export function validatePlanCommentAgainstRecord(params: {
  readonly body: string;
  readonly repo: string | undefined;
  readonly issueNumber: number | undefined;
  readonly sessionId: string;
  readonly plan: DecisionPlanRecord;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const { body, repo, issueNumber, sessionId, plan } = params;
  const marker = parsePlanCommentMarker(body);
  if (!marker) {
    return { ok: false, reason: "does not contain a valid Symphony plan marker" };
  }
  if (!repo || marker.repo.toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, reason: `marker repository mismatch (marker: "${marker.repo}", expected: "${repo ?? ""}")` };
  }
  if (issueNumber === undefined || marker.issueNumber !== issueNumber) {
    return { ok: false, reason: `marker issue mismatch (marker: #${marker.issueNumber}, expected: #${issueNumber ?? "?"})` };
  }
  if (marker.sessionId !== sessionId) {
    return { ok: false, reason: `marker session mismatch (marker: "${marker.sessionId}", expected: "${sessionId}")` };
  }
  if (marker.taskId !== plan.taskId) {
    return { ok: false, reason: `comment marker task mismatch (marker task: "${marker.taskId}", expected: "${plan.taskId}")` };
  }
  if (marker.revision !== plan.revision) {
    return { ok: false, reason: `marker revision mismatch (marker: ${marker.revision}, expected: ${plan.revision})` };
  }
  if (marker.triggerKind !== plan.triggerKind) {
    return { ok: false, reason: `marker trigger mismatch (marker: "${marker.triggerKind}", expected: "${plan.triggerKind}")` };
  }
  if (marker.fingerprint !== plan.requirements.fingerprint) {
    return { ok: false, reason: "marker fingerprint does not match the durable plan requirements" };
  }
  if (!plan.result || plan.result.kind !== "plan") {
    return { ok: false, reason: "durable plan record has no structured plan result" };
  }
  if (marker.verdict !== plan.result.verdict) {
    return { ok: false, reason: `marker verdict mismatch (marker: "${marker.verdict}", expected: "${plan.result.verdict}")` };
  }
  const expectedBody = formatPlanCommentMarkdown({ marker, planResult: plan.result });
  if (normalizeCommentBody(body) !== normalizeCommentBody(expectedBody)) {
    return { ok: false, reason: "comment body does not match the durable structured plan result" };
  }
  return { ok: true };
}

function normalizeCommentBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

export interface PlanningCliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly execGh?: ((args: readonly string[]) => string) | undefined;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
}

export interface ParsedPlanningArgs {
  readonly action: "start" | "clarify" | "replan" | "retry" | "status" | "sync" | "help";
  readonly repo?: string | undefined;
  readonly issueNumber?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly clarifications?: readonly string[] | undefined;
  readonly storeDir?: string | undefined;
  readonly bridgeUrl?: string | undefined;
  readonly bridgeToken?: string | undefined;
  readonly commentId?: string | number | undefined;
  readonly publish?: boolean | undefined;
  readonly json?: boolean | undefined;
}

export function parsePlanningArgs(argv: readonly string[]): ParsedPlanningArgs {
  let action: ParsedPlanningArgs["action"] = "status";
  let i = 0;
  if (argv.length > 0 && !argv[0]?.startsWith("-")) {
    const rawAction = argv[0];
    if (
      rawAction === "start" ||
      rawAction === "clarify" ||
      rawAction === "replan" ||
      rawAction === "retry" ||
      rawAction === "status" ||
      rawAction === "sync" ||
      rawAction === "help"
    ) {
      action = rawAction;
      i = 1;
    }
  }

  let repo: string | undefined;
  let issueNumber: number | undefined;
  let sessionId: string | undefined;
  let title: string | undefined;
  let body: string | undefined;
  let clarifications: string[] | undefined;
  let storeDir: string | undefined;
  let bridgeUrl: string | undefined;
  let bridgeToken: string | undefined;
  let commentId: string | number | undefined;
  let publish = false;
  let json = false;

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg === "--issue" && i + 1 < argv.length) {
      issueNumber = Number(argv[++i]);
    } else if (arg === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (arg === "--title" && i + 1 < argv.length) {
      title = argv[++i];
    } else if (arg === "--body" && i + 1 < argv.length) {
      body = argv[++i];
    } else if (arg === "--clarifications" && i + 1 < argv.length) {
      clarifications = argv[++i]!.split(";").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--store" && i + 1 < argv.length) {
      storeDir = argv[++i];
    } else if (arg === "--bridge-url" && i + 1 < argv.length) {
      bridgeUrl = argv[++i];
    } else if (arg === "--bridge-token" && i + 1 < argv.length) {
      bridgeToken = argv[++i];
    } else if (arg === "--comment-id" && i + 1 < argv.length) {
      const val = argv[++i]!;
      commentId = Number.isNaN(Number(val)) ? val : Number(val);
    } else if (arg === "--publish") {
      publish = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      action = "help";
    }
  }

  return {
    action,
    repo,
    issueNumber,
    sessionId,
    title,
    body,
    clarifications,
    storeDir,
    bridgeUrl,
    bridgeToken,
    commentId,
    publish,
    json,
  };
}

export async function runPlanningCli(argv: readonly string[], io: PlanningCliIo): Promise<number> {
  const args = parsePlanningArgs(argv);

  if (args.action === "help") {
    io.stdout.write(
      "Usage: symphony plan <action> [options]\n\n" +
      "Actions:\n" +
      "  start       Initiate a planning session for an issue\n" +
      "  clarify     Submit answers/clarifications to address pending planning questions\n" +
      "  replan      Re-run planning after requirement changes\n" +
      "  retry       Retry a failed planning task\n" +
      "  status      Check current plan and dispatch eligibility\n" +
      "  sync        Publish plan to GitHub or mark published by comment ID\n\n" +
      "Options:\n" +
      "  --repo <owner/repo>      GitHub repository\n" +
      "  --issue <number>         Issue number\n" +
      "  --session-id <id>        Decision session ID (default: github:<repo>#<issue>)\n" +
      "  --title <title>          Issue title / requirement title\n" +
      "  --body <body>            Issue description / requirements body\n" +
      "  --clarifications <items> Semicolon-separated clarification notes\n" +
      "  --store <dir>            Local store directory\n" +
      "  --bridge-url <url>       Decision Bridge URL (or DECISION_BRIDGE_URL)\n" +
      "  --bridge-token <token>   Decision Bridge Auth Token\n" +
      "  --comment-id <id>        Published GitHub issue comment ID\n" +
      "  --publish                Format and post plan comment directly to GitHub\n" +
      "  --json                   Output in JSON format\n"
    );
    return 0;
  }

  // Resolve session ID
  let sessionId = args.sessionId;
  if (!sessionId) {
    if (args.repo && args.issueNumber) {
      sessionId = decisionSessionId({
        provider: "github",
        key: `${args.repo.toLowerCase()}#${args.issueNumber}`,
      });
    } else {
      io.stderr.write("symphony plan: error: either --session-id or both --repo and --issue must be provided\n");
      return 1;
    }
  }

  // Conflict check: --store and --bridge-url cannot both be specified
  if (args.storeDir !== undefined && args.bridgeUrl !== undefined) {
    io.stderr.write("symphony plan: error: conflicting backend options: cannot specify both --store and --bridge-url\n");
    return 1;
  }

  const env = io.env ?? process.env;

  // Create planning gate
  let store: DurableDecisionStore | null = null;
  let gate: DecisionPlanningGate;

  if (args.storeDir !== undefined) {
    const storeDir = args.storeDir;
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }
    store = new DurableDecisionStore({ storeDir });
    await store.open();
    const service = new DecisionService(store);
    gate = new DecisionPlanningGate(service);
  } else if (args.bridgeUrl !== undefined) {
    const bridgeUrl = args.bridgeUrl;
    const token = args.bridgeToken ?? env.DECISION_BRIDGE_TOKEN;
    const client = new DecisionBridgeClient(bridgeUrl, { ...(token ? { authToken: token } : {}) });
    gate = new DecisionPlanningGate(client);
  } else if (env.DECISION_BRIDGE_URL) {
    const bridgeUrl = env.DECISION_BRIDGE_URL;
    const token = args.bridgeToken ?? env.DECISION_BRIDGE_TOKEN;
    const client = new DecisionBridgeClient(bridgeUrl, { ...(token ? { authToken: token } : {}) });
    gate = new DecisionPlanningGate(client);
  } else {
    const storeDir = env.DECISION_STORE_DIR ?? path.join(process.cwd(), ".symphony", "decision");
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }
    store = new DurableDecisionStore({ storeDir });
    await store.open();
    const service = new DecisionService(store);
    gate = new DecisionPlanningGate(service);
  }

  const root = parseDecisionSessionRootFromId(sessionId);
  const match = /^(.*)#([1-9][0-9]*)$/.exec(root.key);
  const repo = args.repo ?? (match ? match[1]! : (root.key.includes("/") ? root.key.split("#")[0]! : "symphony/repo"));
  const issueNumber = args.issueNumber ?? (match ? Number(match[2]) : 1);
  const runGh = (cmdArgs: readonly string[]): string =>
    io.execGh ? io.execGh(cmdArgs) : execFileSync("gh", cmdArgs as string[], { encoding: "utf8" });

  try {
    switch (args.action) {
      case "start": {
        const title = args.title ?? "Issue Requirements";
        const body = args.body ?? "";
        const context = buildPlanningContext({
          sessionId,
          repo,
          issueNumber,
          title,
          body,
          clarifications: args.clarifications,
        });
        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "initial",
          context,
          requirements: {
            title,
            body,
            clarifications: args.clarifications,
          },
        });
        if (args.json) {
          io.stdout.write(JSON.stringify({ status: "created", task }, null, 2) + "\n");
        } else {
          io.stdout.write(`Planning task "${task.id}" created (revision: ${task.revision}, status: ${task.status})\n`);
        }
        return 0;
      }

      case "clarify": {
        const latestPlan = await gate.getLatestPlan(sessionId);
        const title = args.title ?? latestPlan?.requirements.title ?? "Issue Requirements";
        const body = args.body ?? latestPlan?.requirements.body ?? "";
        const previousTaskId = latestPlan?.taskId ?? null;

        const mergedClarifications = [
          ...(latestPlan?.requirements.clarifications ?? []),
          ...(args.clarifications ?? []),
        ];

        const context = buildPlanningContext({
          sessionId,
          repo,
          issueNumber,
          title,
          body,
          clarifications: mergedClarifications,
          previousPlan: latestPlan,
        });

        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "clarification",
          previousTaskId,
          context,
          requirements: {
            title,
            body,
            clarifications: mergedClarifications,
          },
        });
        if (args.json) {
          io.stdout.write(JSON.stringify({ status: "clarified", task }, null, 2) + "\n");
        } else {
          io.stdout.write(`Clarification task "${task.id}" created (revision: ${task.revision}, status: ${task.status})\n`);
        }
        return 0;
      }

      case "replan": {
        const latestPlan = await gate.getLatestPlan(sessionId);
        const title = args.title ?? latestPlan?.requirements.title ?? "Issue Requirements";
        const body = args.body ?? latestPlan?.requirements.body ?? "";
        const previousTaskId = latestPlan?.taskId ?? null;
        const clarifications = args.clarifications ?? latestPlan?.requirements.clarifications;

        const context = buildPlanningContext({
          sessionId,
          repo,
          issueNumber,
          title,
          body,
          clarifications,
          previousPlan: latestPlan,
        });

        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "requirements_changed",
          previousTaskId,
          context,
          requirements: {
            title,
            body,
            clarifications,
          },
        });
        if (args.json) {
          io.stdout.write(JSON.stringify({ status: "replanned", task }, null, 2) + "\n");
        } else {
          io.stdout.write(`Replanning task "${task.id}" created (revision: ${task.revision}, status: ${task.status})\n`);
        }
        return 0;
      }

      case "retry": {
        const latestPlan = await gate.getLatestPlan(sessionId);
        if (!latestPlan) {
          io.stderr.write(`symphony plan: error: no existing plan found to retry for session "${sessionId}"\n`);
          return 1;
        }
        const title = latestPlan.requirements.title;
        const body = latestPlan.requirements.body;
        const clarifications = latestPlan.requirements.clarifications;

        const context = buildPlanningContext({
          sessionId,
          repo,
          issueNumber,
          title,
          body,
          clarifications,
          previousPlan: latestPlan,
        });

        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "retry",
          previousTaskId: latestPlan.taskId,
          context,
          requirements: {
            title,
            body,
            clarifications,
          },
        });
        if (args.json) {
          io.stdout.write(JSON.stringify({ status: "retried", task }, null, 2) + "\n");
        } else {
          io.stdout.write(`Retry planning task "${task.id}" created (revision: ${task.revision}, status: ${task.status})\n`);
        }
        return 0;
      }

      case "status": {
        const latestPlan = await gate.getLatestPlan(sessionId);
        const requirements = (args.title || args.body)
          ? {
              title: args.title ?? latestPlan?.requirements.title ?? "",
              body: args.body ?? latestPlan?.requirements.body ?? "",
              clarifications: args.clarifications ?? latestPlan?.requirements.clarifications,
            }
          : undefined;

        const eligibility = await gate.verifyPlanEligibility(sessionId, requirements);

        if (args.json) {
          io.stdout.write(JSON.stringify({ sessionId, latestPlan, eligibility }, null, 2) + "\n");
        } else {
          io.stdout.write(`Session ID: ${sessionId}\n`);
          if (!latestPlan) {
            io.stdout.write("Status: No plan created yet\n");
            io.stdout.write("Eligible for dispatch: false (no_plan)\n");
            return 0;
          }
          io.stdout.write(`Task ID: ${latestPlan.taskId} (Revision ${latestPlan.revision})\n`);
          io.stdout.write(`Task Status: ${latestPlan.status}\n`);
          io.stdout.write(`Verdict: ${latestPlan.result?.verdict ?? "pending"}\n`);
          io.stdout.write(`Published to GitHub: ${latestPlan.publishedCommentId !== null ? `Yes (Comment #${latestPlan.publishedCommentId})` : "No"}\n`);
          io.stdout.write(`Eligible for dispatch: ${eligibility.eligible ? "YES" : `NO (${eligibility.reason})`}\n`);
        }
        return eligibility.eligible ? 0 : 2;
      }

      case "sync": {
        const latestPlan = await gate.getLatestPlan(sessionId);
        if (!latestPlan) {
          io.stderr.write(`symphony plan: error: no plan found for session "${sessionId}"\n`);
          return 1;
        }

        if (args.commentId !== undefined) {
          if (!repo || !issueNumber) {
            io.stderr.write("symphony plan: error: repository and issue number required to verify comment on GitHub\n");
            return 1;
          }

          let commentJson: Record<string, unknown>;
          try {
            const ghOut = runGh([
              "api",
              `repos/${repo}/issues/comments/${args.commentId}`,
            ]);
            commentJson = JSON.parse(ghOut);
          } catch (err) {
            io.stderr.write(`symphony plan: error: failed to verify GitHub comment ${args.commentId} on ${repo}: ${String(err)}\n`);
            return 1;
          }

          const issueUrl = String(commentJson["issue_url"] ?? "");
          if (!issueUrl.endsWith(`/issues/${issueNumber}`)) {
            io.stderr.write(`symphony plan: error: comment ${args.commentId} does not belong to issue #${issueNumber} (${issueUrl})\n`);
            return 1;
          }

          const body = String(commentJson["body"] ?? "");
          const validation = validatePlanCommentAgainstRecord({
            body,
            repo,
            issueNumber,
            sessionId,
            plan: latestPlan,
          });
          if (!validation.ok) {
            io.stderr.write(`symphony plan: error: comment ${args.commentId} is not a valid published record of the current plan: ${validation.reason}\n`);
            return 1;
          }

          const verifiedCommentId = Number(commentJson["id"]) || args.commentId;
          const publishedAtMs = commentJson["created_at"] ? new Date(String(commentJson["created_at"])).getTime() : undefined;

          const updated = await gate.markPlanPublished(latestPlan.taskId, {
            commentId: verifiedCommentId,
            ...(publishedAtMs ? { publishedAtMs } : {}),
          });

          if (args.json) {
            io.stdout.write(JSON.stringify({ status: "synced", plan: updated }, null, 2) + "\n");
          } else {
            io.stdout.write(`Marked plan "${latestPlan.taskId}" published with verified comment ID ${verifiedCommentId}\n`);
          }
          return 0;
        }

        if (args.publish) {
          if (!latestPlan.result) {
            io.stderr.write(`symphony plan: error: plan task "${latestPlan.taskId}" has no completed result\n`);
            return 1;
          }

          if (!repo || !issueNumber) {
            io.stderr.write("symphony plan: error: --repo and --issue required to publish comment via gh\n");
            return 1;
          }

          // Check for existing matching comment first (crash recovery idempotency).
          // A comment that carries our session/task marker must fully match the
          // durable record; an inconsistent marker is rejected rather than accepted
          // or silently duplicated.
          let existingCommentId: number | null = null;
          let inconsistentReason: string | null = null;
          try {
            const commentsOut = runGh([
              "api",
              `repos/${repo}/issues/${issueNumber}/comments`,
              "--paginate",
            ]);
            const comments = JSON.parse(commentsOut);
            if (Array.isArray(comments)) {
              for (const c of comments) {
                if (typeof c["body"] !== "string") continue;
                const m = parsePlanCommentMarker(c["body"]);
                if (!m || m.sessionId !== sessionId || m.taskId !== latestPlan.taskId) continue;
                const validation = validatePlanCommentAgainstRecord({
                  body: c["body"],
                  repo,
                  issueNumber,
                  sessionId,
                  plan: latestPlan,
                });
                if (validation.ok) {
                  existingCommentId = Number(c["id"]);
                  break;
                }
                inconsistentReason = validation.reason;
                break;
              }
            }
          } catch {
            // best-effort; absence of a readable comment set means we must publish
          }

          if (inconsistentReason !== null) {
            io.stderr.write(`symphony plan: error: existing comment for plan "${latestPlan.taskId}" is inconsistent with the durable record: ${inconsistentReason}\n`);
            return 1;
          }

          if (existingCommentId !== null) {
            const updated = await gate.markPlanPublished(latestPlan.taskId, {
              commentId: existingCommentId,
            });
            if (args.json) {
              io.stdout.write(JSON.stringify({ status: "recovered", commentId: existingCommentId, plan: updated }, null, 2) + "\n");
            } else {
              io.stdout.write(`Plan comment already exists on GitHub issue #${issueNumber} (comment #${existingCommentId}), synced successfully\n`);
            }
            return 0;
          }

          const marker: PlanCommentMarker = {
            schemaVersion: 1,
            repo,
            issueNumber,
            sessionId,
            taskId: latestPlan.taskId,
            revision: latestPlan.revision,
            triggerKind: latestPlan.triggerKind,
            fingerprint: latestPlan.requirements.fingerprint,
            verdict: latestPlan.result.verdict,
          };

          const markdown = formatPlanCommentMarkdown({
            marker,
            planResult: latestPlan.result,
          });

          try {
            const out = runGh([
              "issue",
              "comment",
              String(issueNumber),
              "--repo",
              repo,
              "--body",
              markdown,
            ]);

            const commentMatch = /#issuecomment-(\d+)/.exec(out);
            let publishedCommentId = commentMatch ? Number(commentMatch[1]) : null;

            if (!publishedCommentId) {
              // Locate the newly posted comment by marker
              try {
                const commentsOut = runGh([
                  "api",
                  `repos/${repo}/issues/${issueNumber}/comments`,
                  "--paginate",
                ]);
                const comments = JSON.parse(commentsOut);
                if (Array.isArray(comments)) {
                  for (let idx = comments.length - 1; idx >= 0; idx--) {
                    const c = comments[idx];
                    if (typeof c["body"] === "string") {
                      if (
                        validatePlanCommentAgainstRecord({
                          body: c["body"],
                          repo,
                          issueNumber,
                          sessionId,
                          plan: latestPlan,
                        }).ok
                      ) {
                        publishedCommentId = Number(c["id"]);
                        break;
                      }
                    }
                  }
                }
              } catch {
                // ignore
              }
            }

            if (!publishedCommentId) {
              io.stderr.write("symphony plan: error: failed to determine published GitHub comment ID\n");
              return 1;
            }

            const updated = await gate.markPlanPublished(latestPlan.taskId, {
              commentId: publishedCommentId,
            });

            if (args.json) {
              io.stdout.write(JSON.stringify({ status: "published", commentId: publishedCommentId, plan: updated }, null, 2) + "\n");
            } else {
              io.stdout.write(`Plan published to GitHub issue #${issueNumber} (comment #${publishedCommentId}, verdict: ${latestPlan.result.verdict})\n`);
            }
            return 0;
          } catch (err) {
            io.stderr.write(`symphony plan: error: failed to publish comment via gh: ${String(err)}\n`);
            return 1;
          }
        }

        io.stderr.write("symphony plan: error: sync requires either --comment-id or --publish\n");
        return 1;
      }
    }

    return 0;
  } finally {
    if (store) {
      await store.close();
    }
  }
}
