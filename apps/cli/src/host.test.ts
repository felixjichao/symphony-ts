import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SymphonyConfigError } from "@symphony/config";
import { createStructuredLogger } from "@symphony/observability";
import type { TrackerAdapterProfile } from "@symphony/tracker";
import { createHost } from "./host";

function createMemoryLogger(lines: string[]) {
  return createStructuredLogger({
    sinks: [{ write(line) { lines.push(line); } }],
  });
}

function fixtureProfile(calls: string[] = []): TrackerAdapterProfile {
  return {
    kind: "fixture",
    documentation: "docs/testing.md#fixture-tracker",
    secretProviderKeys: ["token"],
    secretEnvVars: ["FIXTURE_TOKEN"],
    defaultActiveStates: ["open"],
    defaultTerminalStates: ["closed"],
    createAdapter: () => ({
      kind: "fixture",
      fetchIssuesByIds: async (ids) => {
        calls.push(`fetch_by_ids:${ids.join(",")}`);
        return [];
      },
      fetchIssuesByStates: async (states) => {
        calls.push(`fetch_by_states:${states.join(",")}`);
        return [];
      },
    }),
  };
}

describe("createHost in-process composition", () => {
  it("fails fast on missing workflow file without process.exit and logs config_validation", async () => {
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);
    const nonExistent = path.join(os.tmpdir(), "symphony-non-existent-WORKFLOW.md");

    await expect(createHost({ workflowPath: nonExistent, logger })).rejects.toThrowError(SymphonyConfigError);
    expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("missing_workflow_file"))).toBe(true);
  });

  it("fails fast on unsupported tracker kind and logs config failure", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: unknown_provider\nworkspace:\n  root: ${temp}\ncodex:\n  command: "echo test"\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrow();
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("unsupported_tracker_kind"))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails fast on invalid config syntax/schema and logs config failure", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\n[invalid-yaml\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrow();
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("fails fast when codex.command is empty", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: fixture\nworkspace:\n  root: ${temp}\ncodex:\n  command: "   "\n---\nPrompt\n`);
      await expect(createHost({
        workflowPath,
        logger,
        trackerProfiles: [fixtureProfile()],
      })).rejects.toThrow("codex.command is empty");
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("starts and stops real loop gracefully with custom tracker and scheduler", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);
    const calls: string[] = [];

    try {
      await writeFile(workflowPath, `---\ntracker:\n  kind: fixture\n  provider:\n    token: "my-secret-token"\nworkspace:\n  root: ${temp}\npolling:\n  interval_ms: 1000\ncodex:\n  command: "echo test"\n---\nPrompt {{ issue.identifier }}\n`);

      const host = await createHost({
        workflowPath,
        logger,
        trackerProfiles: [fixtureProfile(calls)],
      });

      expect(host.workflowPath).toBe(workflowPath);
      expect(host.effective.serviceConfig.polling.intervalMs).toBe(1000);
      expect(host.state.running.size).toBe(0);

      await host.start();
      expect(lines.some((l) => l.includes('event="startup" outcome="started"'))).toBe(true);
      expect(lines.some((l) => l.includes('event="startup" outcome="completed"'))).toBe(true);

      // Verify secret token was redacted
      expect(lines.join("\n")).not.toContain("my-secret-token");

      await host.stop();
      expect(lines.some((l) => l.includes('event="shutdown" outcome="started"'))).toBe(true);
      expect(lines.some((l) => l.includes('event="shutdown" outcome="completed"'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("assembles built-in github profile by default and validates tracker config", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "symphony-host-"));
    const workflowPath = path.join(temp, "WORKFLOW.md");
    const lines: string[] = [];
    const logger = createMemoryLogger(lines);

    try {
      // Invalid repo format for github provider
      await writeFile(workflowPath, `---\ntracker:\n  kind: github\n  provider:\n    repo: "invalid-repo"\n    token: "gh-secret"\nworkspace:\n  root: ${temp}\ncodex:\n  command: "echo test"\n---\nPrompt\n`);
      await expect(createHost({ workflowPath, logger })).rejects.toThrowError(SymphonyConfigError);
      expect(lines.some((l) => l.includes('event="config_validation" outcome="failed"') && l.includes("invalid_tracker_config"))).toBe(true);
      expect(lines.join("\n")).not.toContain("gh-secret");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
