import type { OperationalSnapshot, WorkProjection, SourceFreshness } from "@symphony/operations";
export const fresh: SourceFreshness = { status: "fresh", observedAt: 1, lastAttemptAt: 2 };
export function work(overrides: Partial<WorkProjection> = {}): WorkProjection {
  return { key: { provider: "github", key: "owner/a#1" }, workItem: { identifier: "owner/a#1", title: "Example", url: null }, phase: "coding", attention: "normal", waiting: null, planning: null, execution: null, pullRequest: null, ci: { status: "success" }, review: { currentHeadSha: "a".repeat(40), taskTarget: null, task: null, result: null, approval: "unknown" }, freshness: { github: fresh, runtime: fresh, decision: fresh }, evidence: [], ...overrides };
}
export function snapshot(overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return { schemaVersion: 1, generatedAt: 5, health: "healthy", summary: { active: 7, waiting: 3, retrying: 0, needsHuman: 2, degradedWork: 4, anomalyCount: 9 }, work: [work()], executors: [], sources: [{ source: "executor", instance: "demo", freshness: fresh }], anomalies: [], ...overrides };
}
export function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
