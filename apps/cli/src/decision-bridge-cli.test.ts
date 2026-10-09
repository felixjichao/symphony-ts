import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseDecisionBridgeArgs,
  runDecisionBridgeCli,
} from "./decision-bridge-cli";
import { runCli } from "./lifecycle";

describe("Decision Bridge CLI", () => {
  it("parses CLI flags correctly", () => {
    const parsed = parseDecisionBridgeArgs([
      "--store", "/data/store",
      "--port", "5050",
      "--token", "secret",
      "--ttl", "60",
    ]);
    expect(parsed.storeDir).toBe("/data/store");
    expect(parsed.port).toBe(5050);
    expect(parsed.authToken).toBe("secret");
    expect(parsed.ttlSeconds).toBe(60);
    expect(parsed.help).toBe(false);

    const helpParsed = parseDecisionBridgeArgs(["--help"]);
    expect(helpParsed.help).toBe(true);
  });

  it("prints help and exits with 0", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runDecisionBridgeCli(["--help"], {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: symphony decision bridge --store <dir>");
    expect(stderr).toBe("");
  });

  it("fails with 1 when required --store argument is missing", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runDecisionBridgeCli([], {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("missing required argument --store");
  });

  it("starts bridge and shuts down cleanly via stopSignal", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-bridge-test-"));
    try {
      let stdout = "";
      let _stderr = "";
      let stopTrigger!: () => void;
      const stopSignal = new Promise<void>((resolve) => {
        stopTrigger = resolve;
      });

      const cliPromise = runDecisionBridgeCli(
        ["--store", tmpDir, "--port", "0"],
        {
          stdout: { write: (text) => { stdout += text; } },
          stderr: { write: (text) => { _stderr += text; } },
        },
        { stopSignal }
      );

      // Wait until listening
      const startWait = Date.now();
      while (!stdout.includes("listening on") && Date.now() - startWait < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stdout).toContain("listening on http://127.0.0.1:");

      // Trigger shutdown
      stopTrigger();
      const code = await cliPromise;
      expect(code).toBe(0);
      expect(stdout).toContain("stopped gracefully");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("dispatches decision bridge via top-level runCli", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["decision", "bridge", "--help"], {
      process: {
        stdout: { write: (text) => { stdout += text; } },
        stderr: { write: (text) => { stderr += text; } },
        on: () => {},
        removeListener: () => {},
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: symphony decision bridge --store <dir>");
    expect(stderr).toBe("");
  });

  it("includes decision bridge in root help output", async () => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["--help"], {
      process: {
        stdout: { write: (text) => { stdout += text; } },
        stderr: { write: (text) => { stderr += text; } },
        on: () => {},
        removeListener: () => {},
      },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("symphony decision bridge --store <dir>");
    expect(stdout).toContain("decision bridge");
    expect(stderr).toBe("");
  });
});
