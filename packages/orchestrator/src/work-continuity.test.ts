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
