import { expect, it } from "vitest";
import { projectOperationalSnapshot, type WorkProjection, type OperationalAnomaly } from "./index";
const fresh = { status: "fresh", observedAt: 1, lastAttemptAt: 1 } as const;
function work(attention: WorkProjection["attention"], key: string): WorkProjection {
  return { key: { provider: "github", key }, workItem: { identifier: key, title: null, url: null }, phase: "coding", attention, waiting: null, planning: null, execution: null, pullRequest: null, ci: null, review: null, freshness: { github: fresh, runtime: fresh, decision: fresh }, evidence: [] };
}
it("counts exactly degraded attention and the final canonical anomaly set including unscoped entries", () => {
  const anomaly: OperationalAnomaly = { code: "review_target_head_mismatch", severity: "warning", workKey: null, message: "unscoped", detectedAt: 1 };
  const input = { generatedAt: 5, work: [work("needs_human", "o/a#1"), work("failed", "o/a#2"), work("degraded", "o/a#3")], anomalies: [anomaly, { ...anomaly }, { ...anomaly, message: "another" }] };
  const result = projectOperationalSnapshot(input); expect(result.summary).toEqual({ active: 3, waiting: 0, retrying: 0, needsHuman: 1, degradedWork: 1, anomalyCount: result.anomalies.length }); expect(result.anomalies.length).toBeGreaterThan(0); expect(result.anomalies.length).toBeLessThan(3);
  expect(projectOperationalSnapshot({ ...input, anomalies: [...input.anomalies].reverse(), work: [...input.work].reverse() })).toEqual(result);
  expect(projectOperationalSnapshot({ generatedAt: 5, work: [] }).summary).toMatchObject({ degradedWork: 0, anomalyCount: 0 });
});
