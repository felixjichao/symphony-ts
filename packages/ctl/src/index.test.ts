import { describe, expect, it } from "vitest";
import { main, parseArgs } from "./index.js";

describe("@symphony/ctl — M0 骨架", () => {
  it("解析合法参数", () => {
    const args = parseArgs(["10.0.0.1:4589:symphony", "list"]);
    expect(args?.gateway).toBe("10.0.0.1:4589:symphony");
    expect(args?.command).toBe("list");
  });

  it("非法参数返回 null", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["only-gateway"])).toBeNull();
    expect(parseArgs(["bogus", "list"])).toBeNull();
  });

  it("main 输出用法或连接提示", () => {
    expect(main([])).toContain("commands");
    expect(main(["10.0.0.1:4589:symphony", "send", "bob", "hi"])).toContain("已连接 10.0.0.1:4589:symphony");
  });
});