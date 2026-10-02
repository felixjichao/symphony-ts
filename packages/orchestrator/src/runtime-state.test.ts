import { describe, expect, it } from "vitest";

import { createInitialCodexTotals, createOrchestratorRuntimeState } from "./index";

describe("createOrchestratorRuntimeState", () => {
  it("initializes the authoritative runtime state shape (SPEC §4.1.8 / §16.1)", () => {
    const state = createOrchestratorRuntimeState({
      pollIntervalMs: 30000,
      maxConcurrentAgents: 10,
    });

    expect(state.pollIntervalMs).toBe(30000);
    expect(state.maxConcurrentAgents).toBe(10);
    expect(state.running.size).toBe(0);
    expect(state.claimed.size).toBe(0);
    expect(state.retryAttempts.size).toBe(0);
    expect(state.completed.size).toBe(0);
    expect(state.codexTotals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toBeNull();
  });

  it("returns fresh independent containers on each call", () => {
    const first = createOrchestratorRuntimeState({ pollIntervalMs: 30000, maxConcurrentAgents: 10 });
    const second = createOrchestratorRuntimeState({ pollIntervalMs: 30000, maxConcurrentAgents: 10 });

    first.claimed.add("issue-1");
    first.running.set("issue-1", {
      issue: {
        id: "issue-1",
        nativeRef: null,
        identifier: "ABC-1",
        title: "Test issue",
        description: null,
        priority: 1,
        state: "Todo",
        branchName: null,
        url: null,
        assigneeId: null,
        labels: [],
        blockedBy: [],
        dispatchable: true,
        createdAt: 1000,
        updatedAt: null,
      },
      attempt: {
        issueId: "issue-1",
        issueIdentifier: "ABC-1",
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
    first.completed.add("issue-1");
    first.codexTotals.inputTokens = 42;

    expect(second.running.size).toBe(0);
    expect(second.claimed.size).toBe(0);
    expect(second.completed.size).toBe(0);
    expect(second.codexTotals.inputTokens).toBe(0);
  });
});

describe("createInitialCodexTotals", () => {
  it("starts all counters at zero", () => {
    expect(createInitialCodexTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    });
  });
});
