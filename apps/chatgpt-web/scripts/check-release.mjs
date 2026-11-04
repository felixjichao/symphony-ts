import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const fail = (message) => { throw new Error(`Userscript release: ${message}`); };
const config = read("vite.config.ts");
const version = config.match(/const DRIVER_VERSION = "(\d+\.\d+\.\d+)";/)?.[1];
if (!version) fail("invalid DRIVER_VERSION");
const bundle = read("dist/symphony-decision-driver.user.js");
if (!bundle.startsWith("// ==UserScript==\n") || (bundle.match(/\/\/ ==UserScript==/g) ?? []).length !== 1 || !bundle.includes(`// @version      ${version}\n`)) fail("metadata version/header mismatch");
const hash = createHash("sha256").update(bundle.replaceAll(version, "<DRIVER_VERSION>")).digest("hex");
const manifest = JSON.parse(read("release.json"));
if (manifest.version !== version || manifest.sha256 !== hash) fail(`update release.json for ${version}; normalized SHA-256: ${hash}`);
if (!read("README.md").includes(`current userscript version is **${version}**`)) fail("README current version mismatch");
const changelog = read("CHANGELOG.md");
const section = changelog.match(/^## (\d+\.\d+\.\d+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
if (!section || section[1] !== version || !/#\d+/.test(section[2])) fail("first changelog entry must match version and reference an issue or PR");
const base = process.env.DRIVER_BASE_REF;
if (base) {
  execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root });
  let previousText;
  try { previousText = execFileSync("git", ["show", `${base}:apps/chatgpt-web/release.json`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { previousText = null; } // The first release manifest has no baseline.
  if (previousText !== null) {
    const previous = JSON.parse(previousText);
    const compare = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; };
    const order = compare(version, previous.version);
    if (order < 0 || (hash !== previous.sha256 && order <= 0)) fail("changed bundle requires a version greater than the baseline");
    if (order > 0) {
      const oldLog = execFileSync("git", ["show", `${base}:apps/chatgpt-web/CHANGELOG.md`], { cwd: root, encoding: "utf8" });
      if (!changelog.includes(oldLog.trim())) fail("preserve the previous changelog when adding a release");
    }
  }
}
console.log(`Userscript ${version}: release record and bundle verified (${hash})`);
