import { describe, expect, it } from "vitest";
import { echoHandler } from "./echoAgent.js";
import { createMessage, PayloadKind } from "@symphony/sym";

describe("@symphony/examples — echo Agent（M0 骨架）", () => {
  it("echo 处理器把消息回给发送方", () => {
    const req = createMessage({ src: "alice", dst: "echo" }, new TextEncoder().encode("ping"));
    const reply = echoHandler(req);
    expect(reply.route.src).toBe("echo");
    expect(reply.route.dst).toBe("alice");
    expect(reply.header.parent).toBe(req.header.id);
    expect(reply.payload.kind).toBe(PayloadKind.Message);
    expect(reply.payload.data).toEqual(req.payload.data);
  });
});