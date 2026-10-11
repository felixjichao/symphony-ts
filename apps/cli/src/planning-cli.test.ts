import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";
import { parsePlanningArgs, runPlanningCli, type PlanningCliIo } from "./planning-cli";

describe("planning-cli", () => {
  let tmpDir: string;
  let stdoutBuffer: string[];
  let stderrBuffer: string[];
  let io: PlanningCliIo;

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

  it("executes plan start, status, clarify, replan, and sync against a store", async () => {
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

    // 5. Sync comment-id marks published
    stdoutBuffer.length = 0;
    const code5 = await runPlanningCli(
      [
        "sync",
        "--repo", "felixjichao/symphony-ts",
        "--issue", "99",
        "--comment-id", "12345",
        "--store", tmpDir,
      ],
      io,
    );
    expect(code5).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Marked plan");
  });

  it("outputs help text when requested", async () => {
    const code = await runPlanningCli(["help"], io);
    expect(code).toBe(0);
    expect(stdoutBuffer.join("")).toContain("Usage: symphony plan");
  });
});
