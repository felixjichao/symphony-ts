import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPrBody, type PersistedDeliveryState } from "@symphony/domain";
import { fetchCiFailureDiagnostics, parseGitHubRepoFromRemote, runDeliverySkill } from "./delivery-skill-runner";
import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

const context = { repo: "owner/repo", issueNumber: 80, workspaceKey: "GH-80", headBranch: "symphony/GH-80", baseBranch: "main" };
const ok = (value: unknown): DeliverySubprocessResult => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
const fail = (stderr: string): DeliverySubprocessResult => ({ stdout: "", stderr, exitCode: 1 });
const check = { name: "test-job", state: "COMPLETED" as const, conclusion: "FAILURE" as const, isRequired: false, detailsUrl: "https://github.com/owner/repo/actions/runs/2/job/3" };

function fixture(checks: unknown[] = [{ name: "optional", status: "COMPLETED", conclusion: "SUCCESS" }]) {
  const calls: string[][] = [];
  let api = (args: readonly string[]) => args[1]?.includes("rules/branches") ? ok([]) : ok({ contexts: [], checks: [] });
  let diagnostics = (args: readonly string[]) => args[1] === "list"
    ? ok([{ databaseId: 1, conclusion: "FAILURE", name: "unrelated" }, { databaseId: 2, conclusion: "FAILURE", name: "CI" }])
    : { stdout: "test-job assertion failed", stderr: "", exitCode: 0 };
  const runner: DeliveryGitGhRunner = {
    async git(args) {
      calls.push([...args]);
      return { stdout: args[0] === "branch" ? context.headBranch : args[0] === "remote" ? "https://github.com/owner/repo.git" : args[0] === "rev-parse" ? "sha" : "", stderr: "", exitCode: 0 };
    },
    async exec() { return ok({}); },
    async gh(args) {
      calls.push([...args]);
      if (args[0] === "api") return api(args);
      if (args[0] === "run") return diagnostics(args);
      if (args[0] === "issue") return ok({ state: "OPEN", labels: [] });
      if (args[1] === "list") return ok([{ number: 86, url: "https://github.com/owner/repo/pull/86", state: "OPEN", headRefOid: "sha", body: formatPrBody({ body: "test", context }) }]);
      if (args[1] === "view") return ok({ state: "OPEN", headRefOid: "sha", mergeable: "MERGEABLE", statusCheckRollup: checks });
      return ok({});
    },
  };
  return { runner, calls, setApi: (fn: typeof api) => { api = fn; }, setDiagnostics: (fn: typeof diagnostics) => { diagnostics = fn; } };
}

const options = { ...context, cwd: "/fixture", optInLand: false, maxWaitSeconds: 5, pollIntervalSeconds: 1 };

