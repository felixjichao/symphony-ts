/** SPEC §13 adjacent / §17–18: opt-in Observation Plane composition, no control capabilities. */
import { createServer, request as requestUpstream, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatWorkKey, parseWorkKey, type WorkKey, type DecisionObservation, type GitHubObservation, type SnapshotResult } from "@symphony/domain";
import { createDecisionReader, createExecutorReader, createGitHubReader, createOperationalQueryService, createRuntimeReader,
  type ExecutorObservation, type Observation } from "@symphony/operations";
import { startOperationsHttpServer } from "@symphony/observability";
import { DefaultGhRunner, GitHubDeliveryService, type GhRunner } from "@symphony/tracker";

export interface StatusOptions {
  readonly workKeys: readonly WorkKey[];
  readonly port?: number;
  readonly assets?: string;
}
/** All ports are observations, not authorities. Tests may control external facts and time. */
export interface StatusSources {
  readonly runtime: () => SnapshotResult | Promise<SnapshotResult>;
  readonly decision?: ((key: WorkKey) => DecisionObservation | Promise<DecisionObservation>) | undefined;
  readonly github?: ((key: WorkKey) => Promise<GitHubObservation>) | undefined;
  readonly executor?: (() => Observation<readonly ExecutorObservation[]> | Promise<Observation<readonly ExecutorObservation[]>>) | undefined;
  readonly clock?: (() => number) | undefined;
  readonly maxAgeMs?: number;
}
export function parseStatusWork(value: string): WorkKey {
  const colon = value.indexOf(":");
  if (colon < 1) throw new TypeError("Expected canonical provider:work-key");
  const key = parseWorkKey({ provider: value.slice(0, colon), key: value.slice(colon + 1) });
  if (key.provider !== "github" || formatWorkKey(key) !== value) throw new TypeError("Expected canonical github:owner/repo#N");
  return key;
}
/** Public GitHub only: host must validate provider/API origin before supplying credentials.
 * Existing verified naming convention; marker + branch + repository checks stay in observeWork. */
export function githubStatusSource(runner: GhRunner = new DefaultGhRunner()): (key: WorkKey) => Promise<GitHubObservation> {
  return async key => {
    const deadline = Date.now() + 3000;
    const bounded: GhRunner = { exec: (args, options) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error("Observation budget exhausted"));
      return runner.exec(args, { ...options, timeoutMs: remaining, env: { ...options?.env, GH_HOST: "github.com" } });
    } };
    const split = key.key.lastIndexOf("#");
    const repo = key.key.slice(0, split), issueNumber = Number(key.key.slice(split + 1));
    const result = await bounded.exec(["repo", "view", repo, "--json", "nameWithOwner,defaultBranchRef"]);
    const identity = JSON.parse(result.stdout) as { nameWithOwner: string; defaultBranchRef: { name: string } | null };
    if (identity.nameWithOwner.toLowerCase() !== repo || !identity.defaultBranchRef?.name) throw new Error("Repository identity unavailable");
    const workspaceKey = `GH-${issueNumber}`;
    return new GitHubDeliveryService(bounded).observeWork({ repo, issueNumber, workspaceKey,
      headBranch: `symphony/${workspaceKey}`, baseBranch: identity.defaultBranchRef.name });
  };
}
export function createStatusQuery(options: StatusOptions, sources: StatusSources) {
  const clock = sources.clock ?? Date.now;
  const policy = (instance: string) => ({ instance, clock, maxAgeMs: sources.maxAgeMs ?? 30_000 });
  const workKeys = [...new Map(options.workKeys.map(key => { const parsed = parseWorkKey(key); return [formatWorkKey(parsed), parsed]; })).values()];
  return createOperationalQueryService({ clock, workKeys,
    runtimeReader: createRuntimeReader(policy("host"), sources.runtime),
    executorReader: createExecutorReader(policy("inventory"), sources.executor ?? null),
    getGitHubReader: key => createGitHubReader(policy(formatWorkKey(key)), sources.github ? () => sources.github!(key) : null),
    getDecisionReader: key => createDecisionReader(policy(formatWorkKey(key)), sources.decision ? () => sources.decision!(key) : null),
  });
}
function origin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing status address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
/** No listener or source access on import. stop synchronously fences admission, then drains all reads. */
export async function startStatusSurface(options: StatusOptions, sources: StatusSources) {
  const assets = options.assets ?? fileURLToPath(new URL("../status-assets/", import.meta.url));
  const index = (await readFile(`${assets}/index.html`, "utf8")).replace('id="app"', 'id="app" data-mode="production"');
  const query = createStatusQuery(options, sources);
  let stopping = false;
  const pending = new Set<Promise<unknown>>();
  const observed = { ...query, getOperationalSnapshot() {
    if (stopping) return Promise.reject(new Error("Status stopped"));
    const read = query.getOperationalSnapshot(); pending.add(read);
    void read.then(() => pending.delete(read), () => pending.delete(read));
    return read;
  } };
  const upstream = await startOperationsHttpServer(observed);
  const upstreamOrigin = origin(upstream);
  let site: Server | undefined;
  try {
    site = createServer((request, response) => {
      const pathname = request.url?.split("?", 1)[0] ?? "/";
      if (stopping) { response.writeHead(503).end(); return; }
      if (pathname === "/api/operations/snapshot") {
        const proxy = requestUpstream(`${upstreamOrigin}${pathname}`, { method: request.method }, received => {
          response.writeHead(received.statusCode ?? 502, received.headers); received.pipe(response);
        });
        proxy.setTimeout(10_000, () => proxy.destroy());
        proxy.on("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
        response.on("close", () => proxy.destroy()); request.pipe(proxy); return;
      }
      if (pathname.startsWith("/api/")) { response.writeHead(404).end(); return; }
      if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); response.writeHead(405).end(); return; }
      void (async () => {
        try {
          if (pathname !== "/" && pathname !== "/index.html" && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) { response.writeHead(404).end(); return; }
          const content = pathname === "/" || pathname === "/index.html" ? index : await readFile(`${assets}${pathname}`);
          response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store"); response.writeHead(200).end(content);
        } catch { if (!response.destroyed) response.writeHead(404).end(); }
      })();
    });
    site.on("error", () => { /* Observation failures never enter host.failure. */ });
    const listening = site;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(options.port ?? 0, "127.0.0.1", () => { listening.removeListener("error", reject); resolve(); });
    });
    let stopPromise: Promise<void> | undefined;
    return { url: origin(site), async stop() {
      stopping = true;
      stopPromise ??= (async () => {
        const closed = await Promise.allSettled([close(listening), close(upstream)]);
        await Promise.allSettled([...pending]);
        if (closed.some(result => result.status === "rejected")) throw new Error("Status cleanup failed");
      })();
      await stopPromise;
    } };
  } catch (error) {
    stopping = true;
    await Promise.allSettled([...(site ? [close(site)] : []), close(upstream)]);
    await Promise.allSettled([...pending]);
    throw error;
  }
}
