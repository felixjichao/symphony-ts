import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error importing .mjs script for unit test
import { cleanupPollutedTasks, parseArgs } from "../../../scripts/cleanup-polluted-tasks.mjs";

import { githubDecisionRoot } from "@symphony/domain";
import { DecisionService } from "./service";
import { DurableDecisionStore } from "./store";

async function populateRealStore(dir: string) {
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store);
  const root99 = githubDecisionRoot("felixjichao", "symphony-ts", 99);
  const session99 = await service.createSession(root99);
  const planTask99 = await service.createPlanTask(session99.id, { operationKey: "op-plan-99-1" });
  const revTask99 = await service.createReviewTask(
    session99.id,
    {
      target: { repository: "felixjichao/symphony-ts", prNumber: 99, headSha: "1111111111111111111111111111111111111111" },
      operationKey: "op-rev-99",
    },
  );

  const root137 = githubDecisionRoot("felixjichao", "symphony-ts", 137);
  const session137 = await service.createSession(root137);
  const planTask137 = await service.createPlanTask(session137.id, { operationKey: "op-plan-137" });

  await store.close();
  return { planTask99, revTask99, planTask137 };
}

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
        const { planTask99, planTask137 } = await populateRealStore(tmpDir);

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

        expect(result.matched).toBe(1);
        expect(result.cancelled).toBe(0);
        expect(result.taskIds).toEqual([planTask99.id]);

        // File remains unchanged
        const verifyStore = new DurableDecisionStore({ storeDir: tmpDir });
        await verifyStore.open();
        try {
          expect(verifyStore.getTask(planTask99.id)?.status).toBe("pending");
          expect(verifyStore.getTask(planTask137.id)?.status).toBe("pending");
        } finally {
          await verifyStore.close();
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("refuses local modification and throws error when an active process holds the store lock", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-cleanup-lock-"));
      const store = new DurableDecisionStore({ storeDir: tmpDir });
      try {
        await populateRealStore(tmpDir);
        await store.open();
        await expect(
          cleanupPollutedTasks({
            store: tmpDir,
            session: "github:felixjichao/symphony-ts#99",
            apply: true,
          }),
        ).rejects.toThrow(/currently locked by a running process/);
      } finally {
        await store.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("apply cancels #99 pending plan tasks while leaving #137 and reviews completely untouched and preserved across transactions", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-cleanup-apply-"));
      try {
        const { planTask99, revTask99, planTask137 } = await populateRealStore(tmpDir);

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
        expect(result.taskIds).toEqual([planTask99.id]);

        // Reopen store to verify persistence and subsequent transaction safety
        const verifyStore = new DurableDecisionStore({ storeDir: tmpDir });
        await verifyStore.open();
        try {
          expect(verifyStore.getTask(planTask99.id)?.status).toBe("cancelled");
          expect(verifyStore.getPlan(planTask99.id)?.status).toBe("superseded");

          // Review task under #99 is untouched
          expect(verifyStore.getTask(revTask99.id)?.status).toBe("pending");

          // #137 plan task is untouched
          expect(verifyStore.getTask(planTask137.id)?.status).toBe("pending");

          // Run empty transaction to prove cancellation is durable and not reverted
          await verifyStore.transaction(() => {});
          expect(verifyStore.getTask(planTask99.id)?.status).toBe("cancelled");
          expect(verifyStore.getTask(planTask137.id)?.status).toBe("pending");
        } finally {
          await verifyStore.close();
        }
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
