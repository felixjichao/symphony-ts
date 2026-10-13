import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializePlanCommentMarker, type PlanCommentMarker } from "@symphony/domain";
import { parseCliArgs } from "./args";
import { parsePlanningArgs, runPlanningCli, type PlanningCliIo } from "./planning-cli";

describe("planning-cli", () => {
  let tmpDir: string;
  let stdoutBuffer: string[];
  let stderrBuffer: string[];
  let io: PlanningCliIo;

  const sessionId = "github:felixjichao/symphony-ts#99";
  const repo = "felixjichao/symphony-ts";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "planning-cli-test-"));
    stdoutBuffer = [];
    stderrBuffer = [];
    io = {
      stdout: { write: (text) => stdoutBuffer.push(text) },
      stderr: { write: (text) => stderrBuffer.push(text) },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses CLI args correctly for plan and planning commands", () => {
    const res1 = parseCliArgs(["plan", "start", "--repo", "felixjichao/symphony-ts", "--issue", "99"]);
    expect(res1.subcommand).toBe("plan");
    expect(res1.subcommandArgs).toEqual(["start", "--repo", "felixjichao/symphony-ts", "--issue", "99"]);

    const res2 = parseCliArgs(["planning", "status", "--session-id", "github:repo#1"]);
    expect(res2.subcommand).toBe("plan");
    expect(res2.subcommandArgs).toEqual(["status", "--session-id", "github:repo#1"]);

    const res3 = parseCliArgs(["decision", "plan", "start"]);
    expect(res3.subcommand).toBe("plan");
    expect(res3.subcommandArgs).toEqual(["start"]);
  });

  it("parses planning flags", () => {
    const parsed = parsePlanningArgs([
      "start",
      "--repo", "felixjichao/symphony-ts",
      "--issue", "99",
      "--title", "Add planning",
      "--body", "Planning workflow",
      "--clarifications", "C1; C2",
      "--json",
    ]);

    expect(parsed.action).toBe("start");
    expect(parsed.repo).toBe("felixjichao/symphony-ts");
    expect(parsed.issueNumber).toBe(99);
    expect(parsed.title).toBe("Add planning");
    expect(parsed.body).toBe("Planning workflow");
    expect(parsed.clarifications).toEqual(["C1", "C2"]);
    expect(parsed.json).toBe(true);
  });

  it("executes plan start, status, clarify, and replan against a store", async () => {
    // 1. Start planning task
    const code1 = await runPlanningCli(
      [
        "start",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--title", "Test Title",
        "--body", "Test Body",
        "--store", tmpDir,
      ],
      io,
    );
    expect(code1).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Planning task");

    // 2. Status initially pending (ineligible)
    stdoutBuffer.length = 0;
    const code2 = await runPlanningCli(
      [
        "status",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--store", tmpDir,
      ],
      io,
    );
    // Exit code 2 indicates ineligible
    expect(code2).toBe(2);
    expect(stdoutBuffer.join("")).toContain("Verdict: pending");
    expect(stdoutBuffer.join("")).toContain("Eligible for dispatch: NO");

    // 3. Clarify adds new task
    stdoutBuffer.length = 0;
    const code3 = await runPlanningCli(
      [
        "clarify",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--clarifications", "Clarification item 1; Clarification item 2",
        "--store", tmpDir,
      ],
      io,
    );
    expect(code3).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Clarification task");

    // 4. Replan creates new requirements_changed task
    stdoutBuffer.length = 0;
    const code4 = await runPlanningCli(
      [
        "replan",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--title", "Updated Title",
        "--store", tmpDir,
      ],
      io,
    );
    expect(code4).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Replanning task");

    // Verify context was persisted
    const { DurableDecisionStore, DecisionService } = await import("@symphony/decision");
    const store = new DurableDecisionStore({ storeDir: tmpDir });
    await store.open();
    const service = new DecisionService(store);
    const session = service.getSession(sessionId);
    expect(session).not.toBeNull();
    const latestPlan = service.getLatestPlanForSession(session!.id);
    expect(latestPlan).not.toBeNull();
    const context = service.getTaskContext(latestPlan!.taskId);
    expect(context).not.toBeNull();
    expect(context?.strategy).toBe("materialized");
    if (context?.strategy === "materialized") {
      expect(context.issue.title).toBe("Updated Title");
      expect(context.issue.body).toContain("Clarification item 1");
    }
    await store.close();
  });

  it("publishes non-ready verdicts (needs_clarification, needs_human) to GitHub via sync --publish", async () => {
    // 1. Create a task with needs_clarification
    await runPlanningCli(
      [
        "start",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--title", "Clarification Needed Test",
        "--body", "Description",
        "--store", tmpDir,
      ],
      io,
    );

    const { DurableDecisionStore, DecisionService } = await import("@symphony/decision");
    const store = new DurableDecisionStore({ storeDir: tmpDir });
    await store.open();
    const service = new DecisionService(store);
    const session = service.getSession(sessionId)!;
    const latestPlan = service.getLatestPlanForSession(session.id)!;
    const claim = await service.claimTask(latestPlan.taskId, { owner: "planner", ttlMs: 60_000 });
    await service.startTask(latestPlan.taskId, {
      owner: "planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });
    await service.submitResult(latestPlan.taskId, {
      owner: "planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: latestPlan.taskId,
        sessionId: session.id,
        revision: 1,
        kind: "plan",
        verdict: "needs_clarification",
        content: {
          plan: "Preliminary analysis",
          acceptanceCriteria: [],
          risks: [],
          clarifications: ["What is the target format?"],
        },
        createdAtMs: Date.now(),
      },
    });
    await store.close();

    // 2. Publish needs_clarification to GitHub
    let postedBody = "";
    const publishIo: PlanningCliIo = {
      ...io,
      execGh: (args) => {
        if (args[0] === "api" && args[1]?.includes("/comments")) {
          // Check for existing comments (deduplication check) -> empty array
          return "[]";
        }
        if (args[0] === "issue" && args[1] === "comment") {
          const bodyIdx = args.indexOf("--body");
          postedBody = bodyIdx >= 0 ? (args[bodyIdx + 1] ?? "") : "";
          return "https://github.com/felixjichao/symphony-ts/issues/99#issuecomment-98765\n";
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
    };

    stdoutBuffer.length = 0;
    stderrBuffer.length = 0;
    const pubCode = await runPlanningCli(
      [
        "sync",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--publish",
        "--store", tmpDir,
      ],
      publishIo,
    );
    expect(pubCode).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Plan published to GitHub issue #99 (comment #98765, verdict: needs_clarification)");
    expect(postedBody).toContain("What is the target format?");
  });

  it("verifies the full marker and readable body against the durable record before accepting a published plan", async () => {
    // 1. Start and complete a ready plan.
    await runPlanningCli(
      [
        "start",
        "--repo", repo,
        "--issue", "99",
        "--title", "Ready Plan",
        "--body", "Do the thing",
        "--store", tmpDir,
      ],
      io,
    );

    const { DurableDecisionStore, DecisionService } = await import("@symphony/decision");
    const store = new DurableDecisionStore({ storeDir: tmpDir });
    await store.open();
    const service = new DecisionService(store);
    const session = service.getSession(sessionId)!;
    const plan = service.getLatestPlanForSession(session.id)!;
    const claim = await service.claimTask(plan.taskId, { owner: "planner", ttlMs: 60_000 });
    await service.startTask(plan.taskId, {
      owner: "planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
    });
    await service.submitResult(plan.taskId, {
      owner: "planner",
      token: claim.lease.token,
      generation: claim.lease.generation,
      result: {
        schemaVersion: 1,
        taskId: plan.taskId,
        sessionId: session.id,
        revision: plan.revision,
        kind: "plan",
        verdict: "ready",
        content: {
          plan: "Implement the feature",
          acceptanceCriteria: ["Tests pass"],
          risks: ["Concurrency"],
          clarifications: [],
        },
        createdAtMs: Date.now(),
      },
    });
    const ready = service.getLatestPlanForSession(session.id)!;
    await store.close();

    // 2. Publish to GitHub and capture the exact rendered comment body.
    let postedBody = "";
    const publishIo: PlanningCliIo = {
      ...io,
      execGh: (args) => {
        if (args[0] === "api" && args[1]?.includes("/comments")) return "[]";
        if (args[0] === "issue" && args[1] === "comment") {
          const bodyIdx = args.indexOf("--body");
          postedBody = bodyIdx >= 0 ? (args[bodyIdx + 1] ?? "") : "";
          return "https://github.com/felixjichao/symphony-ts/issues/99#issuecomment-77777\n";
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
    };
    const pubCode = await runPlanningCli(
      ["sync", "--repo", repo, "--issue", "99", "--publish", "--store", tmpDir],
      publishIo,
    );
    expect(pubCode).toBe(0);
    expect(postedBody).toContain("Implement the feature");
    expect(postedBody).toContain("<!-- symphony-plan-marker:");

    const commentIo = (body: string): PlanningCliIo => ({
      ...io,
      execGh: (args) => {
        if (args[0] === "api" && args[1]?.includes("issues/comments/77777")) {
          return JSON.stringify({
            id: 77777,
            issue_url: `https://api.github.com/repos/${repo}/issues/99`,
            body,
            created_at: "2026-10-11T04:00:00Z",
          });
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      },
    });

    // 2a. The genuine published comment is accepted.
    stdoutBuffer.length = 0;
    stderrBuffer.length = 0;
    const okCode = await runPlanningCli(
      ["sync", "--repo", repo, "--issue", "99", "--comment-id", "77777", "--store", tmpDir],
      commentIo(postedBody),
    );
    expect(okCode).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Marked plan");

    // 2b. An unreadable GitHub comment blocks.
    const failingIo: PlanningCliIo = {
      ...io,
      execGh: () => {
        throw new Error("HTTP 404: Not Found");
      },
    };
    stderrBuffer.length = 0;
    const failCode = await runPlanningCli(
      ["sync", "--repo", repo, "--issue", "99", "--comment-id", "does-not-exist", "--store", tmpDir],
      failingIo,
    );
    expect(failCode).toBe(1);
    expect(stderrBuffer.join("")).toContain("failed to verify GitHub comment");

    // 3. Inconsistent comments must be rejected: revision, fingerprint, verdict, and body.
    const markerBase: PlanCommentMarker = {
      schemaVersion: 1,
      repo,
      issueNumber: 99,
      sessionId: ready.sessionId,
      taskId: ready.taskId,
      revision: ready.revision,
      triggerKind: ready.triggerKind,
      fingerprint: ready.requirements.fingerprint,
      verdict: "ready",
    };
    const build = (overrides: Partial<PlanCommentMarker>, readable = "Just a status note without a plan."): string =>
      `${readable}\n\n${serializePlanCommentMarker({ ...markerBase, ...overrides })}`;

    const negatives: ReadonlyArray<readonly [string, string]> = [
      ["revision mismatch", build({ revision: ready.revision + 999 })],
      ["fingerprint mismatch", build({ fingerprint: "0000deadbeef" })],
      ["verdict mismatch", build({ verdict: "needs_human" })],
      ["body does not render the durable plan", build({}, "Just a status note without a plan.")],
    ];

    for (const [label, body] of negatives) {
      stderrBuffer.length = 0;
      const code = await runPlanningCli(
        ["sync", "--repo", repo, "--issue", "99", "--comment-id", "77777", "--store", tmpDir],
        commentIo(body),
      );
      expect(code, label).toBe(1);
      expect(stderrBuffer.join(""), label).toContain("not a valid published record of the current plan");
    }
  });

  it("outputs help text when requested", async () => {
    const code = await runPlanningCli(["help"], io);
    expect(code).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Usage: symphony plan");
  });
});
