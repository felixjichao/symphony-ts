import { describe, expect, it } from "vitest";
import { deriveWorkContinuity, WorkContinuityCoordinator } from "./index";
import type { WorkContinuityObservation } from "@symphony/domain";

const key = { provider: "fixture", key: "work-1" };
const facts = (overrides: Partial<WorkContinuityObservation> = {}): WorkContinuityObservation => ({
  workKey: key, observedAt: 1000, version: "v1", active: true, stage: "coding", available: true,
  unavailableSources: [], expectedFence: { lifecycleGeneration: 2 }, owner: null,
  blocked: null, externalWait: null, scheduled: null, contradictions: [], ...overrides,
});
const owner = { id: "worker", fence: { lifecycleGeneration: 2 },
  liveness: { startedAt: 0, lastProgressAt: 950, lastObservedAt: 1000, stallPolicy: { timeoutMs: 100, policy: "reclaim" as const } } };
describe("work-level continuity", () => {
  it("derives missing executor, valid progress, boundaries, unknown, and expired lease separately", () => {
    expect(deriveWorkContinuity(facts()).status).toBe("stranded");
    expect(deriveWorkContinuity(facts({ owner })).status).toBe("healthy");
    expect(deriveWorkContinuity(facts({ owner, observedAt: 1050 })).status).toBe("healthy");
    expect(deriveWorkContinuity(facts({ owner, observedAt: 1051 })).status).toBe("stalled");
    expect(deriveWorkContinuity(facts({ owner: { ...owner, leaseExpiresAt: 2000, liveness: { ...owner.liveness, lastProgressAt: "unknown" } } })).status).toBe("unknown");
    expect(deriveWorkContinuity(facts({ owner: { ...owner, leaseExpiresAt: 1000 } })).recovery).toBe("reclaim");
  });
  it("does not reclaim blocked work, external waits, scheduled retry or failed observations", () => {
    for (const f of [facts({ blocked: "operator" }), facts({ externalWait: { system: "ci", condition: "head checks" } }),
      facts({ scheduled: { kind: "retry", id: "real-timer", due: true } }), facts({ available: false, unavailableSources: ["tracker"] })]) {
      expect(deriveWorkContinuity(f).recovery).toBe("none");
    }
    expect(deriveWorkContinuity(facts({ blocked: "operator" })).status).toBe("blocked");
    expect(deriveWorkContinuity(facts({ externalWait: { system: "ci", condition: "head checks" } })).status).toBe("external_wait");
  });
  it("does not count stale generation progress or duplicate scheduled recovery", () => {
    expect(deriveWorkContinuity(facts({ owner: { ...owner, fence: { lifecycleGeneration: 1 } } })).status).toBe("contradictory");
    expect(deriveWorkContinuity(facts({ scheduled: { kind: "recovery", id: "reclaim", due: false } })).status).toBe("scheduled");
  });
  it("re-observes before/after one bounded authority action and repeated scans converge", async () => {
    let world = facts();
    let reads = 0;
    let mutations = 0;
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key, key],
      observe: async () => { reads++; return world; },
      recover: async request => {
        expect(request.version).toBe(world.version);
        mutations++; world = facts({ owner, version: "v2" }); return "applied";
      } });
    const [result] = await coordinator.reconcile();
    expect(result?.diagnosis?.status).toBe("healthy");
    expect(reads).toBe(3);
    await Promise.all([coordinator.reconcile(), coordinator.reconcile()]);
    expect(mutations).toBe(1);
    await coordinator.stop();
    expect(await coordinator.reconcile()).toEqual([]);
  });
  it("cancels recovery after new HEAD/generation/admission facts and isolates unavailable work", async () => {
    let reads = 0;
    let mutations = 0;
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key],
      observe: async () => ++reads === 1 ? facts() : facts({ version: "new-head", blocked: "paused" }),
      recover: async () => { mutations++; return "applied"; } });
    expect((await coordinator.reconcile())[0]?.result).toBe("stale");
    expect(mutations).toBe(0);
    const failed = new WorkContinuityCoordinator({ listWork: async () => [key], observe: async () => { throw new Error("tracker offline"); }, recover: async () => { throw new Error("must not execute"); } });
    expect((await failed.reconcile())[0]?.result).toBe("observation_unavailable");
  });
  it("does not replay a mutation when the post-action read fails", async () => {
    let reads = 0;
    let mutations = 0;
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key],
      observe: async () => { if (++reads > 2) throw new Error("offline"); return facts(); },
      recover: async () => { mutations++; return "applied"; } });
    expect((await coordinator.reconcile())[0]?.result).toBe("unverified");
    expect(mutations).toBe(1);
  });
  it("stop synchronously fences recovery while a fresh read is in flight", async () => {
    let release!: (value: WorkContinuityObservation) => void;
    const pending = new Promise<WorkContinuityObservation>(r => { release = r; });
    let mutations = 0;
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key], observe: () => pending,
      recover: async () => { mutations++; return "applied"; } });
    const run = coordinator.reconcile();
    await Promise.resolve();
    const stop = coordinator.stop();
    release(facts());
    await Promise.all([run, stop]);
    expect(mutations).toBe(0);
  });
});


