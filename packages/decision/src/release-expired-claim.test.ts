import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { githubDecisionRoot } from "@symphony/domain";

import { DecisionService } from "./service";
import { DurableDecisionStore } from "./store";

interface Fixture {
  readonly service: DecisionService;
  readonly clock: { now: number; advance: (ms: number) => void };
  readonly cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "release-expired-claim-"));
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
  return {
    service,
    clock,
    cleanup: async () => {
      await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function leasedTask(fixture: Fixture): Promise<{ taskId: string; generation: number; revision: number }> {
  const root = githubDecisionRoot("felixjichao", "symphony-ts", 147);
  const session = await fixture.service.createSession(root);
  const task = await fixture.service.createPlanTask(session.id, {
    requirements: { title: "work liveness", body: "detect stranded work" },
  });
  const claimed = await fixture.service.claimTask(task.id, { owner: "chatgpt-web", ttlMs: 1_000 });
  return {
    taskId: task.id,
    generation: claimed.lease.generation,
    revision: claimed.task.revision,
  };
}

describe("DecisionService.releaseExpiredClaim (NEST-137)", () => {
  it("releases an expired claim and lets the normal executor claim it again", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      fixture.clock.advance(1_001);

      const released = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });

      expect(released.kind).toBe("released");
      if (released.kind !== "released") {
        return;
      }
      expect(released.task.status).toBe("pending");
      expect(released.task.lease).toBeNull();

      // The coordinator never becomes an executor: the ordinary claim path re-acquires it.
      const reclaimed = await fixture.service.claimTask(taskId, { owner: "chatgpt-web" });
      expect(reclaimed.lease.generation).toBe(generation + 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not release a live lease", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      fixture.clock.advance(500);

      const result = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });

      expect(result.kind).toBe("not_expired");
      expect(fixture.service.getTask(taskId)?.status).toBe("claimed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("honours a heartbeat renewal instead of stealing the lease", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      const claimed = fixture.service.getTask(taskId);
      expect(claimed?.lease).not.toBeNull();
      if (claimed?.lease == null) {
        return;
      }
      await fixture.service.heartbeatTask(taskId, {
        owner: claimed.lease.owner,
        token: claimed.lease.token,
        generation: claimed.lease.generation,
        ttlMs: 10_000,
      });

      fixture.clock.advance(2_000);
      const result = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });

      expect(result.kind).toBe("not_expired");
      expect(fixture.service.getTask(taskId)?.status).toBe("claimed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a stale claim generation", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      fixture.clock.advance(1_001);

      const result = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation + 1,
      });

      expect(result.kind).toBe("superseded");
      expect(fixture.service.getTask(taskId)?.status).toBe("claimed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a stale task revision", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      fixture.clock.advance(1_001);

      const result = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision + 1,
        expectedClaimGeneration: generation,
      });

      expect(result.kind).toBe("superseded");
      expect(fixture.service.getTask(taskId)?.status).toBe("claimed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("is idempotent: a second release of the same claim is not_expired", async () => {
    const fixture = await createFixture();
    try {
      const { taskId, generation, revision } = await leasedTask(fixture);
      fixture.clock.advance(1_001);

      const first = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });
      const second = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: revision,
        expectedClaimGeneration: generation,
      });

      expect(first.kind).toBe("released");
      expect(second.kind).toBe("not_expired");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports not_found for an unknown task", async () => {
    const fixture = await createFixture();
    try {
      const result = await fixture.service.releaseExpiredClaim("task-missing", {
        expectedRevision: 1,
        expectedClaimGeneration: 1,
      });
      expect(result.kind).toBe("not_found");
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not release a completed task", async () => {
    const fixture = await createFixture();
    try {
      const { taskId } = await leasedTask(fixture);
      await fixture.service.cancelTask(taskId);
      const cancelled = fixture.service.getTask(taskId);
      expect(cancelled?.status).toBe("cancelled");
      fixture.clock.advance(5_000);

      const result = await fixture.service.releaseExpiredClaim(taskId, {
        expectedRevision: cancelled?.revision ?? 0,
        expectedClaimGeneration: cancelled?.claimGeneration ?? 0,
      });

      expect(result.kind).toBe("not_expired");
      expect(fixture.service.getTask(taskId)?.status).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });
});
