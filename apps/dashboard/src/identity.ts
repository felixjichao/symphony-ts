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

// Presentation identity only. Observation/entity timestamps change on each query round.
export function evidenceIdentity(item: ProjectionEvidence): string {
  return JSON.stringify([item.source, item.instance, item.code, item.role, item.ruleId,
    item.workKey?.provider, item.workKey?.key, item.sessionId, item.taskId, item.resultId,
    item.revision, item.target?.repository, item.target?.prNumber, item.target?.headSha,
    item.headSha, item.field, item.value === undefined, item.value, item.detail, item.freshnessStatus]);
}
export function anomalyIdentity(item: OperationalAnomaly): string {
  return JSON.stringify([item.workKey?.provider, item.workKey?.key, item.code, item.message]);
}
let ambiguousRender = 0;
export function diagnosticIds(identities: readonly string[], namespace: string): readonly string[] {
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return identities.map(identity => {
    // Identical breadcrumbs have no independent durable identity. Do not transfer
    // focus/open state between indistinguishable occurrences across snapshots.
    const occurrence = counts.get(identity) === 1 ? "stable" : `ambiguous-${++ambiguousRender}`;
    return `diagnostic-${encodeURIComponent(JSON.stringify([namespace, identity, occurrence]))}`;
  });
}

/** Selection only: labels are presentation buckets, never new domain conclusions. */
export function overviewGroups(snapshot: import("@symphony/operations").OperationalSnapshot): readonly (readonly [string, readonly WorkProjection[]])[] {
  const groups: WorkProjection[][] = [[], [], [], []];
  for (const work of [...snapshot.work].sort((a, b) => token(a.key).localeCompare(token(b.key)))) {
    const bucket = work.attention === "needs_human" || work.attention === "failed" ? 0
      : work.attention === "degraded" || scopedAnomalies(snapshot.anomalies, work.key).length > 0 ? 1
      : work.attention === "waiting" || work.waiting !== null ? 2 : 3;
    groups[bucket]!.push(work);
  }
  return ["需要人工 / 失败", "降级 / 异常关联", "正在等待", "其他当前工作"].map((label, index) => [label, groups[index]!] as const);
}
