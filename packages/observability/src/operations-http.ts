/** Thin Observation Plane transport (SPEC §13.7 / GitHub #137). */
import { createServer, type Server } from "node:http";
import type { OperationalQueryService } from "@symphony/operations";

export interface OperationsHttpOptions {
  /** Loopback by default; broader exposure is an explicit operator choice. */
  readonly host?: string;
  /** Defaults to an OS-assigned ephemeral port. */
  readonly port?: number;
}

/** Explicit startup; no authority ports, background collection, or import side effects. */
export async function startOperationsHttpServer(
  service: OperationalQueryService,
  options: OperationsHttpOptions = {},
): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const pathname = request.url?.split("?", 1)[0];
    if (pathname !== "/api/operations/snapshot") {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      response.writeHead(405).end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    void (async () => {
      try {
        const snapshot = await service.getOperationalSnapshot();
        const body = JSON.stringify(snapshot);
        if (!response.destroyed) response.writeHead(200).end(body);
      } catch {
        if (!response.destroyed) {
          response.writeHead(500).end(JSON.stringify({ error: "operational_snapshot_failed" }));
        }
      }
    })();
  });
  server.on("error", () => {
    // Runtime transport failures are observational and must not terminate the host (§13.7).
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
