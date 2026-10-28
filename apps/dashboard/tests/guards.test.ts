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
  it.each([
    'import type { SourceFreshness as Alias } from "@symphony/operations"; const forged: Alias = {status:"stale",observedAt:1,lastAttemptAt:2};',
    'import type { OperationalAnomaly as Alias } from "@symphony/operations"; const forged: Alias = {code:"invented",severity:"error",workKey:null,message:"forged",detectedAt:1};',
    'import type { SourceFreshnessStatus } from "@symphony/operations"; function infer(): SourceFreshnessStatus { return "stale"; }',
    'import type { OperationalAnomaly } from "@symphony/operations"; function infer(): OperationalAnomaly["severity"] { return "error"; }',
    'import type { OperationalAnomaly } from "@symphony/operations"; declare const anomaly: OperationalAnomaly; anomaly["severity"] = "warning";',
  ])("rejects typed diagnostic constructions, writes and conclusion helpers: %s", body => {
    const config = ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const name = path.join(root, "apps/dashboard/src/negative.ts");
    const host = ts.createCompilerHost(parsed.options); const original = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) => file === name ? ts.createSourceFile(file, body, language, true) : original(file, language, onError, fresh);
    expect(projectionWrites(ts.createProgram([name], parsed.options, host), path.join(root, "apps/dashboard/src")).length).toBeGreaterThan(0);
  });
  it("locks approved shape/format/rank helpers to a closed implementation", () => {
    // Updating these fingerprints requires reviewing the helper and its negative cases.
    const approved: Record<string, string> = {"explorer.ts": "6a9d0f280443d288b73d858c054bf4a2b8f6b1535e5d14b9f56cddfe5c951326", "overview.ts": "06c84b516e621492c1b602a4daf4abb75cad1b9f235d38df59388ab220ea98f9", "primitives.ts": "632a9c21ae837509d69a13aa228af220c58decc0bb827b5264d102ecb65ea298", "identity.ts": "24248436240094cd957bb9df3514b108f230b520082852adbe6c38a7d79933f1", "presentation.ts": "603a0fab571eea7fc51ec9c74010821bfa0659c9b4b893825c332a34403d4d61", "validate.ts": "061dda844bf4a06694d478a90dd6b1278c92091b6fe6a3d7adff2c34b8268250", "dom.ts": "8f759452e1c4bff636f4224bb4bcc66a90e7e7f72d3372ddd8b71e44dd7188e1", "detail.ts": "b32a3768063921b63efa52069d8516a9c95b45fa3db6f826baa9ac414a999013", "evidence.ts": "f8e3990874bbdeed5ab4b69cb6e6f344cf688b9bc76659ac9ae005f6308e472c", "anomaly.ts": "2488f905e8949e2811c290b9e9eab3105837e082a00c19d95d1219f8e42df653"};
    for (const [name, digest] of Object.entries(approved)) expect(createHash("sha256").update(readFileSync(path.join(root, "apps/dashboard/src", name))).digest("hex"), name).toBe(digest);
  });
  it("checks every browser module, including local helpers", () => {
    const allowed = ["identity.ts", "presentation.ts", "transport.ts", "validate.ts", "polling.ts", "view.ts", "main.ts", "dom.ts", "detail.ts", "evidence.ts", "anomaly.ts", "routing.ts", "primitives.ts", "overview.ts", "explorer.ts"];
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
  it.each([
    'const {code: c} = entry; const alias = c; return alias ? "needs_human" : "normal";',
    'const signal = entry["f" + "ield"]; return choose(signal);',
    'const {value: signal} = w.evidence[0]; const alias = signal; if (alias) return "needs_human";',
    'const code = w.evidence[0]["ruleId"]; return code === "ci_success" ? "review" : "unknown";',
    'const severity = w.anomalies[0].severity; if (severity === "error") return "degraded";',
    'let stamp; stamp = w.freshness.decision.observedAt; return Date.now() - stamp > 1000 ? "stale" : "fresh";',
    'const {taskId: id} = w.review.task; return id === w.review.result.taskId ? "approved_current_head" : "unknown";',
    'const {revision: rev} = w.review.result; return rev === w.review.task.revision ? "approved_current_head" : "unknown";',
    'const x = w.review.result.outcome.target; return choose(x);',
    'return {code: "review_target_head_mismatch", severity: "warning"};',
    'return {freshnessStatus: "stale"};',
  ])("rejects diagnostics-derived semantics in every new renderer: %s", body => {
    for (const name of ["detail.ts", "evidence.ts", "anomaly.ts", "overview.ts"]) expect(browserErrors(name, `function inferred(w) { ${body} }`).length).toBeGreaterThan(0);
  });
  it.each(["detail.ts", "evidence.ts", "anomaly.ts", "overview.ts"])("rejects fetch aliases in %s", name => {
    expect(browserErrors(name, 'const {fetch: send} = window; send("/mutate");')).toContain("fetch capability reference outside fixed invocation");
  });
  it.each([
    'return w.ci.status === "success" ? "review" : "coding";',
    'return w.review.task.target.headSha === w.pullRequest.headSha;',
    'return w.waiting.reason ? "needs_human" : "normal";',
    'return w.anomalies.length ? "degraded" : "healthy";',
    'return Date.now() - w.observedAt > 1000 ? "stale" : "fresh";',
  ])("rejects lower-level derivation inside primitive modules: %s", body => {
    expect(browserErrors("primitives.ts", `function infer(w) { ${body} }`)).toContain("lower-level fact/conclusion in primitive");
  });
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
