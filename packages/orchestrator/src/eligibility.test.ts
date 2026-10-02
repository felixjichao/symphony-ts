import { describe, expect, it } from "vitest";

import type { Issue, OrchestratorRuntimeState } from "@symphony/domain";

import {
  createOrchestratorRuntimeState,
  globalAvailableSlots,
  hasRequiredDispatchFields,
  isActiveState,
  isDispatchEligible,
  isTerminalState,
  issueRoutable,
  matchesRequiredLabels,
  normalizeLabel,
  perStateAvailableSlots,
  runningCountForState,
  type DispatchPolicy,
} from "./index";

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

function makePolicy(overrides: Partial<DispatchPolicy> = {}): DispatchPolicy {
  return {
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Cancelled"],
    requiredLabels: [],
    maxConcurrentAgentsByState: {},
    ...overrides,
  };
}

function makeRuntime(maxConcurrentAgents = 4): OrchestratorRuntimeState {
  return createOrchestratorRuntimeState({ pollIntervalMs: 30000, maxConcurrentAgents });
}

/** 把一个 issue 标记为 running（只为 slot / gating 计算提供最小 running entry）。 */
function markRunning(runtime: OrchestratorRuntimeState, issue: Issue): void {
  runtime.running.set(issue.id, {
    issue,
    attempt: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: null,
      workspacePath: "/tmp/ws",
      startedAt: 0,
      status: "streaming_turn",
    },
    session: null,
    workspacePath: "/tmp/ws",
    startedAtMs: 0,
    workerHandle: null,
  });
}

describe("normalizeLabel", () => {
  it("trims and lowercases", () => {
    expect(normalizeLabel("  Urgent  ")).toBe("urgent");
  });
});

describe("hasRequiredDispatchFields", () => {
  it("requires non-empty id / identifier / title / state", () => {
    expect(hasRequiredDispatchFields(makeIssue())).toBe(true);
    expect(hasRequiredDispatchFields(makeIssue({ id: "" }))).toBe(false);
    expect(hasRequiredDispatchFields(makeIssue({ identifier: "" }))).toBe(false);
    expect(hasRequiredDispatchFields(makeIssue({ title: "" }))).toBe(false);
    expect(hasRequiredDispatchFields(makeIssue({ state: "" }))).toBe(false);
  });
});

describe("isActiveState / isTerminalState", () => {
  it("compares normalized state on both sides", () => {
    const policy = makePolicy();
    expect(isActiveState("  in progress ", policy)).toBe(true);
    expect(isActiveState("TODO", policy)).toBe(true);
    expect(isTerminalState(" done ", policy)).toBe(true);
    expect(isTerminalState("DONE", policy)).toBe(true);
    expect(isActiveState("Done", policy)).toBe(false);
    expect(isTerminalState("Todo", policy)).toBe(false);
  });
});

describe("matchesRequiredLabels", () => {
  it("is case-insensitive and trims both configured and issue labels", () => {
    const issue = makeIssue({ labels: ["Bug", "Urgent"] });
    expect(matchesRequiredLabels(issue, makePolicy({ requiredLabels: ["bug", "  URGENT "] }))).toBe(
      true,
    );
  });

  it("fails when any required label is missing", () => {
    const issue = makeIssue({ labels: ["bug"] });
    expect(matchesRequiredLabels(issue, makePolicy({ requiredLabels: ["bug", "urgent"] }))).toBe(
      false,
    );
  });

  it("treats a blank configured label as matching nothing", () => {
    const issue = makeIssue({ labels: ["bug"] });
    expect(matchesRequiredLabels(issue, makePolicy({ requiredLabels: ["   "] }))).toBe(false);
  });

  it("passes when no labels are required", () => {
    expect(matchesRequiredLabels(makeIssue({ labels: [] }), makePolicy())).toBe(true);
  });
});

