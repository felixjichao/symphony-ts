import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  decisionSessionId,
  formatPlanCommentMarkdown,
  type PlanCommentMarker,
} from "@symphony/domain";
import {
  DecisionBridgeClient,
  DecisionPlanningGate,
  DecisionService,
  DurableDecisionStore,
} from "@symphony/decision";

export interface PlanningCliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
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

  // Create planning gate
  let store: DurableDecisionStore | null = null;
  let gate: DecisionPlanningGate;

  const bridgeUrl = args.bridgeUrl ?? process.env.DECISION_BRIDGE_URL;
  if (bridgeUrl) {
    const token = args.bridgeToken ?? process.env.DECISION_BRIDGE_TOKEN;
    const client = new DecisionBridgeClient(bridgeUrl, { ...(token ? { authToken: token } : {}) });
    gate = new DecisionPlanningGate(client);
  } else {
    const storeDir = args.storeDir ?? process.env.DECISION_STORE_DIR ?? path.join(process.cwd(), ".symphony", "decision");
    if (!fs.existsSync(storeDir)) {
      fs.mkdirSync(storeDir, { recursive: true });
    }
    store = new DurableDecisionStore({ storeDir });
    await store.open();
    const service = new DecisionService(store);
    gate = new DecisionPlanningGate(service);
  }

  try {
    switch (args.action) {
      case "start": {
        const title = args.title ?? "Issue Requirements";
        const body = args.body ?? "";
        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "initial",
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

        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "clarification",
          previousTaskId,
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

        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "requirements_changed",
          previousTaskId,
          requirements: {
            title,
            body,
            clarifications: args.clarifications ?? latestPlan?.requirements.clarifications,
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
        const task = await gate.ensurePlanTask(sessionId, {
          triggerKind: "retry",
          previousTaskId: latestPlan.taskId,
          requirements: {
            title: latestPlan.requirements.title,
            body: latestPlan.requirements.body,
            clarifications: latestPlan.requirements.clarifications,
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
          const updated = await gate.markPlanPublished(latestPlan.taskId, {
            commentId: args.commentId,
          });
          if (args.json) {
            io.stdout.write(JSON.stringify({ status: "synced", plan: updated }, null, 2) + "\n");
          } else {
            io.stdout.write(`Marked plan "${latestPlan.taskId}" published with comment ID ${args.commentId}\n`);
          }
          return 0;
        }

        if (args.publish) {
          if (!latestPlan.result || latestPlan.result.verdict !== "ready") {
            io.stderr.write(`symphony plan: error: plan is not ready (verdict: ${latestPlan.result?.verdict ?? "unknown"})\n`);
            return 1;
          }
          if (!args.repo || !args.issueNumber) {
            io.stderr.write("symphony plan: error: --repo and --issue required to publish comment via gh\n");
            return 1;
          }

          const marker: PlanCommentMarker = {
            schemaVersion: 1,
            repo: args.repo,
            issueNumber: args.issueNumber,
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

          // Post comment using gh CLI
          try {
            const out = execFileSync("gh", [
              "issue",
              "comment",
              String(args.issueNumber),
              "--repo",
              args.repo,
              "--body",
              markdown,
            ], { encoding: "utf8" });

            // gh output contains comment url: https://github.com/owner/repo/issues/99#issuecomment-123456
            const commentMatch = /#issuecomment-(\d+)/.exec(out);
            const publishedCommentId = commentMatch ? Number(commentMatch[1]) : Date.now();

            const updated = await gate.markPlanPublished(latestPlan.taskId, {
              commentId: publishedCommentId,
            });

            if (args.json) {
              io.stdout.write(JSON.stringify({ status: "published", commentId: publishedCommentId, plan: updated }, null, 2) + "\n");
            } else {
              io.stdout.write(`Plan published to GitHub issue #${args.issueNumber} (comment #${publishedCommentId})\n`);
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
