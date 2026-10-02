import { describe, expect, it } from "vitest";

import type { Issue } from "@symphony/domain";

import { sortForDispatch } from "./index";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    nativeRef: null,
    identifier: "ABC-1",
    title: "Test issue",
    description: null,
    priority: 2,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: [],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1000,
    updatedAt: null,
    ...overrides,
  };
}

function ids(issues: readonly Issue[]): string[] {
  return issues.map((issue) => issue.id);
}

describe("sortForDispatch", () => {
  it("orders priority 1..4 ascending (acceptance 07)", () => {
    const issues = [
      makeIssue({ id: "p4", priority: 4 }),
      makeIssue({ id: "p1", priority: 1 }),
      makeIssue({ id: "p3", priority: 3 }),
      makeIssue({ id: "p2", priority: 2 }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("sorts non-1..4 integers and null into one trailing bucket (acceptance 08)", () => {
    const issues = [
      makeIssue({ id: "null", priority: null, identifier: "N-1" }),
      makeIssue({ id: "zero", priority: 0, identifier: "Z-1" }),
      makeIssue({ id: "five", priority: 5, identifier: "F-1" }),
      makeIssue({ id: "one", priority: 1, identifier: "O-1" }),
      makeIssue({ id: "neg", priority: -1, identifier: "G-1" }),
    ];
    // The bucket members are ordered among themselves by createdAt (all equal)
    // then identifier; the point is none of them precede priority 1.
    const sorted = sortForDispatch(issues);
    expect(sorted[0]?.id).toBe("one");
    expect(sorted.slice(1).map((issue) => issue.id)).toEqual(["five", "neg", "null", "zero"]);
  });

  it("keeps null priority after every 1..4 value", () => {
    const issues = [
      makeIssue({ id: "null", priority: null, createdAt: 1 }),
      makeIssue({ id: "p4", priority: 4, createdAt: 999 }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual(["p4", "null"]);
  });

  it("orders by oldest createdAt first, null last (acceptance 09)", () => {
    const issues = [
      makeIssue({ id: "new", priority: 1, createdAt: 3000 }),
      makeIssue({ id: "none", priority: 1, createdAt: null }),
      makeIssue({ id: "old", priority: 1, createdAt: 1000 }),
      makeIssue({ id: "mid", priority: 1, createdAt: 2000 }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual(["old", "mid", "new", "none"]);
  });

  it("puts null createdAt last within the low priority bucket too", () => {
    const issues = [
      makeIssue({ id: "none", priority: null, createdAt: null }),
      makeIssue({ id: "dated", priority: null, createdAt: 1000 }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual(["dated", "none"]);
  });

  it("uses identifier lexicographic order as final tie-breaker", () => {
    const issues = [
      makeIssue({ id: "c", identifier: "ABC-3" }),
      makeIssue({ id: "a", identifier: "ABC-1" }),
      makeIssue({ id: "b", identifier: "ABC-2" }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual(["a", "b", "c"]);
  });

  it("applies the full priority → createdAt → identifier ordering", () => {
    const issues = [
      makeIssue({ id: "low", priority: null, createdAt: 1, identifier: "AAA-1" }),
      makeIssue({ id: "p2-new", priority: 2, createdAt: 50, identifier: "BBB-1" }),
      makeIssue({ id: "p1-b", priority: 1, createdAt: 10, identifier: "ZZZ-1" }),
      makeIssue({ id: "p1-a", priority: 1, createdAt: 10, identifier: "AAA-9" }),
      makeIssue({ id: "p1-old", priority: 1, createdAt: 5, identifier: "YYY-1" }),
    ];
    expect(ids(sortForDispatch(issues))).toEqual([
      "p1-old",
      "p1-a",
      "p1-b",
      "p2-new",
      "low",
    ]);
  });

  it("does not mutate the input array", () => {
    const issues = [
      makeIssue({ id: "b", priority: 2 }),
      makeIssue({ id: "a", priority: 1 }),
    ];
    const snapshot = ids(issues);
    const sorted = sortForDispatch(issues);
    expect(ids(issues)).toEqual(snapshot);
    expect(sorted).not.toBe(issues);
    expect(ids(sorted)).toEqual(["a", "b"]);
  });
});
