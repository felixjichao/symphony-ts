import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeliveryError } from "@symphony/domain";

import { describe, expect, it } from "vitest";

import { runDeliveryCli } from "../delivery-cli";
import {
  buildProtectionPutPayload,
  createRealDogfoodDeps,
  DogfoodError,
  hasCleanupCompletedFor,
  parseStructuredErrorCode,
  parseStructuredLogLine,
  resolveToken,
  runGithubDogfoodCli,
  type DogfoodDeps,
  type DogfoodHostHandle,
  type DogfoodProcessResult,
} from "./github-dogfood";

const TARGET = "felixjichao/symphony-delivery-dogfood";
const RUN_ID = "test-run";

function res(exitCode = 0, stdout = "", stderr = ""): DogfoodProcessResult {
  return { exitCode, stdout, stderr };
}

interface FakeState {
  files: Map<string, string>;
  dirs: Set<string>;
  removed: string[];
  nowMs: number;
  stopped: boolean;
  hostOutput: string;
  existingWorkspace: boolean;
  signalHandler: ((signal: NodeJS.Signals) => void) | null;
  cancelOnSleep: boolean;
}

interface FakeOptions {
  gh: (args: readonly string[], state: FakeState) => DogfoodProcessResult;
  exec: (command: string, state: FakeState) => DogfoodProcessResult;
  hostOutput?: string;
  rawAuthToken?: () => Promise<string>;
  installSignals?: (handler: (signal: NodeJS.Signals) => void) => () => void;
}

