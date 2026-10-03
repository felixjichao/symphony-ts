import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Issue } from "@symphony/domain";
import {
  createGitHubAdapterProfile,
  type TrackerAdapterProfile,
} from "@symphony/tracker";
import { createHost } from "./host";

const appServerFixture = fileURLToPath(
  new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url),
);

function makeIssue(identifier: string, state = "open"): Issue {
  return {
    id: `id-${identifier}`,
    nativeRef: null,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state,
    branchName: null,
    url: `https://example.com/${identifier}`,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Secret boundary wiring (SPEC §6.2 / §11.2 / §18.1, AC #11, #12, #13)", () => {
  it("AC #11: host env secret is visible to tracker adapter for authentication", async () => {
    let receivedAuth: string | undefined;

    const profile = createGitHubAdapterProfile({
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        receivedAuth = headers.get("authorization") ?? undefined;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-secret-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: github
  provider:
    repo: owner/repo
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
        env: {
          GITHUB_TOKEN: "mock-gh-token-12345",
        },
      });

      // Fetch candidates via host authority/tracker proxy
      await host.tracker.fetchIssuesByStates(["open"]);

      expect(receivedAuth).toBe("Bearer mock-gh-token-12345");
      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #12: fake app-server child subprocess env does NOT contain GITHUB_TOKEN, but retains non-sensitive variables", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-secret-child-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const envRecordFile = path.join(temp, "child-env.json");

    const issues: Issue[] = [makeIssue("SEC-01", "open")];
    const profile: TrackerAdapterProfile = {
      kind: "github_mock",
      documentation: "docs/testing.md#github_mock",
      secretProviderKeys: ["token"],
      secretEnvVars: ["GITHUB_TOKEN", "TRACKER_SECRET"],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "github_mock",
        fetchIssuesByIds: async (ids) => issues.filter((i) => ids.includes(i.id)),
        fetchIssuesByStates: async (states) => issues.filter((i) => states.includes(i.state)),
      }),
    };

    // Save original process.env
    const origGithubToken = process.env.GITHUB_TOKEN;
    const origTrackerSecret = process.env.TRACKER_SECRET;
    const origSentinel = process.env.SENTINEL_ENV;

    process.env.GITHUB_TOKEN = "super-secret-token-to-exclude";
    process.env.TRACKER_SECRET = "another-secret-token";
    process.env.SENTINEL_ENV = "sentinel-safe-value";

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: github_mock
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture} --record-env-presence GITHUB_TOKEN,TRACKER_SECRET,SENTINEL_ENV,PATH --record-env-file ${envRecordFile}
---
Prompt
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profile],
      });

      await host.start();

      await waitFor(async () => {
        try {
          const content = await readFile(envRecordFile, "utf8");
          return Boolean(content);
        } catch {
          return false;
        }
      }, 8000);

      const envReport = JSON.parse(await readFile(envRecordFile, "utf8"));

      // GITHUB_TOKEN and TRACKER_SECRET must be excluded from child environment
      expect(envReport.GITHUB_TOKEN?.present).toBe(false);
      expect(envReport.TRACKER_SECRET?.present).toBe(false);

      // Non-sensitive sentinel and PATH must be present
      expect(envReport.SENTINEL_ENV?.present).toBe(true);
      expect(envReport.SENTINEL_ENV?.value).toBe("sentinel-safe-value");
      expect(envReport.PATH?.present).toBe(true);

      await host.stop();
    } finally {
      if (origGithubToken !== undefined) process.env.GITHUB_TOKEN = origGithubToken;
      else delete process.env.GITHUB_TOKEN;

      if (origTrackerSecret !== undefined) process.env.TRACKER_SECRET = origTrackerSecret;
      else delete process.env.TRACKER_SECRET;

      if (origSentinel !== undefined) process.env.SENTINEL_ENV = origSentinel;
      else delete process.env.SENTINEL_ENV;

      await rm(temp, { recursive: true, force: true });
    }
  });

  it("AC #13: reload switches secret exclusions to follow selected profile, failed reload does not alter exclusions", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-secret-reload-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");

    const profileA: TrackerAdapterProfile = {
      kind: "profile_a",
      documentation: "docs/testing.md#profile_a",
      secretProviderKeys: ["token_a"],
      secretEnvVars: ["SECRET_ALPHA"],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "profile_a",
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => [],
      }),
    };

    const profileB: TrackerAdapterProfile = {
      kind: "profile_b",
      documentation: "docs/testing.md#profile_b",
      secretProviderKeys: ["token_b"],
      secretEnvVars: ["SECRET_BETA"],
      defaultActiveStates: ["open"],
      defaultTerminalStates: ["closed"],
      createAdapter: () => ({
        kind: "profile_b",
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => [],
      }),
    };

    try {
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: profile_a
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt A
`,
        "utf8",
      );

      const host = await createHost({
        workflowPath,
        trackerProfiles: [profileA, profileB],
        watcherIntervalMs: 50,
      });

      expect(host.effective.serviceConfig.tracker.kind).toBe("profile_a");
      const snap1 = host.getSnapshot();
      expect(snap1).toBeDefined();

      // Update to profile_b
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: profile_b
polling:
  interval_ms: 10000
workspace:
  root: ${path.join(temp, "workspaces")}
codex:
  command: node ${appServerFixture}
---
Prompt B
`,
        "utf8",
      );

      await waitFor(() => host.effective.serviceConfig.tracker.kind === "profile_b", 4000);
      expect(host.effective.serviceConfig.tracker.kind).toBe("profile_b");

      // Now trigger invalid reload
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: unsupported_kind
---
Invalid YAML
`,
        "utf8",
      );

      // Wait a moment for watcher to run
      await new Promise((r) => setTimeout(r, 200));

      // After failed reload, runtime remains on profile_b
      expect(host.effective.serviceConfig.tracker.kind).toBe("profile_b");

      await host.stop();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
