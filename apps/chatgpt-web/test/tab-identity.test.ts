import { describe, expect, it } from "vitest";
import { claimPreferenceKey, resolveTabId } from "../src/tab-identity";

function storage(initial?: string): Storage {
  const values = new Map<string, string>();
  if (initial) values.set("symphony_tab_id", initial);
  return { get length() { return values.size; }, clear: () => values.clear(), getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null, removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}

describe("tab admission identity", () => {
  it("rotates a concurrent duplicate and retains identity after pagehide", async () => {
    const held = new Set<string>();
    const locks = { request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { await callback({}); } finally { held.delete(name); }
    } };
    function page(sessionStorage: Storage) {
      let hide = () => {};
      const win = { sessionStorage, navigator: { locks }, addEventListener: (_event: string, callback: (event: { persisted: boolean }) => void) => { hide = () => callback({ persisted: false }); } } as unknown as Window;
      return { win, hide: () => hide() };
    }
    const first = page(storage());
    const id = await resolveTabId(first.win);
    const duplicate = page(storage(id));
    const duplicateId = await resolveTabId(duplicate.win);
    expect(duplicateId).not.toBe(id);
    expect(claimPreferenceKey("http://localhost:4040/", duplicateId)).not.toBe(claimPreferenceKey("http://localhost:4040", id));
    first.hide();
    await Promise.resolve(); await Promise.resolve();
    const reload = page(first.win.sessionStorage);
    expect(await resolveTabId(reload.win)).toBe(id);
    duplicate.hide(); reload.hide();
  });

  it("isolates tabs and normalized Bridge URLs", () => {
    expect(claimPreferenceKey("HTTP://LOCALHOST:80/", "a")).toBe(claimPreferenceKey("http://localhost", "a"));
    expect(claimPreferenceKey("http://localhost", "a")).not.toBe(claimPreferenceKey("http://localhost", "b"));
    expect(claimPreferenceKey("http://localhost", "a")).not.toBe(claimPreferenceKey("http://localhost:4040", "a"));
  });
});
