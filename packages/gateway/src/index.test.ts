import { describe, expect, it } from "vitest";
import { GatewayServer } from "./index.js";
import { PluginRegistry } from "@symphony/plugins";

describe("@symphony/gateway — M0 骨架", () => {
  it("网关可启动/停止，并获得可达地址", async () => {
    const g = new GatewayServer(new PluginRegistry(), { listen: { host: "127.0.0.1", port: 0 } });
    await g.start();
    expect(g.address.port).toBeGreaterThan(0);
    await g.stop();
  });

  it("未就绪时有明确报错", () => {
    const g = new GatewayServer(new PluginRegistry());
    expect(() => g.address).toThrow(/start/);
  });
});