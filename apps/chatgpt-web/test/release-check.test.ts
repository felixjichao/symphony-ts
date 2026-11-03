import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

let temp = "";
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

it("requires a version increase for changed bundle bytes against the PR base", () => {
  execFileSync("npm", ["run", "build"], { cwd: resolve("."), stdio: "pipe" });
  temp = mkdtempSync(join(tmpdir(), "driver-release-"));
  const app = join(temp, "apps/chatgpt-web");
  cpSync(resolve("."), app, { recursive: true, filter: (path) => !path.includes("node_modules") && !path.includes("/test") });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: temp, stdio: "pipe" });
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", "-f", "apps/chatgpt-web/release.json", "apps/chatgpt-web/CHANGELOG.md");
  git("commit", "-m", "baseline");
  const check = () => spawnSync(process.execPath, [join(app, "scripts/check-release.mjs")], { env: { ...process.env, DRIVER_BASE_REF: "HEAD" }, encoding: "utf8" });
  expect(check().status).toBe(0);
  const bundlePath = join(app, "dist/symphony-decision-driver.user.js");
  const bundle = readFileSync(bundlePath, "utf8") + "\n// changed output\n";
  writeFileSync(bundlePath, bundle);
  expect(check().stderr).toContain("update release.json");
  const { version } = JSON.parse(readFileSync(join(app, "release.json"), "utf8")) as { version: string };
  const hash = createHash("sha256").update(bundle.replaceAll(version, "<DRIVER_VERSION>")).digest("hex");
  writeFileSync(join(app, "release.json"), JSON.stringify({ version, sha256: hash }));
  expect(check().stderr).toContain("requires a version greater");
});