describe("third-review delivery regressions", () => {
  it.each(
    [false, true].flatMap((tracked) => [false, true].flatMap((staged) => [false, true].map((repair) => ({ tracked, staged, repair })))),
  )("commits source without runtime state: %j", async ({ tracked, staged, repair }) => {
    const cwd = mkdtempSync(join(tmpdir(), "delivery-state-commit-"));
    const git = (args: readonly string[], commandCwd = cwd) => execFileSync("git", [...args], { cwd: commandCwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git(["init", "-b", context.headBranch]);
      git(["config", "user.name", "Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      writeFileSync(join(cwd, "source.txt"), "before\n");
      mkdirSync(join(cwd, ".symphony"));
      if (tracked) writeFileSync(join(cwd, ".symphony/delivery-state.json"), "old tracked state\n");
      git(["add", "."]);
      git(["commit", "-m", "seed"]);
      writeFileSync(join(cwd, "source.txt"), "after\n");
      const statePath = join(cwd, ".symphony/delivery-state.json");
      let stagedState = "pre-staged runtime state\n";
      if (staged) {
        writeFileSync(statePath, stagedState);
        git(["add", ".symphony/delivery-state.json"]);
      }
      let repaired = false;
      const nested = join(cwd, "nested");
      mkdirSync(nested);
      const f = fixture([{ name: check.name, detailsUrl: check.detailsUrl, status: "COMPLETED", conclusion: "FAILURE" }]);
      const runner: DeliveryGitGhRunner = {
        ...f.runner,
        async git(args, commandCwd) {
          if (args[0] === "remote") return { stdout: "https://github.com/owner/repo.git", stderr: "", exitCode: 0 };
          if (args[0] === "push") return repair && !repaired ? ok({}) : fail("Stop before network access");
          return { stdout: git(args, commandCwd), stderr: "", exitCode: 0 };
        },
        async gh(args, commandCwd) {
          const response = await f.runner.gh(args, commandCwd);
          if (args[0] === "pr" && ["view", "list"].includes(args[1] ?? "")) {
            const data = JSON.parse(response.stdout);
            const head = git(["rev-parse", "HEAD"]).trim();
            if (Array.isArray(data)) for (const pr of data) pr.headRefOid = head;
            else data.headRefOid = head;
            return ok(data);
          }
          return response;
        },
      };
      const result = await runDeliverySkill({ ...options, cwd: nested, runner, repairFn: () => {
        repaired = true;
        writeFileSync(join(cwd, "source.txt"), "repaired\n");
        if (staged) {
          stagedState = readFileSync(statePath, "utf8");
          git(["add", ".symphony/delivery-state.json"]);
        }
        return true;
      }, stateStorage: {
        readState: () => null,
        writeState: (state) => writeFileSync(join(cwd, ".symphony/delivery-state.json"), JSON.stringify(state)),
      } });
      expect(git(["show", "--format=", "--name-only", "HEAD"]).trim()).toBe("source.txt");
      expect(git(["show", "HEAD:source.txt"])).toBe(repair ? "repaired\n" : "after\n");
      expect(repaired).toBe(repair);
      expect(result.spentRepairs).toBe(repair ? 1 : 0);
      if (repair) expect(git(["show", "--format=", "--name-only", "HEAD~1"]).trim()).toBe("source.txt");
      expect(git(["ls-files", ".symphony/delivery-state.json"]).trim()).toBe(tracked || staged ? ".symphony/delivery-state.json" : "");
      if (staged) expect(git(["show", ":.symphony/delivery-state.json"])).toBe(stagedState);
      const localState = JSON.parse(readFileSync(statePath, "utf8"));
      expect(localState.issueNumber).toBe(context.issueNumber);
      expect(localState.spentRepairs).toBe(repair ? 1 : 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("persists a pending deadline before interruption and expires across restart without repair", async () => {
    let state: PersistedDeliveryState | null = null;
    let clock = 100_000;
    const storage = { readState: () => state, writeState: (value: PersistedDeliveryState) => { state = value; } };
    const pending = fixture([{ name: "gate", status: "IN_PROGRESS" }]);
    await expect(runDeliverySkill({ ...options, runner: pending.runner, stateStorage: storage, nowFn: () => clock, sleepFn: async () => {
      clock += 4000;
      throw new Error("process interrupted");
    } })).rejects.toThrow("process interrupted");
    expect(storage.readState()?.deadlineTimestampMs).toBe(105_000);
    clock += 24_000;
    const restart = fixture();
    const result = await runDeliverySkill({ ...options, runner: restart.runner, stateStorage: storage, nowFn: () => clock });
    expect(result.reason).toBe("ci_wait_timeout");
    expect(result.spentRepairs).toBe(0);
    expect(storage.readState()?.deadlineTimestampMs).toBe(105_000);
    expect(restart.calls.some((args) => args[0] === "pr" && args.includes("statusCheckRollup"))).toBe(false);
  });

  it.each(["Not Found (HTTP 404)", "Resource not accessible (HTTP 403)"])("unknown classic rules fail closed even with a ruleset: %s", async (error) => {
    const f = fixture();
    f.setApi((args) => args[1]?.includes("rules/branches") ? ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "optional" }] } }]) : fail(error));
    const result = await runDeliverySkill({ ...options, runner: f.runner });
    expect(result.status).toBe("blocked");
    expect(result.handoffMarkdown).toContain(error);
  });

  it.each([{}, { contexts: [42] }, { checks: [{}] }])("rejects malformed classic protection: %j", async (payload) => {
    const f = fixture();
    f.setApi((args) => args[1]?.includes("rules/branches") ? ok([]) : ok(payload));
    expect((await runDeliverySkill({ ...options, runner: f.runner })).status).toBe("blocked");
  });

  it("consumes required checks from every active-rules page", async () => {
    const f = fixture();
    f.setApi((args) => args[1]?.includes("rules/branches") ? { stdout: "[]\n" + JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "gate" }] } }]), stderr: "", exitCode: 0 } : ok({ contexts: [], checks: [] }));
    let clock = 100_000;
    const result = await runDeliverySkill({ ...options, runner: f.runner, nowFn: () => clock, sleepFn: async () => { clock += 1000; } });
    expect(result.reason).toBe("ci_wait_timeout");
    const args = f.calls.find((args) => args[0] === "api" && args[1]?.includes("rules/branches"));
    expect(args).toContain("--paginate");
    expect(args).toContain("--jq");
    expect(args).toContain("@json");
    expect(args).not.toContain("--slurp");
  });

  it.each([{}, [{ type: "required_status_checks", parameters: {} }], [{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }]])("rejects malformed active rules: %j", async (payload) => {
    const f = fixture();
    f.setApi((args) => args[1]?.includes("rules/branches") ? ok(payload) : ok({ contexts: [], checks: [] }));
    expect((await runDeliverySkill({ ...options, runner: f.runner })).status).toBe("blocked");
  });

  it.each(["", "[]\n{bad json", "[]\n{}", "[]\nnull", "[]\n[{}]"])("fails closed on empty or malformed paginated output: %j", async (stdout) => {
    const f = fixture();
    f.setApi((args) => args[1]?.includes("rules/branches") ? { stdout, stderr: "", exitCode: 0 } : ok({ contexts: [], checks: [] }));
    expect((await runDeliverySkill({ ...options, runner: f.runner })).status).toBe("blocked");
  });

  it("only diagnoses the run referenced by the failed job, never an unrelated first run", async () => {
    const f = fixture();
    expect((await fetchCiFailureDiagnostics(f.runner, context.repo, "sha", [check], "/fixture")).status).toBe("success");
    expect(f.calls.filter((args) => args[0] === "run" && args[1] === "view").map((args) => args[2])).toEqual(["2"]);
  });

  it.each(["Resource not accessible by integration (HTTP 403)", "network unavailable"])("hands off log retrieval failure without consuming repair budget: %s", async (error) => {
    const f = fixture([{ name: check.name, detailsUrl: check.detailsUrl, status: "COMPLETED", conclusion: "FAILURE" }]);
    f.setDiagnostics((args) => args[1] === "list" ? ok([{ databaseId: 2, conclusion: "FAILURE" }]) : fail(error));
    let repairs = 0;
    const result = await runDeliverySkill({ ...options, runner: f.runner, repairFn: () => { repairs++; return true; } });
    expect(result.status).toBe("blocked");
    expect(result.spentRepairs).toBe(0);
    expect(repairs).toBe(0);
    expect(result.handoffMarkdown).toContain(error);
    expect(result.handoffMarkdown).toContain(check.detailsUrl);
  });

  it("refuses incomplete logs even when one failed run has usable logs", async () => {
    const f = fixture();
    f.setDiagnostics((args) => args[1] === "list" ? ok([{ databaseId: 1, conclusion: "FAILURE" }, { databaseId: 2, conclusion: "FAILURE" }]) : args[2] === "1" ? { stdout: "test failed", stderr: "", exitCode: 0 } : fail("log unavailable"));
    const result = await fetchCiFailureDiagnostics(f.runner, context.repo, "sha", [{ ...check, detailsUrl: "https://github.com/owner/repo/actions/runs/1" }, check], "/fixture");
    expect(result.status).toBe("unavailable");
    expect(result.failureReason).toContain("log unavailable");
  });

  it("rejects non-network origin protocols", () => {
    expect(parseGitHubRepoFromRemote("file://github.com/owner/repo.git")).toBeNull();
    expect(parseGitHubRepoFromRemote("ftp://github.com/owner/repo.git")).toBeNull();
  });
});
