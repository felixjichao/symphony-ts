import { getOrCreateTabId } from "./checkpoint";

/** Hold an identity lock for the lifetime of this document, never for scheduling. */
export async function resolveTabId(win: Window | null): Promise<string> {
  let id = getOrCreateTabId(win);
  if (!win?.navigator?.locks) {
    // Without a collision detector, inherited sessionStorage must not grant admission.
    id = `tab_${crypto.randomUUID()}`;
    win?.sessionStorage.setItem("symphony_tab_id", id);
    return id;
  }
  for (;;) {
    const candidate = id;
    let resolveAcquired!: (acquired: boolean | null) => void;
    const acquired = new Promise<boolean | null>(resolve => { resolveAcquired = resolve; });
    void win.navigator.locks.request(`symphony-tab:${candidate}`, { ifAvailable: true }, async lock => {
      resolveAcquired(lock !== null);
      if (lock) await new Promise<void>(resolve => {
        win.addEventListener("pagehide", event => { if (!event.persisted) resolve(); });
      });
    }).catch(() => resolveAcquired(null));
    const result = await acquired;
    if (result === true) return candidate;
    if (result === null) {
      id = `tab_${crypto.randomUUID()}`;
      win.sessionStorage.setItem("symphony_tab_id", id);
      return id;
    }
    id = `tab_${crypto.randomUUID()}`;
    win.sessionStorage.setItem("symphony_tab_id", id);
  }
}

export function claimPreferenceKey(bridgeUrl: string, tabId: string): string {
  let normalized = bridgeUrl.trim().replace(/\/+$/, "");
  try { normalized = new URL(normalized).href.replace(/\/+$/, ""); } catch { /* Keep invalid input isolated. */ }
  return `symphony_allow_new_tasks:${normalized}:${tabId}`;
}
