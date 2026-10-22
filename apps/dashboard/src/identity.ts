import type { WorkKey, WorkProjection } from "@symphony/operations";
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
