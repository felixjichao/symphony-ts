import type { AgentAttemptOptions, AgentAttemptResult } from "@symphony/agent";
import type { Issue } from "@symphony/domain";
import { OrchestratorAuthority, createOrchestratorRuntimeState } from "@symphony/orchestrator";
import { FileRetryReservationStorage } from "../src/recovery-storage";

export const retryIssue: Issue = { id: "1", identifier: "GH-1", title: "Fixture", description: "", state: "open",
  nativeRef: { repo: "fixture/durable", number: 1 }, priority: 1, branchName: null,
  url: "https://github.com/fixture/durable/issues/1", assigneeId: null, labels: [], blockedBy: [], dispatchable: true, createdAt: 0, updatedAt: 0 };
export function makeRetryHarness(file: string, now = 10000, monotonic = 500, onLaunch?: () => void) {
  const timers: { delay: number; callback: () => void; cancelled: boolean }[] = [];
  const store = new FileRetryReservationStorage(file);
  const state = createOrchestratorRuntimeState({ pollIntervalMs: 1000, maxConcurrentAgents: 1 });
  let launches = 0;
  let cleanupCalls = 0;
  let visible: readonly Issue[] = [retryIssue];
  let admission: Issue | null = retryIssue;
  let unavailable = false;
  const authority = new OrchestratorAuthority({ state,
    policy: { activeStates: ["open"], terminalStates: ["closed"], requiredLabels: [], maxConcurrentAgentsByState: {} },
    tracker: { fetchIssuesByStates: async states => visible.filter(issue => states.includes(issue.state)), fetchIssuesByIds: async () => { if (unavailable) throw new Error("offline"); return visible; } },
    refreshDispatch: async () => admission,
    createAttemptOptions: context => ({ issue: context.issue, attempt: context.attempt, signal: context.signal }) as AgentAttemptOptions,
    runner: options => {
      launches++; onLaunch?.();
      return new Promise<AgentAttemptResult>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("fixture stopped")), { once: true });
      });
    },
    resolveWorkspacePath: () => "/fixture/workspace", retryStorage: store,
    now: () => now, monotonicNow: () => monotonic,
    retry: { cleanupWorkspace: { removeWorkspace: async () => { cleanupCalls++; return { status: "missing" as const }; } }, maxRetryBackoffMs: () => 300000, scheduler: {
      schedule: (delay, callback) => { const t = { delay, callback, cancelled: false }; timers.push(t); return t; },
      cancel: handle => { const t = handle as typeof timers[number]; t.cancelled = true; },
    } },
  });
  return { authority, state, store, timers, get launches() { return launches; }, get cleanupCalls() { return cleanupCalls; },
    setVisible(value: readonly Issue[]) { visible = value; }, setAdmission(value: Issue | null) { admission = value; },
    setUnavailable() { unavailable = true; } };
}
if (process.env["RETRY_FIXTURE_FILE"]) {
  const h = makeRetryHarness(process.env["RETRY_FIXTURE_FILE"], 10000, 500,
    () => process.kill(process.pid, "SIGKILL"));
  if (process.env["RETRY_FIXTURE_LAUNCH"] === "1") h.authority.dispatchIssue(retryIssue);
  else {
    h.authority.scheduleRetry({ issueId: "1", identifier: "GH-1", issueUrl: retryIssue.url, attempt: 4,
      kind: "failure", error: "fixture failure" });
    process.kill(process.pid, "SIGKILL");
  }
}
