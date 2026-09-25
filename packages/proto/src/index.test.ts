import { describe, expect, it } from "vitest";
import { UnsupportedFormatError, getTranscoder, jsonTranscoder } from "./index.js";

describe("@symphony/proto — M0 骨架", () => {
  it("JSON 转码 round-trip", () => {
    const root = { proto: "sym/0", payload: { hello: "world" } };
    const bytes = jsonTranscoder.encode(root);
    expect(jsonTranscoder.decode(bytes)).toEqual(root);
  });

  it("未知格式抛 UnsupportedFormatError", () => {
    expect(() => getTranscoder("cbor")).toThrow(UnsupportedFormatError);
  });

  it("非法信封被拒绝", () => {
    expect(() => jsonTranscoder.decode(new TextEncoder().encode("42"))).toThrow();
  });
});