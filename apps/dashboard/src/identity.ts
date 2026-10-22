import type { WorkKey, WorkProjection, ProjectionEvidence, OperationalAnomaly, SourceStatus, ExecutorProjection } from "@symphony/operations";
export function token(key: WorkKey): string {
  return encodeURIComponent(JSON.stringify([key.provider, key.key]));
}
export function findWork(work: readonly WorkProjection[], hash: string): WorkProjection | undefined {
  try {
    const tuple: unknown = JSON.parse(decodeURIComponent(hash.replace(/^#/, "")));
    if (!Array.isArray(tuple) || tuple.length !== 2 || !tuple.every(v => typeof v === "string")) return;
    return work.find(w => w.key.provider === tuple[0] && w.key.key === tuple[1]);
  } catch { return; }
}

export function sameKey(a: WorkKey | null | undefined, b: WorkKey | null): boolean {
  return a == null ? b === null : b !== null && a.provider === b.provider && a.key === b.key;
}
export function scopedEvidence(items: readonly ProjectionEvidence[], key: WorkKey | null): readonly ProjectionEvidence[] {
  return items.filter(item => item.workKey === undefined || sameKey(item.workKey, key));
}
export function scopedAnomalies(items: readonly OperationalAnomaly[], key: WorkKey | null): readonly OperationalAnomaly[] {
  return items.filter(item => sameKey(item.workKey, key));
}
export function scopedSources(items: readonly SourceStatus[], key: WorkKey): readonly SourceStatus[] {
  return items.filter(item => sameKey(item.workKey, key));
}
export function globalSources(items: readonly SourceStatus[]): readonly SourceStatus[] {
  return items.filter(item => item.workKey == null);
}
export function scopedExecutors(items: readonly ExecutorProjection[], key: WorkKey): readonly ExecutorProjection[] {
  return items.filter(item => sameKey(item.currentWork, key));
}
export function evidenceGroups(items: readonly ProjectionEvidence[]): readonly (readonly [string, readonly ProjectionEvidence[]])[] {
  const groups = new Map<string, ProjectionEvidence[]>();
  for (const item of items) {
    const label = `${item.source} / ${item.role ?? "role 未提供"}`;
    const group = groups.get(label) ?? [];
    group.push(item); groups.set(label, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
