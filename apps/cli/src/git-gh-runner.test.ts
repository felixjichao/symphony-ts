import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

afterEach(() => vi.unstubAllEnvs());

it("#186 production repair subprocess excludes host provider secrets and preserves Codex authentication", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "repair-secret-boundary-"));
  try {
    vi.stubEnv("GITHUB_TOKEN", "host-github-secret");
    vi.stubEnv("GH_TOKEN", "host-gh-secret");
    vi.stubEnv("CUSTOM_PROVIDER_SECRET", "host-custom-secret");
    vi.stubEnv("CODEX_API_KEY", "codex-auth-fixture");
    vi.stubEnv("PATH", `${cwd}:${process.env.PATH}`);
    fs.writeFileSync(path.join(cwd, "codex"), `#!/bin/sh
exec "${process.execPath}" -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.stringify({ input, github: process.env.GITHUB_TOKEN ?? null, gh: process.env.GH_TOKEN ?? null, custom: process.env.CUSTOM_PROVIDER_SECRET ?? null, auth: process.env.CODEX_API_KEY, path: !!process.env.PATH })));'
`, { mode: 0o755 });
    let excluded = ["CUSTOM_PROVIDER_SECRET"];
    const runner = new DefaultDeliveryGitGhRunner(() => excluded);
    const result = await runner.exec(
      "printf '%s\\n' \"$SYMPHONY_REPAIR_PROMPT\" | codex exec --sandbox workspace-write -",
      cwd, 5_000,
      { SYMPHONY_REPAIR_PROMPT: "conflict evidence", GH_TOKEN: "override-must-also-be-removed" },
      ["GITHUB_TOKEN", "GH_TOKEN"],
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ input: "conflict evidence\n", github: null, gh: null,
      custom: null, auth: "codex-auth-fixture", path: true });
    // Host delivery commands retain their credentials; profile reloads are read at launch.
    excluded = ["CODEX_API_KEY"];
    const reloaded = await runner.exec('test -z "$CODEX_API_KEY"', cwd, 5_000, {}, []);
    expect(reloaded.exitCode).toBe(0);
    const host = await runner.exec('test -n "$GITHUB_TOKEN" && test -n "$GH_TOKEN"', cwd);
    expect(host.exitCode).toBe(0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
