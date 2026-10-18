import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { githubDecisionRoot } from "@symphony/domain";

import { DecisionBridge } from "./bridge";
import { DecisionBridgeClient } from "./client";
import { DecisionService } from "./service";
import { DurableDecisionStore } from "./store";

interface Fixture {
  readonly bridge: DecisionBridge;
  readonly service: DecisionService;
  readonly store: DurableDecisionStore;
  readonly baseUrl: string;
  readonly tmpDir: string;
  readonly clock: { now: number; advance: (ms: number) => void };
  readonly close: () => Promise<void>;
}

async function startBridge(expirySweepIntervalMs = 0): Promise<Fixture> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-expiry-test-"));
  let currentTime = 1_000;
  const clock = {
    now: currentTime,
    advance: (ms: number) => {
      currentTime += ms;
      clock.now = currentTime;
    },
  };
  const store = new DurableDecisionStore({
    storeDir: tmpDir,
    clock: () => clock.now,
    defaultClaimTtlMs: 1_000,
  });
  await store.open();
  const service = new DecisionService(store, {
    clock: () => clock.now,
    defaultClaimTtlMs: 1_000,
  });
  const bridge = new DecisionBridge(service, {
    host: "127.0.0.1",
    port: 0,
    expirySweepIntervalMs,
  });
  const { port } = await bridge.start();
  return {
    bridge,
    service,
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    tmpDir,
    clock,
    close: async () => {
      await bridge.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function createClaimedTask(fixture: Fixture): Promise<{
  taskId: string;
  generation: number;
  revision: number;
}> {
  const root = githubDecisionRoot("felixjichao", "symphony-ts", 147);
  const session = await fixture.service.createSession(root);
  const task = await fixture.service.createPlanTask(session.id, {
    requirements: { title: "liveness", body: "detect stranded work" },
  });
  const claimed = await fixture.service.claimTask(task.id, { owner: "chatgpt-web", ttlMs: 1_000 });
  return {
    taskId: task.id,
    generation: claimed.lease.generation,
    revision: claimed.task.revision,
  };
}

describe("DecisionBridge expired-claim surface (NEST-137)", () => {
  it("exposes release-expired-claim over HTTP and through the client", async () => {
    const fixture = await startBridge();
    try {
      const { taskId, generation, revision } = await createClaimedTask(fixture);
      fixture.clock.advance(1_001);

      const client = new DecisionBridgeClient(fixture.baseUrl);
      const released = await client.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });

      expect(released.kind).toBe("released");
      expect(fixture.service.getTask(taskId)?.status).toBe("pending");

      const again = await client.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });
      expect(again.kind).toBe("not_expired");
    } finally {
      await fixture.close();
    }
  });

  it("rejects a request without the required credentials", async () => {
    const fixture = await startBridge();
    try {
      const { taskId } = await createClaimedTask(fixture);
      const res = await fetch(
        `${fixture.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/release-expired-claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: 1 }),
        },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await fixture.close();
    }
  });

  it("releases expired claims from the bridge's own sweep without any getNextTask call", async () => {
    const fixture = await startBridge(20);
    try {
      const { taskId } = await createClaimedTask(fixture);
      fixture.clock.advance(1_001);

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && fixture.service.getTask(taskId)?.status !== "pending") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(fixture.service.getTask(taskId)?.status).toBe("pending");
      expect(fixture.service.getTask(taskId)?.lease).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});
