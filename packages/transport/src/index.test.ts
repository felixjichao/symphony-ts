import { describe, expect, it } from "vitest";
import { UdpTransport, formatAddress, parseAddress, type Address } from "./index.js";

describe("@symphony/transport — M0 骨架", () => {
  it("地址格式化/解析 round-trip", () => {
    const a: Address = { host: "127.0.0.1", port: 4589, service: "symphony" };
    expect(parseAddress(formatAddress(a))).toEqual(a);
    expect(() => parseAddress("bad")).toThrow();
  });

  it("UDP 传输可绑定到随机端口并收发数据报", async () => {
    const received: Uint8Array[] = [];
    const b = new UdpTransport({ onMessage: (data) => received.push(data) });
    const a = new UdpTransport({ onMessage: () => {} });
    const [addrA, addrB] = await Promise.all([a.ready, b.ready]);
    try {
      expect(addrB.port).toBeGreaterThan(0);
      const payload = new TextEncoder().encode("hello");
      await a.send(addrB, payload);
      await new Promise((r) => setTimeout(r, 100));
      expect(received.length).toBe(1);
      expect(received[0]).toEqual(payload);
      void addrA;
    } finally {
      await a.close();
      await b.close();
    }
  });
});