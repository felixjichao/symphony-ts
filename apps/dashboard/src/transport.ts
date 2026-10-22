import type { OperationalSnapshot } from "@symphony/operations";
import { validateSnapshot } from "./validate";
export async function readSnapshot(signal: AbortSignal): Promise<OperationalSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/operations/snapshot", { method: "GET", cache: "no-store", redirect: "error", signal });
  } catch {
    throw new Error(signal.aborted ? "请求超时或取消" : "连接失败，无法取得快照");
  }
  if (!response.ok) {
    const descriptions: Record<number, string> = { 404: "端点不存在 / 路径不匹配", 405: "方法契约不匹配，Allow: GET", 500: "operational_snapshot_failed：快照获取 / 序列化失败", 502: "网关不可达", 504: "网关超时" };
    throw new Error(`HTTP ${response.status} · ${descriptions[response.status] ?? "快照请求失败"}`);
  }
  try {
    const data: unknown = await response.json();
    validateSnapshot(data);
    return data;
  } catch { throw new Error("响应格式 / 版本不兼容"); }
}
