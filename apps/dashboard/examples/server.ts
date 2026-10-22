/** Same-origin static/demo host. Importing this module never starts a listener. */
import { createServer, request as upstreamRequest, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startOperationsHttpServer } from "@symphony/observability";
import type { OperationalQueryService } from "@symphony/operations";
import { createServer as createViteServer, type ViteDevServer } from "vite";
export function origin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listening address");
  return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
export async function startDemo(service: OperationalQueryService, options: { dev?: boolean; port?: number } = {}) {
  const upstream = await startOperationsHttpServer(service);
  const upstreamOrigin = origin(upstream);
  let vite: ViteDevServer | undefined;
  let site: Server | undefined;
  try {
    if (options.dev) vite = await createViteServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { middlewareMode: true }, appType: "spa" });
    site = createServer((request, response) => {
      const path = request.url?.split("?", 1)[0] ?? "/";
      if (path === "/api/operations/snapshot") {
        const proxy = upstreamRequest(new URL(request.url ?? path, upstreamOrigin), { method: request.method }, received => {
          response.writeHead(received.statusCode ?? 502, received.headers); received.pipe(response);
        });
        proxy.setTimeout(10_000, () => { proxy.destroy(); if (!response.headersSent) response.writeHead(504).end(); });
        proxy.on("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
        response.on("close", () => proxy.destroy());
        request.pipe(proxy); return;
      }
      if (path.startsWith("/api/")) { response.writeHead(404).end(); return; }
      if (vite) { vite.middlewares(request, response); return; }
      if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); response.writeHead(405).end(); return; }
      void (async () => {
        try {
          const relative = path === "/" ? "index.html" : path.slice(1);
          if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(relative)) { response.writeHead(404).end(); return; }
          const content = await readFile(new URL(`../dist/${relative}`, import.meta.url));
          response.setHeader("Content-Type", relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store"); response.writeHead(200).end(content);
        } catch { response.writeHead(404).end(); }
      })();
    });
    const listening = site;
    await new Promise<void>((resolve, reject) => { listening.once("error", reject); listening.listen(options.port ?? 0, "127.0.0.1", resolve); });
    return { url: origin(site), upstream, async stop() { await close(listening); await vite?.close(); if (upstream.listening) await close(upstream); } };
  } catch (error) {
    if (site?.listening) await close(site);
    await vite?.close(); await close(upstream); throw error;
  }
}
