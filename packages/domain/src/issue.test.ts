/**
 * SPEC §4.1.1 Issue / §4.2 Normalized Issue State / §11.3 归一化记录约束的类型契约
 * 与纯逻辑测试。全部经包公共入口 `./index` import（docs/testing.md 哲学 3）。
 *
 * 文件中出现的 `@ts-expect-error` 是**负例类型断言**（期望 tsc 报错）：若相应写法
 * 变成合法，unused directive 会让 typecheck 失败——这正是断言机制本身
 * （理由记录于 notes/accepted/architecture/2026-09-27-domain-contracts.md §7）。
 */
import { describe, expect, it } from "vitest";

import {
  normalizeIssueState,
  type Issue,
  type IssueBlockerRef,
  type IssueNativeRef,
} from "./index";

/** §11.3：normalized 记录所有字段必须在场——nullable 用 null、集合用空数组。 */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "provider-item-001",
    nativeRef: null,
    identifier: "ABC-123",
    title: "Example issue",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("normalizeIssueState (SPEC §4.2 Normalized Issue State)", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeIssueState("  In Progress \n")).toBe("in progress");
    expect(normalizeIssueState("TODO")).toBe("todo");
    expect(normalizeIssueState("done")).toBe("done");
  });

  it("is idempotent on already-normalized states", () => {
    const once = normalizeIssueState(" Backlog ");
    expect(normalizeIssueState(once)).toBe(once);
  });
});

describe("Issue contract (SPEC §4.1.1 / §11.3)", () => {
  it("requires every field present: nullable fields use null, collections use empty lists", () => {
    const issue = makeIssue();
    expect(Object.keys(issue).sort()).toEqual([
      "assigneeId",
      "blockedBy",
      "branchName",
      "createdAt",
      "description",
      "dispatchable",
      "id",
      "identifier",
      "labels",
      "nativeRef",
      "priority",
      "state",
      "title",
      "updatedAt",
      "url",
    ]);
    expect(issue.nativeRef).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockedBy).toEqual([]);
  });

  it("preserves provider spelling in state and nativeRef verbatim", () => {
    const nativeRef: IssueNativeRef = Object.freeze({
      projectId: "p-1",
      teamKey: "ABC",
    });
    const blocker: IssueBlockerRef = {
      id: "provider-item-000",
      identifier: "ABC-122",
      state: "Todo",
    };
    const issue = makeIssue({
      state: " In Review ",
      nativeRef,
      blockedBy: [blocker],
      labels: ["bug", "p1"],
      priority: 1,
      dispatchable: true,
      createdAt: Date.UTC(2026, 8, 1),
      updatedAt: Date.UTC(2026, 8, 2),
    });

    // §11.3：state 保留 provider 拼写，仅比较时归一化。
    expect(issue.state).toBe(" In Review ");
    expect(normalizeIssueState(issue.state)).toBe("in review");
    // §4.2：native_ref 原样透传，不解释。
    expect(issue.nativeRef).toBe(nativeRef);
    expect(issue.blockedBy[0]).toEqual(blocker);
    expect(issue.priority).toBe(1);
    expect(typeof issue.createdAt).toBe("number");
  });

  it("models (X or null) fields as required-nullable: undefined is rejected at compile time", () => {
    // 仅编译期断言：build 不执行（vitest 不做类型检查，非法赋值不能在运行时发生）。
    const build = (): Issue => ({
      ...makeIssue(),
      // @ts-expect-error SPEC "string or null"：必填且可为 null，不接受 undefined。
      description: undefined,
    });
    void build;
    expect(makeIssue().description).toBeNull();
  });

  it("requires dispatchable to be explicit (§11.3)", () => {
    const { dispatchable: _dropped, ...withoutDispatchable } = makeIssue();
    // @ts-expect-error 缺少必填字段 dispatchable——§11.3 要求显式给出。
    const issue: Issue = withoutDispatchable;
    void issue;
    expect(_dropped).toBe(false);
  });

  it("rejects non-integer-safe drift in priority typing (number or null only)", () => {
    const issue = makeIssue({ priority: 2 });
    expect(issue.priority).toBe(2);
    // @ts-expect-error priority 是 number | null，不接受 string 等 provider 原始形态。
    const bad: Issue = makeIssue({ priority: "high" });
    void bad;
  });
});