describe("issueRoutable", () => {
  it("only reflects adapter dispatchable + required labels", () => {
    const policy = makePolicy({ requiredLabels: ["bug"] });
    expect(issueRoutable(makeIssue({ labels: ["BUG"] }), policy)).toBe(true);
    expect(issueRoutable(makeIssue({ labels: ["BUG"], dispatchable: false }), policy)).toBe(false);
    expect(issueRoutable(makeIssue({ labels: [] }), policy)).toBe(false);
  });

  it("ignores state (state is checked by the surrounding algorithm)", () => {
    const terminal = makeIssue({ state: "Done" });
    expect(issueRoutable(terminal, makePolicy())).toBe(true);
  });
});

describe("globalAvailableSlots", () => {
  it("is max(limit - running_count, 0)", () => {
    const runtime = makeRuntime(2);
    expect(globalAvailableSlots(runtime)).toBe(2);
    markRunning(runtime, makeIssue({ id: "a", identifier: "A-1" }));
    expect(globalAvailableSlots(runtime)).toBe(1);
    markRunning(runtime, makeIssue({ id: "b", identifier: "B-1" }));
    expect(globalAvailableSlots(runtime)).toBe(0);
  });

  it("never goes negative", () => {
    const runtime = makeRuntime(1);
    markRunning(runtime, makeIssue({ id: "a", identifier: "A-1" }));
    markRunning(runtime, makeIssue({ id: "b", identifier: "B-1" }));
    expect(globalAvailableSlots(runtime)).toBe(0);
    expect(globalAvailableSlots(makeRuntime(0))).toBe(0);
  });
});

describe("perStateAvailableSlots", () => {
  it("uses normalized override when present, otherwise the global limit", () => {
    const runtime = makeRuntime(5);
    const inProgress = makeIssue({ id: "a", identifier: "A-1", state: "In Progress" });
    markRunning(runtime, inProgress);

    const policy = makePolicy({ maxConcurrentAgentsByState: { "in progress": 2 } });
    expect(runningCountForState(runtime, "IN PROGRESS")).toBe(1);
    expect(perStateAvailableSlots(runtime, "In Progress", policy)).toBe(1);
    // State without an override falls back to the global limit (5); the running
    // count is per-state, so a state with no running entries has the full limit.
    expect(perStateAvailableSlots(runtime, "Todo", policy)).toBe(5);

    markRunning(runtime, makeIssue({ id: "b", identifier: "B-1", state: "Todo" }));
    expect(perStateAvailableSlots(runtime, "Todo", policy)).toBe(4);
    // The override state is unaffected by the other state's running entry.
    expect(perStateAvailableSlots(runtime, "In Progress", policy)).toBe(1);
  });

  it("is non-negative even when the override is exhausted", () => {
    const runtime = makeRuntime(5);
    markRunning(runtime, makeIssue({ id: "a", identifier: "A-1", state: "Todo" }));
    markRunning(runtime, makeIssue({ id: "b", identifier: "B-1", state: "Todo" }));
    const policy = makePolicy({ maxConcurrentAgentsByState: { todo: 1 } });
    expect(perStateAvailableSlots(runtime, "Todo", policy)).toBe(0);
  });

  it("only reads own override properties (prototype-key states stay at the global limit)", () => {
    const runtime = makeRuntime(10);
    const policy = makePolicy({ maxConcurrentAgentsByState: {} });
    for (const stateName of [
      "Constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "__proto__",
    ]) {
      expect(perStateAvailableSlots(runtime, stateName, policy)).toBe(10);
      expect(Number.isNaN(perStateAvailableSlots(runtime, stateName, policy))).toBe(false);
    }
  });

  it("still honors a real own override whose key matches a prototype member", () => {
    const runtime = makeRuntime(10);
    const policy = makePolicy({ maxConcurrentAgentsByState: { constructor: 2 } });
    expect(perStateAvailableSlots(runtime, "Constructor", policy)).toBe(2);
  });
});

