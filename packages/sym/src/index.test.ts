import { describe, expect, it } from "vitest";
import { PayloadKind, PROTO_VERSION, createMessage, decode, encode } from "./index.js";

describe("@symphony/sym — M0 骨架", () => {
  it("createMessage 组装一个合法消息", () => {
    const msg = createMessage({ src: "alice", dst: "bob" }, new Uint8Array([1, 2, 3]));
    expect(msg.header.id).toBeTruthy();
    expect(msg.header.protoVersion).toBe(PROTO_VERSION);
    expect(msg.header.opts).toEqual([]);
    expect(msg.payload.kind).toBe(PayloadKind.Message);
    expect(msg.payload.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("wire 编解码在 M1 之前仍未实现", () => {
    expect(() => encode(createMessage({ src: "a", dst: "b" }, new Uint8Array()))).toThrow(/M1/);
    expect(() => decode(new Uint8Array())).toThrow(/M1/);
  });
});