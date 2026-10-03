import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

export const cliRoot = fileURLToPath(new URL("../", import.meta.url));
export const binPath = fileURLToPath(new URL("../dist/bin/symphony.js", import.meta.url));
const cert = fileURLToPath(new URL("../test-fixtures/localhost-cert.pem", import.meta.url));
const key = fileURLToPath(new URL("../test-fixtures/localhost-key.pem", import.meta.url));
export const appServer = fileURLToPath(new URL("../../../packages/agent/test-fixtures/app-server.mjs", import.meta.url));

export async function httpsTracker() {
  const requests: URL[] = [];
  const events = new EventEmitter();
  let issueEnabled = false;
  let terminalBarrier: ServerResponse | undefined;
  let holdTerminal = false;
  const issue = { id: 101, node_id: "fixture-101", number: 1, title: "Lifecycle issue", body: "test", state: "open", labels: [], assignees: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/acme/widget/issues/1" };
  let currentNumber = 1;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://localhost");
    requests.push(url);
    res.setHeader("content-type", "application/json");
    if (holdTerminal && url.searchParams.get("state") === "closed") {
      terminalBarrier = res;
      events.emit("request");
      return;
    }
    const match = /\/issues\/(\d+)$/.exec(url.pathname);
    const payload = match ? { ...issue, number: Number(match[1]) } : issueEnabled && url.searchParams.get("state") === "open" ? [{ ...issue, number: currentNumber }] : [];
    res.end(JSON.stringify(payload));
    events.emit("request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `https://127.0.0.1:${address.port}`,
    requests,
    enableIssue(number = 1) { issueEnabled = true; currentNumber = number; },
    holdStartup() { holdTerminal = true; },
    releaseStartup() { holdTerminal = false; terminalBarrier?.end("[]"); },
    async waitForRequest(predicate: (url: URL) => boolean, afterIndex = 0) {
      if (requests.slice(afterIndex).some(predicate)) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { events.removeListener("request", check); reject(new Error("Tracker request barrier timed out")); }, 10000);
        function check() {
          if (!requests.slice(afterIndex).some(predicate)) return;
          clearTimeout(timer); events.removeListener("request", check); resolve();
        }
        events.on("request", check);
      });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export function startProcess(args: string[], cwd?: string, executable = binPath) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let closed = false;
  const events = new EventEmitter();
  const result = new Promise<ProcessResult>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Process timeout: ${stderr}`)); }, 15000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); events.emit("output"); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); events.emit("output"); });
    child.on("close", (code, signal) => { closed = true; clearTimeout(timer); events.emit("output"); resolve({ code, signal, stdout, stderr }); });
  });
  // Install a rejection observer even while the caller is at a readiness barrier.
  void result.catch(() => {});
  return {
    child: child as ChildProcess,
    result,
    get stderr() { return stderr; },
    async waitForOutput(text: string) {
      if (stderr.includes(text) || stdout.includes(text)) return;
      if (closed) throw new Error(`Early exit: ${stderr}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { events.removeListener("output", check); reject(new Error(`Output barrier ${text}: ${stderr}`)); }, 10000);
        function check() {
          if (stderr.includes(text) || stdout.includes(text)) { clearTimeout(timer); events.removeListener("output", check); resolve(); }
          else if (closed) { clearTimeout(timer); events.removeListener("output", check); reject(new Error(`Early exit: ${stderr}`)); }
        }
        events.on("output", check);
      });
    },
    async close() {
      if (!closed) child.kill("SIGTERM");
      try { await result; } finally {
        if (!closed) { child.kill("SIGKILL"); await once(child, "close"); }
      }
    },
  };
}

export function workflow(root: string, apiUrl: string, options: { command?: string; prompt?: string; afterRun?: string } = {}) {
  return `---\ntracker:\n  kind: github\n  provider:\n    repo: acme/widget\n    token: fixture-secret\n    api_url: ${apiUrl}\nworkspace:\n  root: ${root}\npolling:\n  interval_ms: 30\nagent:\n  max_turns: 1\ncodex:\n  command: ${JSON.stringify(options.command ?? "echo test")}\n${options.afterRun ? `hooks:\n  after_run: ${JSON.stringify(options.afterRun)}\n` : ""}---\n${options.prompt ?? "Handle {{ issue.identifier }}"}\n`;
}
