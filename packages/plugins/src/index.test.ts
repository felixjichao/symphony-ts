import { describe, expect, it } from "vitest";
import { PluginRegistry, a2aInboundPlugin, createDefaultRegistry, mdnsPlugin } from "./index.js";
import { createMessage } from "@symphony/sym";

describe("@symphony/plugins — M0 骨架", () => {
  it("注册表可注册、列出、定向分发", () => {
    const registry = new PluginRegistry();
    registry.register(mdnsPlugin);
    registry.register(a2aInboundPlugin);
    expect(registry.list().sort()).toEqual(["a2a-inbound", "mdns"]);
    expect(registry.list().length).toBe(2);
  });

  it("重复注册抛错", () => {
    const registry = new PluginRegistry();
    registry.register(mdnsPlugin);
    expect(() => registry.register(mdnsPlugin)).toThrow(/已注册/);
  });

  it("默认注册表包含全部占位模块", () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toContain("mdns");
    expect(registry.list()).toContain("registry");
    expect(registry.list()).toContain("external-runner");
    const input = {
      msg: createMessage({ src: "a", dst: "b" }, new Uint8Array()),
      from: { host: "127.0.0.1", port: 1, service: "symphony" },
    };
    // 占位模块不消费任何消息。
    expect(registry.dispatch(input)).toBe(false);
  });
});