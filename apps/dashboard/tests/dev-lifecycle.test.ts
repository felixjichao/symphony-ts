import { describe, expect, it, vi } from "vitest";
import { Server, connect } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDemo, close } from "../examples/server";
import { demoService } from "../examples/sources";

function trackListeners() {
  const servers = new Set<Server>();
  const listen = Server.prototype.listen;
  const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: Parameters<Server["listen"]>) {
    servers.add(this);
    return Reflect.apply(listen, this, args) as Server;
  });
  return { servers, restore: () => spy.mockRestore() };
}

describe("dev listener ownership", () => {
  it("keeps HTTP and real HMR upgrades on two loopback listeners and closes live sockets", async () => {
    const tracked = trackListeners();
    const host = await startDemo(demoService(), { dev: true });
    let socket: ReturnType<typeof connect> | undefined;
    let stopped = false;
    try {
      const addresses = [...tracked.servers].map(s => s.address());
      expect(addresses).toHaveLength(2);
      for (const address of addresses) {
        expect(address && typeof address !== "string" && address.address).toBe("127.0.0.1");
      }
      const page = await fetch(host.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("/@vite/client");
      const address = new URL(host.url);
      socket = connect(Number(address.port), "127.0.0.1");
      await once(socket, "connect");
      const response = once(socket, "data");
      socket.write(`GET / HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
      const [data] = await response;
      expect(String(data)).toContain("101 Switching Protocols");
      const closed = once(socket, "close");
      await host.stop(); stopped = true;
      await closed;
      expect([...tracked.servers].every(s => s.address() === null)).toBe(true);
    } finally {
      socket?.destroy();
      if (!stopped) await host.stop();
      tracked.restore();
    }
  }, 15_000);

  it("cleans every acquired dev listener after bind failure, then can start again", async () => {
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const tracked = trackListeners();
    try {
      await expect(startDemo(demoService(), { dev: true, port: address.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect([...tracked.servers].every(s => s.address() === null)).toBe(true);
      const host = await startDemo(demoService(), { dev: true });
      await host.stop();
      expect([...tracked.servers].every(s => s.address() === null)).toBe(true);
    } finally {
      tracked.restore();
      await close(occupied);
    }
  }, 15_000);
});
