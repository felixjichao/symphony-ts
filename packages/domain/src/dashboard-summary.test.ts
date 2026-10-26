import { expect, it } from "vitest";
import type { OperationalSnapshotSummary } from "./operations-projection";
it("keeps old schema-v1 summary values assignable while accepting additive counters", () => {
  const legacy: OperationalSnapshotSummary = { active: 2, waiting: 1, retrying: 0, needsHuman: 1 };
  const current: OperationalSnapshotSummary = { ...legacy, degradedWork: 1, anomalyCount: 3 };
  expect(legacy.degradedWork).toBeUndefined(); expect(legacy.anomalyCount).toBeUndefined(); expect(current).toMatchObject({ degradedWork: 1, anomalyCount: 3 });
});