function makeDeps(options: FakeOptions): { deps: DogfoodDeps; state: FakeState } {
  const state: FakeState = {
    files: new Map(),
    dirs: new Set(),
    removed: [],
    nowMs: 0,
    stopped: false,
    hostOutput: options.hostOutput ?? "",
    existingWorkspace: false,
    signalHandler: null,
    cancelOnSleep: false,
  };
  const host: DogfoodHostHandle = {
    output: () => state.hostOutput,
    stop: async () => { state.stopped = true; return 0; },
  };
  const deps: DogfoodDeps = {
    runner: {
      gh: async (args) => options.gh(args, state),
      exec: async (command) => options.exec(command, state),
    },
    startHost: () => { state.existingWorkspace = true; return host; },
    sleep: async (ms) => {
      state.nowMs += ms;
      if (state.cancelOnSleep && state.signalHandler !== null) {
        state.cancelOnSleep = false;
        state.signalHandler("SIGTERM");
      }
    },
    now: () => state.nowMs,
    writeText: async (file, text) => { state.files.set(file, text); },
    readText: async (file) => {
      if (file.endsWith("WORKFLOW.md")) return "workspace:\n  root: ./workspaces\n";
      return state.files.get(file) ?? null;
    },
    mkdirp: async (dir) => { state.dirs.add(dir); },
    removeDir: async (dir) => { state.removed.push(dir); },
    pathExists: async (target) => {
      if (target.endsWith("WORKFLOW.md")) return true;
      if (target.endsWith("GH-7")) return state.existingWorkspace;
      return state.dirs.has(target) || state.files.has(target);
    },
    rawAuthToken: options.rawAuthToken ?? (async () => "github_pat_rawambienttoken_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
    env: {},
    cwd: "/work",
    workspaceKeyOf: (identifier) => identifier,
    ...(options.installSignals !== undefined
      ? { installSignals: (handler: (signal: NodeJS.Signals) => void) => { state.signalHandler = handler; return () => { state.signalHandler = null; }; } }
      : {}),
  };
  return { deps, state };
}

function io() {
  return { stdout: { write: () => true }, stderr: { write: () => true } };
}

function manifestOf(state: FakeState): Record<string, unknown> | null {
  for (const [file, text] of state.files) {
    if (file.endsWith("manifest.json")) return JSON.parse(text) as Record<string, unknown>;
  }
  return null;
}

describe("structured log parsing", () => {
  it('parses key="value" fields from a real logger line', () => {
    const line = 'timestamp="2026-10-04T16:33:25.219Z" severity="info" event="workspace_cleanup" outcome="completed" reason="cleanup_completed" issue_id="id-1" issue_identifier="GH-7"';
    expect(parseStructuredLogLine(line)).toMatchObject({ event: "workspace_cleanup", outcome: "completed", issue_identifier: "GH-7" });
  });

  it("requires the cleanup event to match the exact issue identifier", () => {
    const log = [
      'event="workspace_cleanup" outcome="completed" reason="cleanup_completed" issue_identifier="GH-8"',
      'event="workspace_cleanup" outcome="failed" reason="cleanup_error" issue_identifier="GH-7"',
    ].join("\n");
    expect(hasCleanupCompletedFor(log, "GH-7")).toBe(false);
    expect(hasCleanupCompletedFor(`${log}\nevent="workspace_cleanup" outcome="completed" issue_identifier="GH-7"`, "GH-7")).toBe(true);
  });
});

describe("resolveToken", () => {
  const base = makeDeps({ gh: () => res(), exec: () => res() }).deps;

  it("returns the explicit env token unchanged (not redacted)", async () => {
    const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const resolved = await resolveToken({ ...base, env: { GITHUB_TOKEN: token } });
    expect(resolved).toEqual({ token, explicit: true });
  });

  it("refuses conflicting GITHUB_TOKEN/GH_TOKEN identities", async () => {
    await expect(resolveToken({ ...base, env: { GITHUB_TOKEN: "a", GH_TOKEN: "b" } })).rejects.toBeInstanceOf(DogfoodError);
  });

  it("falls back to the raw ambient gh token without sanitizing it", async () => {
    const resolved = await resolveToken({ ...base, env: {} });
    expect(resolved.explicit).toBe(false);
    expect(resolved.token).toBe("github_pat_rawambienttoken_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(resolved.token).not.toContain("REDACTED");
  });
});

describe("foreign scenario entry", () => {
  function foreignGh(args: readonly string[]): DogfoodProcessResult {
    if (args[0] === "label") return res();
    if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/7\n`);
    if (args[0] === "api" && args[1] !== undefined && args[1].endsWith("/git/ref/heads/main")) return res(0, '{"object":{"sha":"basesha"}}');
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return res();
    if (args[0] === "api" && args.includes("PUT")) return res();
    if (args[0] === "pr" && args[1] === "create") return res();
    if (args[0] === "pr" && args[1] === "list") {
      return res(0, JSON.stringify([{ number: 5, state: "OPEN", url: "u", body: "no marker", headRefName: `dogfood-foreign-${RUN_ID}`, mergeable: "MERGEABLE" }]));
    }
    if (args[0] === "issue" && args[1] === "view") return res(0, '{"number":7,"state":"OPEN","url":"u"}');
    return res(1, "", `unhandled gh ${args.join(" ")}`);
  }
  const execWithLand = (land: DogfoodProcessResult) => (command: string): DogfoodProcessResult => {
    if (command.startsWith("gh auth status")) return res();
    if (command.startsWith("gh repo view")) return res();
    if (command.startsWith("codex login status")) return res();
    if (command.includes(" pr land ")) return land;
    if (command.includes("--version")) return res();
    return res(1, "", `unhandled exec ${command}`);
  };

  it("fails when the land entry returns a transport error (exit 127) instead of a refusal", async () => {
    const { deps, state } = makeDeps({ gh: foreignGh, exec: execWithLand(res(127, "", "transport unavailable")) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "foreign", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(1);
    const manifest = manifestOf(state);
    expect(manifest?.["status"]).toBe("failed");
    expect((manifest?.["facts"] as { safetyRefusalCode: string | null } | null)?.safetyRefusalCode).toBeNull();
  });

  it("passes only on a real ownership refusal and leaves the foreign PR open", async () => {
    const land = res(1, "", JSON.stringify({ error: "ownership_refusal", message: "foreign PR" }));
    const { deps, state } = makeDeps({ gh: foreignGh, exec: execWithLand(land) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "foreign", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(0);
    expect(manifestOf(state)?.["status"]).toBe("passed");
  });
});

describe("conflict scenario entry", () => {
  function conflictGh(args: readonly string[]): DogfoodProcessResult {
    if (args[0] === "label") return res();
    if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/9\n`);
    if (args[0] === "api" && args[1] !== undefined && args[1].endsWith("/git/ref/heads/main")) return res(0, '{"object":{"sha":"basesha"}}');
    if (args[0] === "api" && args.includes("-X") && args.includes("POST")) return res();
    if (args[0] === "api" && args.includes("PUT")) return res();
    if (args[0] === "pr" && args[1] === "view") return res(0, '{"statusCheckRollup":[],"mergeable":"CONFLICTING","state":"OPEN","headRefOid":"h","mergeCommit":null}');
    if (args[0] === "pr" && args[1] === "list") {
      return res(0, JSON.stringify([{ number: 9, state: "OPEN", url: "u", body: `Fixes ${TARGET}#9`, headRefName: "symphony/x", mergeable: "CONFLICTING" }]));
    }
    if (args[0] === "issue" && args[1] === "view") return res(0, '{"number":9,"state":"OPEN","url":"u"}');
    return res(1, "", `unhandled gh ${args.join(" ")}`);
  }
  function execHandler(land: DogfoodProcessResult) {
    return (command: string): DogfoodProcessResult => {
      if (command.startsWith("gh auth status")) return res();
      if (command.startsWith("gh repo view")) return res();
      if (command.startsWith("codex login status")) return res();
      if (command.includes(" pr ensure ")) return res(0, JSON.stringify({ number: 9 }), "");
      if (command.includes(" pr land ")) return land;
      if (command.includes("--version")) return res();
      return res(1, "", `unhandled exec ${command}`);
    };
  }

  it("passes only on a real merge_rejected refusal with a verified conflict", async () => {
    const { deps, state } = makeDeps({ gh: conflictGh, exec: execHandler(res(1, "", JSON.stringify({ error: "merge_rejected", message: "conflict" }))) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "conflict", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(0);
    expect(manifestOf(state)?.["status"]).toBe("passed");
  });

  it("fails when land returns a non-refusal code even though the PR is not merged", async () => {
    const { deps, state } = makeDeps({ gh: conflictGh, exec: execHandler(res(1, "", JSON.stringify({ error: "timeout", message: "transient" }))) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "conflict", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(1);
    expect(manifestOf(state)?.["status"]).toBe("failed");
  });

  it("fails when land unexpectedly succeeds and merges", async () => {
    const { deps, state } = makeDeps({ gh: conflictGh, exec: execHandler(res(0, "{}", "")) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "conflict", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(1);
    expect(manifestOf(state)?.["status"]).toBe("failed");
  });
});

describe("host lifecycle", () => {
  function hostGh(args: readonly string[], state: FakeState): DogfoodProcessResult {
    if (args[0] === "label") return res();
    if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/7\n`);
    if (args[0] === "issue" && args[1] === "view") {
      if (state.hostOutput.includes("shouldthrow")) return res(1, "", "boom");
      if (state.hostOutput.includes("workspace_cleanup")) state.existingWorkspace = false;
      return res(0, '{"number":7,"state":"OPEN","url":"u"}');
    }
    if (args[0] === "pr" && args[1] === "list") return res(0, "[]");
    return res(0, "{}");
  }
  const execHandler = (): DogfoodProcessResult => res();

  it("stops the host and fails on a waiting timeout", async () => {
    const { deps, state } = makeDeps({ gh: hostGh, exec: execHandler });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "happy", "--timeout", "30", "--run-id", RUN_ID, "--evidence-dir", "/ev"], io(), deps);
    expect(code).toBe(1);
    expect(state.stopped).toBe(true);
    expect(manifestOf(state)?.["status"]).toBe("failed");
    // A failed run keeps its workspace/state for recovery.
    expect(state.removed).toEqual([]);
  });

  it("stops the host on success and requires terminal cleanup", async () => {
    const cleanupLog = 'severity="info" event="workspace_cleanup" outcome="completed" reason="cleanup_completed" issue_identifier="GH-7"';
    const { deps, state } = makeDeps({
      gh: (args, s) => {
        if (args[0] === "label") return res();
        if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/7\n`);
        if (args[0] === "issue" && args[1] === "view") {
          s.existingWorkspace = false;
          return res(0, '{"number":7,"state":"CLOSED","url":"u"}');
        }
        if (args[0] === "pr" && args[1] === "list") return res(0, JSON.stringify([{ number: 5, state: "MERGED", url: "u", body: `Fixes ${TARGET}#7`, headRefName: "b", mergeable: "MERGEABLE" }]));
        if (args[0] === "pr" && args[1] === "view") return res(0, '{"statusCheckRollup":[{"conclusion":"SUCCESS"}],"mergeable":"MERGEABLE","state":"MERGED","headRefOid":"h","mergeCommit":{"oid":"mergesha"}}');
        if (args[0] === "run" && args[1] === "list") return res(0, JSON.stringify([{ databaseId: 1, headSha: "h", conclusion: "SUCCESS", status: "completed", url: "u", workflowName: "CI" }]));
        return res(0, "{}");
      },
      exec: execHandler,
      hostOutput: cleanupLog,
    });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "happy", "--timeout", "60", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(state.stopped).toBe(true);
    expect(code).toBe(0);
    expect(manifestOf(state)?.["status"]).toBe("passed");
    // A clean success removes the run working directory.
    expect(state.removed.some((p) => p.endsWith("work"))).toBe(true);
  });
});

describe("credential and skip semantics", () => {
  const unusedGh = (): DogfoodProcessResult => res(1, "", "unused");
  const unusedExec = (): DogfoodProcessResult => res(1, "", "unused");
  const argv = ["github", "--yes", "--target", TARGET, "--scenario", "foreign", "--run-id", RUN_ID, "--evidence-dir", "/ev"];

  it("treats credential_conflict as a hard error, not a skip", async () => {
    const { deps } = makeDeps({ gh: unusedGh, exec: unusedExec });
    deps.env["GITHUB_TOKEN"] = "a";
    deps.env["GH_TOKEN"] = "b";
    const code = await runGithubDogfoodCli(argv, io(), deps);
    expect(code).toBe(1);
  });

  it("skips cleanly only when no credential exists", async () => {
    const { deps } = makeDeps({
      gh: unusedGh,
      exec: unusedExec,
      rawAuthToken: async () => { throw new DogfoodError("no GitHub credential: set GITHUB_TOKEN or run 'gh auth login'", "missing_credential"); },
    });
    const code = await runGithubDogfoodCli(argv, io(), deps);
    expect(code).toBe(0);
  });

  it("pins a dedicated token onto every GitHub operation, not only the host", async () => {
    const token = "github_pat_dedicated0123456789_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const { deps } = makeDeps({ gh: unusedGh, exec: unusedExec });
    deps.env["SYMPHONY_DOGFOOD_TOKEN"] = token;
    await runGithubDogfoodCli(argv, io(), deps);
    expect(deps.env["GH_TOKEN"]).toBe(token);
    expect(deps.env["GITHUB_TOKEN"]).toBe(token);
  });
});

describe("reuse scenario entry", () => {
  it("verifies the same PR, branch and preserved budget across a bounded restart", async () => {
    const cleanupLog = 'severity="info" event="workspace_cleanup" outcome="completed" reason="cleanup_completed" issue_identifier="GH-7"';
    const evidenceDir = path.resolve("/ev", RUN_ID);
    const stateFile = path.join(evidenceDir, "work", "workspaces", "GH-7", ".symphony", "delivery-state.json");
    const persisted = JSON.stringify({ repo: TARGET, issueNumber: 7, workspaceKey: "GH-7", spentRepairs: 0, spentWaitSeconds: 12, deadlineTimestampMs: 123456789, isPaused: false });

    const { deps, state } = makeDeps({
      gh: (args, s) => {
        if (args[0] === "label") return res();
        if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/7\n`);
        if (args[0] === "issue" && args[1] === "view") {
          s.existingWorkspace = false;
          return res(0, '{"number":7,"state":"CLOSED","url":"u"}');
        }
        if (args[0] === "pr" && args[1] === "list") {
          const prState = s.existingWorkspace ? "OPEN" : "MERGED";
          return res(0, JSON.stringify([{ number: 5, state: prState, url: "u", body: `Fixes ${TARGET}#7`, headRefName: "symphony/GH-7", mergeable: "MERGEABLE" }]));
        }
        if (args[0] === "pr" && args[1] === "view") return res(0, '{"statusCheckRollup":[{"conclusion":"SUCCESS"}],"mergeable":"MERGEABLE","state":"MERGED","headRefOid":"h","mergeCommit":{"oid":"mergesha"}}');
        if (args[0] === "run" && args[1] === "list") return res(0, JSON.stringify([{ databaseId: 1, headSha: "h", conclusion: "SUCCESS", status: "completed", url: "u", workflowName: "CI" }]));
        if (args[0] === "api" && args[1] !== undefined && args[1].includes("/protection")) return res(1, "", "HTTP 404: Not Found");
        return res(0, "{}");
      },
      exec: (command) => {
        if (command.includes("/protection")) return res();
        if (command.startsWith("gh ") || command.startsWith("codex ") || command.includes("--version")) return res();
        return res();
      },
      hostOutput: cleanupLog,
    });
    state.files.set(stateFile, persisted);

    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "reuse", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(0);
    const manifest = manifestOf(state);
    expect(manifest?.["status"]).toBe("passed");
    expect((manifest?.["facts"] as { reuseVerified: boolean }).reuseVerified).toBe(true);
  });
});

describe("real service to CLI to harness contract", () => {
  it("reads the real delivery CLI's merge_rejected conflict error", async () => {
    const service = {
      landPr: async () => { throw new DeliveryError("PR #9 has merge conflicts with main", { code: "merge_rejected" }); },
    };
    let out = "";
    let errOut = "";
    const code = await runDeliveryCli(["land", "--repo", "o/r", "--issue", "9", "--workspace-key", "k", "--opt-in", "--json"], {
      service: service as never,
      stdout: { write: (t: string) => { out += t; return true; } },
      stderr: { write: (t: string) => { errOut += t; return true; } },
    });
    expect(code).toBe(1);
    expect(parseStructuredErrorCode(out, errOut)).toBe("merge_rejected");
  });
});

describe("branch protection GET to PUT conversion", () => {
  it("maps GET shapes (enabled/user/team/app objects, app_id) into a valid PUT payload", () => {
    const get = JSON.stringify({
      required_status_checks: { strict: true, contexts: ["ci"], checks: [{ context: "build", app_id: 15368 }] },
      enforce_admins: { enabled: true },
      required_linear_history: { enabled: true },
      allow_force_pushes: { enabled: false },
      required_pull_request_reviews: {
        dismissal_restrictions: { users: [{ login: "alice" }], teams: [{ slug: "core" }] },
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 2,
      },
      restrictions: { users: [{ login: "bob" }], teams: [], apps: [{ slug: "actions" }] },
    });
    const payload = JSON.parse(buildProtectionPutPayload(get, null)) as Record<string, unknown>;
    expect(payload["enforce_admins"]).toBe(true);
    expect(payload["required_linear_history"]).toBe(true);
    expect(payload["allow_force_pushes"]).toBe(false);
    const rsc = payload["required_status_checks"] as { strict: boolean; contexts: string[]; checks: Array<{ context: string; app_id?: number }> };
    expect(rsc.strict).toBe(true);
    expect(rsc.checks).toEqual([{ context: "build", app_id: 15368 }]);
    const rpr = payload["required_pull_request_reviews"] as { required_approving_review_count: number; dismissal_restrictions: { users: string[]; teams: string[] } };
    expect(rpr.required_approving_review_count).toBe(2);
    expect(rpr.dismissal_restrictions).toEqual({ users: ["alice"], teams: ["core"] });
    expect(payload["restrictions"]).toEqual({ users: ["bob"], teams: [], apps: ["actions"] });
  });

  it("preserves null semantics and adds the hold context without dropping bindings", () => {
    expect(JSON.parse(buildProtectionPutPayload(null, null))["required_status_checks"]).toBeNull();
    expect(JSON.parse(buildProtectionPutPayload(null, null))["enforce_admins"]).toBe(false);
    const hold = JSON.parse(buildProtectionPutPayload(null, "symphony-dogfood-hold")) as Record<string, unknown>;
    const rsc = hold["required_status_checks"] as { contexts: string[]; checks: Array<{ context: string }> };
    expect(rsc.contexts).toContain("symphony-dogfood-hold");
    expect(rsc.checks.some((c) => c.context === "symphony-dogfood-hold")).toBe(true);
  });
});

describe("cancellation unwinds the scenario and restores policy", () => {
  it("restores existing branch protection and captures the phase-1 log on SIGTERM", async () => {
    const protectionBody = JSON.stringify({
      required_status_checks: { strict: false, contexts: ["ci"], checks: [{ context: "ci", app_id: 15368 }] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: null,
      restrictions: null,
    });
    const execCommands: string[] = [];
    const { deps, state } = makeDeps({
      installSignals: () => () => { /* captured via makeDeps state */ },
      gh: (args) => {
        if (args[0] === "label") return res();
        if (args[0] === "issue" && args[1] === "create") return res(0, `https://github.com/${TARGET}/issues/7\n`);
        if (args[0] === "issue" && args[1] === "view") return res(0, '{"number":7,"state":"OPEN","url":"u"}');
        if (args[0] === "pr" && args[1] === "list") return res(0, "[]");
        if (args[0] === "api" && args[1] !== undefined && args[1].includes("/protection")) return res(0, protectionBody);
        return res(0, "{}");
      },
      exec: (command) => { execCommands.push(command); return res(); },
    });
    state.cancelOnSleep = true;

    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "reuse", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(143);
    // Apply hold + restore both went through PUT because protection already existed.
    expect(execCommands.filter((c) => c.includes("-X PUT")).length).toBeGreaterThanOrEqual(2);
    expect(execCommands.filter((c) => c.includes("-X DELETE")).length).toBe(0);
    // The scenario finally captured phase-1 logs despite cancellation.
    expect([...state.files.keys()].some((f) => f.endsWith("host-reuse-phase1.log"))).toBe(true);
    // Cancelled runs retain their workspace/state.
    expect(state.removed).toEqual([]);
  });
});

describe("real credential adapter classification (subprocess)", () => {
  it("classifies a logged-out gh as missing_credential (skip)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-gh-"));
    const oldPath = process.env["PATH"];
    try {
      const ghPath = path.join(tmp, "gh");
      fs.writeFileSync(ghPath, "#!/bin/sh\necho 'To get started with GitHub CLI, please run: gh auth login' >&2\nexit 1\n");
      fs.chmodSync(ghPath, 0o755);
      process.env["PATH"] = `${tmp}:${oldPath ?? ""}`;
      await expect(resolveToken(createRealDogfoodDeps({}))).rejects.toMatchObject({ code: "missing_credential" });
    } finally {
      if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies a missing gh binary as a tool failure, not a skip", async () => {
    const oldPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-dogfood-bin";
    try {
      await expect(resolveToken(createRealDogfoodDeps({}))).rejects.toMatchObject({ code: "tool_missing" });
    } finally {
      if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
    }
  });
});
