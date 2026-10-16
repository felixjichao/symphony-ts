import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error importing .mjs script for unit test
import { cleanupPollutedTasks, parseArgs } from "../../../scripts/cleanup-polluted-tasks.mjs";

describe("cleanup-polluted-tasks script", () => {
  it("parses CLI arguments correctly and handles defaults and conflicts", () => {
    const defaultParsed = parseArgs([]);
    expect(defaultParsed.session).toBe("github:felixjichao/symphony-ts#99");
    expect(defaultParsed.apply).toBe(false);
    expect(defaultParsed.store).toBeNull();
    expect(defaultParsed.bridgeUrl).toBeNull();

    const customParsed = parseArgs([
      "--store", "/tmp/store",
      "--session", "github:org/repo#42",
      "--apply",
    ]);
    expect(customParsed.store).toBe("/tmp/store");
    expect(customParsed.session).toBe("github:org/repo#42");
    expect(customParsed.apply).toBe(true);

    expect(() => parseArgs(["--unknown-flag"])).toThrow("Unknown argument");
  });

  it("fails fast when options conflict or store/bridge is missing", async () => {
    await expect(
      cleanupPollutedTasks({
        store: "/tmp/store",
        bridgeUrl: "http://127.0.0.1:4040",
        session: "github:felixjichao/symphony-ts#99",
        apply: false,
      }),
    ).rejects.toThrow("Cannot specify both --store and --bridge-url");

    await expect(
      cleanupPollutedTasks({
        session: "github:felixjichao/symphony-ts#99",
        apply: false,
      }),
    ).rejects.toThrow("Must specify either --store <dir> or --bridge-url <url>");
  });

  describe("local store cleanup", () => {
    it("dry-run identifies #99 pending plan tasks without modifying store or touching #137", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-cleanup-test-"));
      try {
        const storePath = path.join(tmpDir, "store.json");
        const initialData = {
          schemaVersion: 1,
          sessions: {},
          tasks: {
            "github:felixjichao/symphony-ts#99:plan:1": {
              id: "github:felixjichao/symphony-ts#99:plan:1",
              sessionId: "github:felixjichao/symphony-ts#99",
              kind: "plan",
              status: "pending",
              revision: 1,
            },
            "github:felixjichao/symphony-ts#99:plan:2": {
              id: "github:felixjichao/symphony-ts#99:plan:2",
              sessionId: "github:felixjichao/symphony-ts#99",
              kind: "plan",
              status: "running",
              revision: 2,
            },
            "github:felixjichao/symphony-ts#99:review:1": {
              id: "github:felixjichao/symphony-ts#99:review:1",
              sessionId: "github:felixjichao/symphony-ts#99",
              kind: "review",
              status: "pending",
              revision: 1,
            },
            "github:felixjichao/symphony-ts#137:plan:1": {
              id: "github:felixjichao/symphony-ts#137:plan:1",
              sessionId: "github:felixjichao/symphony-ts#137",
              kind: "plan",
              status: "pending",
              revision: 1,
            },
          },
          plans: {
            "github:felixjichao/symphony-ts#99:plan:1": {
              status: "pending",
            },
          },
        };
        await fs.writeFile(storePath, JSON.stringify(initialData, null, 2), "utf8");

        const logs: string[] = [];
        const mockIo = { log: (msg: string) => logs.push(msg) };

        const result = await cleanupPollutedTasks(
          {
            store: tmpDir,
            session: "github:felixjichao/symphony-ts#99",
            apply: false,
          },
          mockIo,
        );

        expect(result.matched).toBe(2);
        expect(result.cancelled).toBe(0);
        expect(result.taskIds).toEqual([
          "github:felixjichao/symphony-ts#99:plan:1",
          "github:felixjichao/symphony-ts#99:plan:2",
        ]);

        // File remains unchanged
        const contentAfter = await fs.readFile(storePath, "utf8");
        const dataAfter = JSON.parse(contentAfter);
        expect(dataAfter.tasks["github:felixjichao/symphony-ts#99:plan:1"].status).toBe("pending");
        expect(dataAfter.tasks["github:felixjichao/symphony-ts#137:plan:1"].status).toBe("pending");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("apply cancels #99 pending plan tasks while leaving #137 and reviews completely untouched", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-cleanup-apply-"));
      try {
        const storePath = path.join(tmpDir, "store.json");
        const initialData = {
          schemaVersion: 1,
          sessions: {},
          tasks: {
            "github:felixjichao/symphony-ts#99:plan:1": {
              id: "github:felixjichao/symphony-ts#99:plan:1",
              sessionId: "github:felixjichao/symphony-ts#99",
              kind: "plan",
              status: "pending",
              revision: 1,
            },
            "github:felixjichao/symphony-ts#99:review:1": {
              id: "github:felixjichao/symphony-ts#99:review:1",
              sessionId: "github:felixjichao/symphony-ts#99",
              kind: "review",
              status: "pending",
              revision: 1,
            },
            "github:felixjichao/symphony-ts#137:plan:1": {
              id: "github:felixjichao/symphony-ts#137:plan:1",
              sessionId: "github:felixjichao/symphony-ts#137",
              kind: "plan",
              status: "pending",
              revision: 1,
            },
          },
          plans: {
            "github:felixjichao/symphony-ts#99:plan:1": {
              status: "pending",
            },
          },
        };
        await fs.writeFile(storePath, JSON.stringify(initialData, null, 2), "utf8");

        const logs: string[] = [];
        const mockIo = { log: (msg: string) => logs.push(msg) };

        const result = await cleanupPollutedTasks(
          {
            store: tmpDir,
            session: "github:felixjichao/symphony-ts#99",
            apply: true,
          },
          mockIo,
        );

        expect(result.matched).toBe(1);
        expect(result.cancelled).toBe(1);
        expect(result.taskIds).toEqual(["github:felixjichao/symphony-ts#99:plan:1"]);

        // Verify mutations in store file
        const contentAfter = await fs.readFile(storePath, "utf8");
        const dataAfter = JSON.parse(contentAfter);
        expect(dataAfter.tasks["github:felixjichao/symphony-ts#99:plan:1"].status).toBe("cancelled");
        expect(dataAfter.plans["github:felixjichao/symphony-ts#99:plan:1"].status).toBe("superseded");

        // Review task under #99 is untouched
        expect(dataAfter.tasks["github:felixjichao/symphony-ts#99:review:1"].status).toBe("pending");

        // #137 plan task is untouched
        expect(dataAfter.tasks["github:felixjichao/symphony-ts#137:plan:1"].status).toBe("pending");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("remote bridge cleanup", () => {
    it("queries bridge and cancels matching plan tasks via HTTP", async () => {
      const cancelledIds: string[] = [];
      const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === `/v1/sessions/${encodeURIComponent("github:felixjichao/symphony-ts#99")}/tasks`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              tasks: [
                {
                  id: "github:felixjichao/symphony-ts#99:plan:5",
                  sessionId: "github:felixjichao/symphony-ts#99",
                  kind: "plan",
                  status: "pending",
                  revision: 5,
                },
                {
                  id: "github:felixjichao/symphony-ts#99:review:1",
                  sessionId: "github:felixjichao/symphony-ts#99",
                  kind: "review",
                  status: "pending",
                  revision: 1,
                },
              ],
            }),
          );
          return;
        }

        if (req.method === "POST" && req.url?.startsWith("/v1/tasks/")) {
          const taskId = decodeURIComponent(req.url.slice("/v1/tasks/".length).replace(/\/cancel$/, ""));
          cancelledIds.push(taskId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ task: { id: taskId, status: "cancelled" } }));
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as { port: number };
      const bridgeUrl = `http://127.0.0.1:${address.port}`;

      try {
        const logs: string[] = [];
        const mockIo = { log: (msg: string) => logs.push(msg) };

        const result = await cleanupPollutedTasks(
          {
            bridgeUrl,
            session: "github:felixjichao/symphony-ts#99",
            apply: true,
          },
          mockIo,
        );

        expect(result.matched).toBe(1);
        expect(result.cancelled).toBe(1);
        expect(result.taskIds).toEqual(["github:felixjichao/symphony-ts#99:plan:5"]);
        expect(cancelledIds).toEqual(["github:felixjichao/symphony-ts#99:plan:5"]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
