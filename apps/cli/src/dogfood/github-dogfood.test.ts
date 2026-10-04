import { describe, expect, it } from "vitest";

import {
  DogfoodError,
  hasCleanupCompletedFor,
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
  nowMs: number;
  stopped: boolean;
  hostOutput: string;
  existingWorkspace: boolean;
}

interface FakeOptions {
  gh: (args: readonly string[], state: FakeState) => DogfoodProcessResult;
  exec: (command: string, state: FakeState) => DogfoodProcessResult;
  hostOutput?: string;
}

function makeDeps(options: FakeOptions): { deps: DogfoodDeps; state: FakeState } {
  const state: FakeState = {
    files: new Map(),
    dirs: new Set(),
    nowMs: 0,
    stopped: false,
    hostOutput: options.hostOutput ?? "",
    existingWorkspace: false,
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
    sleep: async (ms) => { state.nowMs += ms; },
    now: () => state.nowMs,
    writeText: async (file, text) => { state.files.set(file, text); },
    readText: async (file) => {
      if (file.endsWith("WORKFLOW.md")) return "workspace:\n  root: ./workspaces\n";
      return state.files.get(file) ?? null;
    },
    mkdirp: async (dir) => { state.dirs.add(dir); },
    pathExists: async (target) => {
      if (target.endsWith("WORKFLOW.md")) return true;
      if (target.endsWith("GH-7")) return state.existingWorkspace;
      return state.dirs.has(target) || state.files.has(target);
    },
    rawAuthToken: async () => "github_pat_rawambienttoken_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    env: {},
    cwd: "/work",
    workspaceKeyOf: (identifier) => identifier,
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

  it("passes only on a real unmergeable refusal", async () => {
    const { deps, state } = makeDeps({ gh: conflictGh, exec: execHandler(res(1, "", JSON.stringify({ error: "unmergeable", message: "conflict" }))) });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "conflict", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(code).toBe(0);
    expect(manifestOf(state)?.["status"]).toBe("passed");
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
        if (args[0] === "run" && args[1] === "list") return res(0, "[]");
        return res(0, "{}");
      },
      exec: execHandler,
      hostOutput: cleanupLog,
    });
    const code = await runGithubDogfoodCli(["github", "--yes", "--target", TARGET, "--scenario", "happy", "--timeout", "60", "--run-id", RUN_ID, "--evidence-dir", "/ev", "--json"], io(), deps);
    expect(state.stopped).toBe(true);
    expect(code).toBe(0);
    expect(manifestOf(state)?.["status"]).toBe("passed");
  });
});