describe("isDispatchEligible", () => {
  it("dispatches an active, routable, unclaimed issue with free slots", () => {
    expect(isDispatchEligible(makeIssue(), makeRuntime(), makePolicy())).toBe(true);
  });

  it("rejects dispatchable=false issues (acceptance 01)", () => {
    const issue = makeIssue({ dispatchable: false });
    expect(issueRoutable(issue, makePolicy())).toBe(false);
    expect(isDispatchEligible(issue, makeRuntime(), makePolicy())).toBe(false);
  });

  it("rejects issues whose state is not active", () => {
    expect(isDispatchEligible(makeIssue({ state: "Backlog" }), makeRuntime(), makePolicy())).toBe(
      false,
    );
  });

  it("rejects issues whose state is terminal even if also listed active", () => {
    const policy = makePolicy({ activeStates: ["Todo", "Done"] });
    expect(isDispatchEligible(makeIssue({ state: "done" }), makeRuntime(), policy)).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(isDispatchEligible(makeIssue({ title: "" }), makeRuntime(), makePolicy())).toBe(false);
  });

  it("blocks duplicate dispatch while an issue is running (acceptance 04)", () => {
    const runtime = makeRuntime();
    const issue = makeIssue();
    markRunning(runtime, issue);
    expect(isDispatchEligible(issue, runtime, makePolicy())).toBe(false);
  });

  it("blocks dispatch while an issue is claimed (acceptance 04)", () => {
    const runtime = makeRuntime();
    runtime.claimed.add("issue-1");
    expect(isDispatchEligible(makeIssue(), runtime, makePolicy())).toBe(false);
  });

  it("respects global slot exhaustion", () => {
    const runtime = makeRuntime(1);
    markRunning(runtime, makeIssue({ id: "other", identifier: "OTH-1" }));
    expect(isDispatchEligible(makeIssue(), runtime, makePolicy())).toBe(false);
  });

  it("respects per-state override exhaustion", () => {
    const runtime = makeRuntime(10);
    markRunning(runtime, makeIssue({ id: "other", identifier: "OTH-1", state: "Todo" }));
    const policy = makePolicy({ maxConcurrentAgentsByState: { todo: 1 } });
    expect(isDispatchEligible(makeIssue({ state: "Todo" }), runtime, policy)).toBe(false);
    // A different state still has slots.
    expect(isDispatchEligible(makeIssue({ state: "In Progress" }), runtime, policy)).toBe(true);
  });

  it("does not treat completed issues as permanently suppressed (acceptance 10)", () => {
    const runtime = makeRuntime();
    runtime.completed.add("issue-1");
    expect(isDispatchEligible(makeIssue(), runtime, makePolicy())).toBe(true);
  });

  it("dispatches a prototype-key state when no own override is configured (regression)", () => {
    const runtime = makeRuntime(10);
    const policy = makePolicy({ activeStates: ["Constructor"], maxConcurrentAgentsByState: {} });
    const issue = makeIssue({ state: "Constructor" });

    expect(perStateAvailableSlots(runtime, issue.state, policy)).toBe(10);
    expect(isDispatchEligible(issue, runtime, policy)).toBe(true);
  });

  it("carries no side effects on state", () => {
    const runtime = makeRuntime();
    const policy = makePolicy({ requiredLabels: ["bug"] });
    const issue = makeIssue({ labels: ["bug"] });

    const before = {
      running: runtime.running.size,
      claimed: runtime.claimed.size,
      retry: runtime.retryAttempts.size,
      completed: runtime.completed.size,
    };
    isDispatchEligible(issue, runtime, policy);
    issueRoutable(issue, policy);
    matchesRequiredLabels(issue, policy);
    globalAvailableSlots(runtime);
    perStateAvailableSlots(runtime, "Todo", policy);

    expect({
      running: runtime.running.size,
      claimed: runtime.claimed.size,
      retry: runtime.retryAttempts.size,
      completed: runtime.completed.size,
    }).toEqual(before);
  });
});