describe("uncertain authority outcomes across scans", () => {
  it.each(["response-lost", "readback-throws", "readback-unavailable"])("does not replay %s after time, version or heartbeat changes", async failure => {
    let reads = 0;
    let mutations = 0;
    let world = facts({ stage: "review", taskRef: { taskId: "review", revision: 10 }, owner: { ...owner, leaseExpiresAt: 1 } });
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key],
      observe: async () => {
        reads++;
        if (reads === 3 && failure === "readback-throws") throw new Error("readback lost");
        return reads === 3 && failure === "readback-unavailable" ? { ...world, available: false } : world;
      },
      recover: async () => { mutations++; if (failure === "response-lost") throw new Error("committed, response lost"); return "applied"; },
    });
    expect((await coordinator.reconcile())[0]?.result).toBe("unverified");
    for (let i = 0; i < 3; i++) {
      world = { ...world, observedAt: world.observedAt + 100000, version: `unrelated-${i}`,
        owner: { ...world.owner!, liveness: { ...world.owner!.liveness, lastObservedAt: 100000 + i } } };
      const result = (await coordinator.reconcile())[0]!;
      expect(result.result).toBe("unverified");
      expect(result.diagnosis?.next.action).toBe("require_human");
      expect(result.diagnosis?.recovery).toBe("none");
    }
    expect(reads).toBe(6);
    expect(mutations).toBe(1);
  });

  it("only authoritative resolution permits a new target decision", async () => {
    let resolved = false;
    let mutations = 0;
    let world = facts({ stage: "handoff", blocked: "paused", handoffRef: { handoffId: "h1", headSha: "head" } });
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key], observe: async () => world,
      isRecoveryResolved: async request => { expect(request.handoffRef?.handoffId).toBe("h1"); return resolved; },
      recover: async () => { mutations++; throw new Error("response lost"); } });
    await coordinator.reconcile();
    world = { ...world, handoffRef: { handoffId: "h2", headSha: "head" }, version: "new-target" };
    expect((await coordinator.reconcile())[0]?.result).toBe("unverified");
    expect(mutations).toBe(1);
    resolved = true;
    await coordinator.reconcile();
    expect(mutations).toBe(2);
  });

  it("unavailable resolution evidence retains suppression and stop fences a delayed proof", async () => {
    let mutations = 0;
    let release!: (value: boolean) => void;
    let proof: () => Promise<boolean> = async () => { throw new Error("source unavailable"); };
    const coordinator = new WorkContinuityCoordinator({ listWork: async () => [key], observe: async () => facts(),
      isRecoveryResolved: () => proof(), recover: async () => { mutations++; throw new Error("lost"); } });
    await coordinator.reconcile();
    expect((await coordinator.reconcile())[0]?.result).toBe("unverified");
    proof = () => new Promise(resolve => { release = resolve; });
    const scan = coordinator.reconcile();
    await Promise.resolve(); await Promise.resolve();
    const stop = coordinator.stop();
    release(true);
    await Promise.all([scan, stop]);
    expect(mutations).toBe(1);
  });
});
