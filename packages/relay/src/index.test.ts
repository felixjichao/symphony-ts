import { describe, expect, it } from "vitest";
import { Relay, pickBackend, type RelayRule } from "./index.js";

describe("@symphony/relay — M0 骨架", () => {
  const rule: RelayRule = {
    service: "symphony",
    backends: [
      { host: "gw-1", port: 4589 },
      { host: "gw-2", port: 4589 },
    ],
  };

  it("轮询选择后端", () => {
    expect(pickBackend(rule, 0)).toEqual({ host: "gw-1", port: 4589 });
    expect(pickBackend(rule, 1)).toEqual({ host: "gw-2", port: 4589 });
  });

  it("无后端抛错", () => {
    expect(() => pickBackend({ service: "s", backends: [] }, 0)).toThrow(/可用后端/);
  });

  it("按服务查找规则", () => {
    const relay = new Relay([rule]);
    expect(relay.findRule("symphony")?.backends.length).toBe(2);
    expect(relay.findRule("other")).toBeUndefined();
  });
});