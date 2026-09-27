/**
 * SPEC §4.1.4 Workspace / §4.2 Workspace Key 的纯逻辑与类型契约测试。
 * §4.2 的净化 + 防碰撞规则同时是 §17.2 workspace-key 验收项的纯函数层预覆盖
 * （provisioning / containment 行为仍归 `@symphony/workspace`，M3）。
 */
import { describe, expect, it } from "vitest";

import { deriveWorkspaceKey, type Workspace } from "./index";

describe("deriveWorkspaceKey (SPEC §4.2 Workspace Key)", () => {
  it("keeps identifiers unchanged by sanitization deterministic (no hash suffix)", () => {
    expect(deriveWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(deriveWorkspaceKey("a.b_C-9")).toBe("a.b_C-9");
    expect(deriveWorkspaceKey("ABC-123")).toBe(deriveWorkspaceKey("ABC-123"));
  });

  it("replaces every character outside [A-Za-z0-9._-] with underscore", () => {
    expect(deriveWorkspaceKey("feat/JIRA-1 x")).toMatch(
      /^feat_JIRA-1_x--[0-9a-f]{16}$/,
    );
    expect(deriveWorkspaceKey("id:with.dots(and)paren")).toMatch(
      /^id_with.dots_and_paren--[0-9a-f]{16}$/,
    );
  });

  it("produces keys containing only allowed workspace-key characters", () => {
    for (const identifier of ["工单-42", "a b\tc", "NEST:48#domain", "x?y*z"]) {
      expect(deriveWorkspaceKey(identifier)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it("is deterministic per identifier (stable hash of the ORIGINAL identifier)", () => {
    const first = deriveWorkspaceKey("alpha/beta");
    const second = deriveWorkspaceKey("alpha/beta");
    expect(first).toBe(second);
    const suffix = first.slice(first.lastIndexOf("--") + 2);
    // 16 个 hex 字符 = 64 bit 熵，满足 §4.2 "at least 64 bits"，且只用允许字符。
    expect(suffix).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps distinct identifiers that sanitize to the same text collision-resistant", () => {
    // §17.2：净化后同文的不同 identifier 必须得到互不相同的 key。
    const pairs: readonly [string, string][] = [
      ["a b", "a\tb"], // 都净化为 a_b，原文不同 → hash 后缀不同
      ["a/b", "a\\b"], // 同上
      ["feat/x", "feat_x"], // feat_x 无需净化；feat/x → feat_x--<hash>
    ];
    for (const [left, right] of pairs) {
      const leftKey = deriveWorkspaceKey(left);
      const rightKey = deriveWorkspaceKey(right);
      expect(leftKey).not.toBe(rightKey);
    }
  });

  it("rejects an empty identifier (SPEC §11.3 requires non-empty identifiers)", () => {
    expect(() => deriveWorkspaceKey("")).toThrow(TypeError);
  });
});

describe("Workspace contract (SPEC §4.1.4)", () => {
  it("carries absolute path, collision-resistant key and the createdNow hook gate", () => {
    const workspace: Workspace = {
      path: "/tmp/symphony_workspaces/ABC-123",
      workspaceKey: deriveWorkspaceKey("ABC-123"),
      createdNow: true,
    };
    expect(workspace.workspaceKey).toBe("ABC-123");
    expect(workspace.path.endsWith(workspace.workspaceKey)).toBe(true);
    expect(workspace.createdNow).toBe(true);
  });

  it("is a readonly value object at the type level", () => {
    const workspace: Workspace = {
      path: "/tmp/symphony_workspaces/ABC-123",
      workspaceKey: "ABC-123",
      createdNow: false,
    };
    // 仅编译期断言：mutate 不执行（reload / provisioning 语义是整体替换值对象）。
    const mutate = (w: Workspace): void => {
      // @ts-expect-error Workspace 是值对象，字段 readonly。
      w.createdNow = true;
    };
    void mutate;
    expect(workspace.createdNow).toBe(false);
  });
});
