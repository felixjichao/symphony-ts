import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { build } from "vite";
import { createHash } from "node:crypto";
import { projectionWrites } from "./typed-guard";
import { browserErrors } from "./guards";
const root = path.resolve(import.meta.dirname, "../../..");
function files(dir: string): string[] { return readdirSync(dir).flatMap(n => { const p = path.join(dir, n); return ["node_modules", "dist", ".git"].includes(n) ? [] : statSync(p).isDirectory() ? files(p) : [p]; }); }
describe("mechanical observation boundaries", () => {
  it("uses the type checker to reject construction/write through projection aliases", () => {
    const config = ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const browserFiles = files(path.join(root, "apps/dashboard/src")).filter(f => f.endsWith(".ts"));
    const program = ts.createProgram(browserFiles, parsed.options);
    expect(projectionWrites(program, path.join(root, "apps/dashboard/src"))).toEqual([]);
    const name = path.join(root, "apps/dashboard/src/negative.ts");
    const host = ts.createCompilerHost(parsed.options); const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) => file === name ? ts.createSourceFile(file, 'import type { WorkProjection as Alias } from "@symphony/operations"; const forged: Alias = { phase: "review" }; forged.attention = "normal";', language, true) : original(file, language, onError, fresh);
    const negative = ts.createProgram([...browserFiles, name], parsed.options, host);
    expect(projectionWrites(negative, path.join(root, "apps/dashboard/src")).length).toBeGreaterThan(0);
  });
  it.each([
    'export function inferred(w: WorkProjection): WorkProjection["phase"] { const phase = w.ci?.status ? "ci" : "unknown"; return phase; }',
    'export function inferred(w: WorkProjection) { const status = w.ci?.status; const phase = status ? "ci" : "unknown"; return phase; }',
    'export const inferred = (w: WorkProjection): WorkProjection["phase"] => { let phase: WorkProjection["phase"] = "unknown"; if (w.ci?.status) phase = "ci"; return phase; };',
  ])("rejects type-correct helper conclusions through locals: %s", body => {
    const config = ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const name = path.join(root, "apps/dashboard/src/negative.ts");
    const host = ts.createCompilerHost(parsed.options); const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) => file === name ? ts.createSourceFile(file, `import type { WorkProjection } from "@symphony/operations"; ${body}`, language, true) : original(file, language, onError, fresh);
    const program = ts.createProgram([name], parsed.options, host);
    expect(program.getSemanticDiagnostics(program.getSourceFile(name)!)).toEqual([]);
    expect(projectionWrites(program, path.join(root, "apps/dashboard/src"))).toContain("helper returns domain conclusion");
  });
  it("locks approved shape/format/rank helpers to a closed implementation", () => {
    // Updating these fingerprints requires reviewing the helper and its negative cases.
    const approved: Record<string, string> = {"identity.ts": "489c9ec6ac964845784a4be94c5c0bcc551d85d5bba93b4ce3cf81ec4daa11bc", "presentation.ts": "603a0fab571eea7fc51ec9c74010821bfa0659c9b4b893825c332a34403d4d61", "validate.ts": "3c9f96c9a19a9e57c4b0a755d158ad211f33c43002ef7b0a698f9317a07d8337"};
    for (const [name, digest] of Object.entries(approved)) expect(createHash("sha256").update(readFileSync(path.join(root, "apps/dashboard/src", name))).digest("hex"), name).toBe(digest);
  });
  it("checks every browser module, including local helpers", () => {
    const allowed = ["identity.ts", "presentation.ts", "transport.ts", "validate.ts", "polling.ts", "view.ts", "main.ts"];
    for (const file of files(path.join(root, "apps/dashboard/src")).filter(f => f.endsWith(".ts"))) {
      expect(allowed).toContain(path.basename(file));
      expect(browserErrors(path.basename(file), readFileSync(file, "utf8")), file).toEqual([]);
    }
  });
  it.each([
    'function f(w) { return w.ci.status === "success" && w.review.task.status === "running" ? "review" : "coding"; }',
    'function f(w) { return { approval: w.review.currentHeadSha === w.review.taskTarget.headSha ? "approved_current_head" : "unknown" }; }',
    'function f(s) { return { anomalyCount: s.anomalies.length }; }',
    'function hidden(w) { const c = w.ci.status; return c === "success" ? "review" : "coding"; }',
    'import { read } from "@hidden/source";',
    'fetch("/api/operations/snapshot", {method:"POST"});',
  ])("rejects unsafe source: %s", source => expect(browserErrors("helper.ts", source).length).toBeGreaterThan(0));
  it("rejects POST even inside the sole transport module", () => expect(browserErrors("transport.ts", 'fetch("/api/operations/snapshot", {method:"POST",cache:"no-store",redirect:"error"})').length).toBeGreaterThan(0));
  it.each([
    'window.fetch("https://example.invalid/mutate", {method:"POST"})',
    'globalThis.fetch("https://example.invalid/mutate", {method:"POST"})',
    'window["fetch"]("https://example.invalid/mutate", {method:"POST"})',
    'const send = fetch; send("/mutate", {method:"POST"})',
    'const send = window.fetch; const alias = send; alias("/mutate", {method:"POST"})',
    'const { fetch: send } = globalThis; send("/mutate", {method:"POST"})',
    'const send = window.fetch.bind(window); send("/mutate", {method:"POST"})',
    'const scope = window; scope.fetch("/mutate", {method:"POST"})',
    'const scope = globalThis; scope["fe" + "tch"]("/mutate", {method:"POST"})',
  ])("rejects capability binding before aliases can escape: %s", source => {
    const view = readFileSync(path.join(root, "apps/dashboard/src/view.ts"), "utf8");
    const transport = readFileSync(path.join(root, "apps/dashboard/src/transport.ts"), "utf8");
    for (const [name, original] of [["view.ts", view], ["transport.ts", transport]]) expect(browserErrors(name!, `${original}\n${source}`).some(e => e.includes("capability"))).toBe(true);
  });
  it.each([
    'const phase = w.ci?.status ? "ci" : "unknown"; return phase;',
    'const status = w.ci?.status; const phase = status ? "ci" : "unknown"; return phase;',
    'if (w.ci?.status) return "ci"; return "unknown";',
    'const status = w.ci?.status; if (status) return "ci"; return "unknown";',
    'switch (w.ci?.status) { case "success": return "review"; default: return "ci"; }',
    'return choose(w.ci?.status);',
    'const { status: signal } = w.ci; return signal ? "ci" : "unknown";',
    'let signal; signal = w.ci?.status; return signal ? "ci" : "unknown";',
    'return !w.ci?.status;',
    'w.ci?.toString(); return "unknown";',
  ])("rejects sensitive control flow and helper calls: %s", body => {
    const view = readFileSync(path.join(root, "apps/dashboard/src/view.ts"), "utf8");
    const errors = browserErrors("view.ts", `${view}\nfunction inferred(w: WorkProjection): WorkProjection["phase"] { ${body} }`);
    expect(errors.some(e => /source-dependent|source truthiness|unapproved helper|returning source/.test(e))).toBe(true);
  });
  it.each([
    '{ method: "GET", cache: "no-store", redirect: "error", signal, ...options }',
    '{ method: "GET", cache: "no-store", redirect: "error", signal, method: "POST" }',
  ])("rejects transport option overrides: %s", options => expect(browserErrors("transport.ts", `fetch("/api/operations/snapshot", ${options})`)).toContain("closed transport options"));
  it("traverses core manifest and resolved TS graphs, including relative/alias/dynamic edges", () => {
    const config = ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const manifests = new Map<string, { dir: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>();
    for (const group of ["packages", "apps"]) for (const name of readdirSync(path.join(root, group))) {
      const dir = path.join(root, group, name);
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")); manifests.set(manifest.name, { ...manifest, dir });
    }
    const forbidden = /dashboard|react|vue|svelte|angular|preact/;
    const visited = new Set<string>();
    function graph(name: string) { if (visited.has(name)) return; visited.add(name); expect(name).not.toMatch(forbidden); const m = manifests.get(name); if (m) for (const dep of Object.keys({ ...m.dependencies, ...m.devDependencies, ...m.peerDependencies, ...m.optionalDependencies })) graph(dep); }
    for (const name of ["domain", "operations", "decision", "orchestrator"]) graph(`@symphony/${name}`);
    const scanned = new Set<string>();
    function imports(file: string) {
      if (scanned.has(file)) return; scanned.add(file);
      expect(file).not.toMatch(/apps\/dashboard|node_modules\/(react|vue|preact|svelte)/);
      if (!file.endsWith(".ts") || file.includes("node_modules")) return;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        let spec: string | undefined;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
        if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(source) === "require") && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) spec = n.arguments[0].text;
        if (spec) { expect(spec).not.toMatch(forbidden); const resolved = ts.resolveModuleName(spec, file, parsed.options, ts.sys).resolvedModule; if (resolved) imports(resolved.resolvedFileName); }
        ts.forEachChild(n, visit);
      }; visit(source);
    }
    for (const name of ["domain", "operations", "decision", "orchestrator"]) for (const file of files(path.join(root, "packages", name, "src")).filter(f => f.endsWith(".ts"))) imports(file);
  });
  it("checks actual production module graph excludes Node/demo/source code", async () => {
    const seen: string[] = [];
    await build({ configFile: path.join(root, "apps/dashboard/vite.config.ts"), logLevel: "silent", build: { write: false }, plugins: [{ name: "inspect-browser", moduleParsed(info) { seen.push(info.id); } }] });
    expect(seen.length).toBeGreaterThan(3);
    for (const id of seen) expect(id).not.toMatch(/examples\/|packages\/(operations|observability|decision|orchestrator)|node:/);
  });
});
