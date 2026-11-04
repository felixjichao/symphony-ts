import type { DeliveryBudgetAuthorizationReceipt, DeliveryBudgetCheckpoint, DeliveryBudgetExhaustion, DeliveryBudgetPhase, DeliveryBudgetState, PersistedDeliveryState } from "./delivery";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => uint(value) && value <= 8_640_000_000_000_000;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const phases: readonly DeliveryBudgetPhase[] = ["ci", "review", "repair", "validation"];

export function isDeliveryBudgetExhaustion(value: unknown): value is DeliveryBudgetExhaustion {
  const r = record(value);
  return !!r && (r["budgetKind"] === "total" || r["budgetKind"] === "phase")
    && (r["phase"] === null ? r["phaseIdentity"] === null && r["budgetKind"] === "total"
      : phases.includes(r["phase"] as DeliveryBudgetPhase) && text(r["phaseIdentity"]))
    && timestamp(r["startedAtMs"]) && timestamp(r["deadlineAtMs"]) && timestamp(r["observedAtMs"])
    && r["startedAtMs"] <= r["deadlineAtMs"] && r["observedAtMs"] >= r["deadlineAtMs"]
    && uint(r["elapsedMs"]) && r["elapsedMs"] === Math.max(0, r["observedAtMs"] - r["startedAtMs"])
    && uint(r["limitMs"]) && uint(r["remainingMs"]) && r["remainingMs"] === 0
    && (r["headSha"] === null || text(r["headSha"])) && text(r["recoveryInstructions"])
    && (r["startedAtEstimated"] === undefined || typeof r["startedAtEstimated"] === "boolean");
}

/** Evaluate durable authority at one observation time; total exhaustion wins ties. */
export function evaluateDeliveryBudget(budget: DeliveryBudgetState, nowMs: number, headSha: string | null): DeliveryBudgetExhaustion | null {
  if (!isDeliveryBudgetState(budget) || !timestamp(nowMs) || (headSha !== null && !text(headSha))) {
    throw new Error("Invalid delivery budget observation");
  }
  const phase = budget.activePhase;
  const totalExhausted = nowMs >= budget.totalDeadlineAtMs;
  if (!totalExhausted && (!phase || nowMs < phase.deadlineAtMs)) return null;
  const startedAtMs = totalExhausted ? budget.totalStartedAtMs : phase!.startedAtMs;
  const deadlineAtMs = totalExhausted ? budget.totalDeadlineAtMs : phase!.deadlineAtMs;
  return {
    budgetKind: totalExhausted ? "total" : "phase", phase: phase?.phase ?? null, phaseIdentity: phase?.identity ?? null,
    startedAtMs, deadlineAtMs, observedAtMs: nowMs, elapsedMs: Math.max(0, nowMs - startedAtMs),
    limitMs: totalExhausted ? budget.totalDeadlineAtMs - budget.totalStartedAtMs : budget.phaseLimitsMs[phase!.phase],
    remainingMs: Math.max(0, deadlineAtMs - nowMs), headSha,
    recoveryInstructions: "Inspect with delivery-skill budget-inspect, explicitly authorize the required budget with budget-authorize, then resume after resolving safety gates.",
    ...(totalExhausted && budget.totalStartEstimated ? { startedAtEstimated: true } : {}),
  };
}

/** Preserve the legacy absolute deadline; its original start is only an estimate. */
export function migrateLegacyDeliveryBudget(state: PersistedDeliveryState): DeliveryBudgetState {
  const durationSeconds = state.continuation?.maxWaitSeconds ?? state.handoff?.maxWaitSeconds;
  const repairLimit = state.continuation?.maxRepairAttempts ?? state.handoff?.maxRepairs;
  const deadline = state.deadlineTimestampMs;
  // Conflicting historical claims cannot establish which allowance was
  // authorized. Never choose the more convenient one during recovery.
  if (state.continuation && state.handoff
    && (state.handoff.maxWaitSeconds !== undefined && state.continuation.maxWaitSeconds !== state.handoff.maxWaitSeconds
      || state.continuation.maxRepairAttempts !== state.handoff.maxRepairs)) {
    throw new Error("Ambiguous legacy delivery budget: conflicting authority records");
  }
  if (!uint(deadline) || !uint(durationSeconds) || !uint(repairLimit) || !uint(state.spentRepairs)
    || !uint(state.spentWaitSeconds) || state.spentRepairs > repairLimit
    || !text(state.repo) || !text(state.workspaceKey) || !uint(state.issueNumber) || state.issueNumber === 0) {
    throw new Error("Ambiguous legacy delivery budget");
  }
  const durationMs = durationSeconds * 1_000;
  if (!Number.isSafeInteger(durationMs) || deadline < durationMs) throw new Error("Invalid legacy delivery deadline");
  const start = deadline - durationMs;
  const limit = Math.max(1, durationMs);
  const continuation = state.continuation;
  let activePhase: DeliveryBudgetCheckpoint | null = null;
  if (continuation && continuation.phase !== "ready") {
    const phase: DeliveryBudgetPhase = continuation.phase === "ci" || continuation.phase === "ci_passed" ? "ci"
      : continuation.phase === "repair_pending" ? "repair" : "review";
    const identity = phase === "ci" ? continuation.headSha : phase === "repair" ? `repair:${state.spentRepairs}`
      : continuation.reviewOperationKey ?? `${continuation.headSha}:legacy-review`;
    if (!text(identity)) throw new Error("Ambiguous legacy phase identity");
    activePhase = { phase, identity, startedAtMs: start, deadlineAtMs: deadline, authorizationGeneration: 0 };
  }
  const budget: DeliveryBudgetState = { schemaVersion: 1,
    deliveryRoundId: `legacy:${state.repo.toLowerCase()}:${state.issueNumber}:${state.workspaceKey}:${deadline}`,
    totalStartedAtMs: start, totalStartEstimated: true, totalDeadlineAtMs: deadline,
    phaseLimitsMs: { ci: limit, review: limit, repair: limit, validation: limit }, activePhase,
    phaseHistory: [], spentRepairs: state.spentRepairs, repairLimit, authorizationGeneration: 0, authorizations: [] };
  if (!isDeliveryBudgetState(budget)) throw new Error("Invalid legacy delivery budget");
  return budget;
}

/** Validate untrusted durable budget data before it can confer authority. */
export function isDeliveryBudgetState(value: unknown): value is DeliveryBudgetState {
  const b = record(value);
  const limits = record(b?.["phaseLimitsMs"]);
  if (!b || b["schemaVersion"] !== 1 || !text(b["deliveryRoundId"]) || !limits
    || !phases.every(p => uint(limits[p]) && limits[p] > 0)
    || !timestamp(b["totalStartedAtMs"]) || !timestamp(b["totalDeadlineAtMs"])
    || (b["totalStartEstimated"] !== undefined && typeof b["totalStartEstimated"] !== "boolean")
    || b["totalDeadlineAtMs"] < b["totalStartedAtMs"]
    || !uint(b["spentRepairs"]) || !uint(b["repairLimit"]) || b["spentRepairs"] > b["repairLimit"]
    || !uint(b["authorizationGeneration"]) || !Array.isArray(b["phaseHistory"]) || !Array.isArray(b["authorizations"])) return false;
  const generation = b["authorizationGeneration"];
  const checkpoint = (value: unknown): boolean => {
    const p = record(value);
    if (!p || !phases.includes(p["phase"] as DeliveryBudgetPhase) || !text(p["identity"])
      || !timestamp(p["startedAtMs"]) || !timestamp(p["deadlineAtMs"]) || !uint(p["authorizationGeneration"])) return false;
    const limit = limits[p["phase"] as DeliveryBudgetPhase] as number;
    return p["startedAtMs"] >= (b["totalStartedAtMs"] as number) && p["deadlineAtMs"] >= p["startedAtMs"]
      && p["deadlineAtMs"] <= (b["totalDeadlineAtMs"] as number)
      && p["deadlineAtMs"] - p["startedAtMs"] <= limit && p["authorizationGeneration"] <= generation
      && (p["completedAtMs"] === undefined || timestamp(p["completedAtMs"])
        && p["completedAtMs"] >= p["startedAtMs"] && p["completedAtMs"] < p["deadlineAtMs"]);
  };
  if (b["activePhase"] !== null && !checkpoint(b["activePhase"]) || !b["phaseHistory"].every(checkpoint)) return false;
  let priorGeneration = 0;
  let previousDeadline: number | undefined;
  let previousLimit: number | undefined;
  let previousSpent = 0;
  const ids = new Set<string>();
  for (const value of b["authorizations"]) {
    const a = record(value);
    const renewed = record(a?.["renewedPhase"]);
    if (!a || !text(a["id"]) || ids.has(a["id"]) || !text(a["reason"])
      || !uint(a["generation"]) || a["generation"] !== priorGeneration + 1
      || (a["expectedStateGeneration"] !== undefined && !uint(a["expectedStateGeneration"]))
      || !timestamp(a["previousDeadlineAtMs"]) || !timestamp(a["newDeadlineAtMs"]) || a["newDeadlineAtMs"] < a["previousDeadlineAtMs"]
      || !uint(a["previousRepairLimit"]) || !uint(a["newRepairLimit"]) || a["newRepairLimit"] < a["previousRepairLimit"]
      || !uint(a["spentRepairs"]) || a["spentRepairs"] > a["previousRepairLimit"] || a["spentRepairs"] < previousSpent
      || a["spentRepairs"] > b["spentRepairs"] || !timestamp(a["authorizedAtMs"]) || a["authorizedAtMs"] >= a["newDeadlineAtMs"]
      || (a["operator"] !== undefined && !text(a["operator"]))
      || (a["renewedPhase"] !== undefined && !checkpoint(a["renewedPhase"]))
      || (renewed !== null && (renewed["authorizationGeneration"] !== a["generation"]
        || renewed["startedAtMs"] !== a["authorizedAtMs"] || !uint(renewed["deadlineAtMs"])
        || renewed["deadlineAtMs"] > a["newDeadlineAtMs"]))
      || (previousDeadline !== undefined && previousDeadline !== a["previousDeadlineAtMs"])
      || (previousLimit !== undefined && previousLimit !== a["previousRepairLimit"])) return false;
    ids.add(a["id"]);
    priorGeneration = a["generation"];
    previousDeadline = a["newDeadlineAtMs"];
    previousLimit = a["newRepairLimit"];
    previousSpent = a["spentRepairs"];
  }
  return priorGeneration === generation && (previousDeadline === undefined || previousDeadline === b["totalDeadlineAtMs"])
    && (previousLimit === undefined || previousLimit === b["repairLimit"]);
}

export interface DeliveryBudgetAuthorization {
  readonly id: string;
  readonly expectedGeneration: number;
  readonly deadlineAtMs: number;
  readonly repairLimit: number;
  readonly reason: string;
  readonly operator?: string | undefined;
  /** Renewal is only allowed for the currently exhausted phase. */
  readonly renewPhase?: { readonly phase: DeliveryBudgetPhase; readonly identity: string } | undefined;
}

/** Called only inside the native exclusive state transaction. */
export function authorizePersistedDeliveryBudget(
  state: PersistedDeliveryState,
  identity: { readonly repo: string; readonly issueNumber: number; readonly workspaceKey: string },
  request: DeliveryBudgetAuthorization,
  nowMs: number,
): PersistedDeliveryState {
  if (state.repo.toLowerCase() !== identity.repo.toLowerCase() || state.issueNumber !== identity.issueNumber
    || state.workspaceKey !== identity.workspaceKey) throw new Error("Delivery budget work identity changed");
  if (state.externalSettlement) throw new Error("Externally settled delivery cannot be authorized");
  const budget = state.budget ?? migrateLegacyDeliveryBudget(state);
  if (!isDeliveryBudgetState(budget) || budget.totalDeadlineAtMs !== state.deadlineTimestampMs
    || budget.spentRepairs !== state.spentRepairs) throw new Error("Invalid persisted delivery budget authority");
  const next = authorizeDeliveryBudget(budget, request, nowMs);
  if (next === state.budget) return state;
  return { ...state, budget: next, deadlineTimestampMs: next.totalDeadlineAtMs, lastUpdated: new Date(nowMs).toISOString() };
}

/** Apply an explicit authorization inside the caller's exclusive state transaction. */
export function authorizeDeliveryBudget(budget: DeliveryBudgetState, request: DeliveryBudgetAuthorization, nowMs: number): DeliveryBudgetState {
  if (!isDeliveryBudgetState(budget) || !text(request.id) || !text(request.reason) || !uint(request.expectedGeneration)
    || !timestamp(request.deadlineAtMs) || !uint(request.repairLimit) || !timestamp(nowMs)
    || (request.operator !== undefined && !text(request.operator))) throw new Error("Invalid delivery budget authorization");
  if (nowMs < budget.totalStartedAtMs) throw new Error("Delivery clock precedes the recorded total start");
  const previous = budget.authorizations.find(receipt => receipt.id === request.id);
  if (previous) {
    if (previous.generation !== request.expectedGeneration + 1 || previous.newDeadlineAtMs !== request.deadlineAtMs
      || previous.newRepairLimit !== request.repairLimit || previous.reason !== request.reason
      || previous.operator !== request.operator || previous.renewedPhase?.phase !== request.renewPhase?.phase
      || previous.renewedPhase?.identity !== request.renewPhase?.identity) {
      throw new Error("Delivery budget authorization identifier already used");
    }
    return budget;
  }
  if (request.expectedGeneration !== budget.authorizationGeneration) throw new Error("Stale delivery budget authorization generation");
  if (request.deadlineAtMs < budget.totalDeadlineAtMs || request.deadlineAtMs <= nowMs
    || request.repairLimit < budget.repairLimit || request.repairLimit < budget.spentRepairs) {
    throw new Error("Delivery budget authorization cannot shorten authority");
  }
  const generation = budget.authorizationGeneration + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("Delivery budget authorization generation overflow");
  let renewedPhase: DeliveryBudgetCheckpoint | undefined;
  if (request.renewPhase) {
    const phase = budget.activePhase;
    if (!phase || phase.phase !== request.renewPhase.phase || phase.identity !== request.renewPhase.identity) {
      throw new Error("Delivery budget phase identity changed");
    }
    if (nowMs < phase.deadlineAtMs) throw new Error("Delivery budget phase is not exhausted");
    const phaseDeadline = nowMs + budget.phaseLimitsMs[phase.phase];
    if (!Number.isSafeInteger(phaseDeadline)) throw new Error("Delivery phase deadline overflow");
    const { completedAtMs: _completedAtMs, ...renewedIdentity } = phase;
    renewedPhase = { ...renewedIdentity, startedAtMs: nowMs, deadlineAtMs: Math.min(request.deadlineAtMs, phaseDeadline), authorizationGeneration: generation };
  }
  const receipt: DeliveryBudgetAuthorizationReceipt = { id: request.id, generation,
    previousDeadlineAtMs: budget.totalDeadlineAtMs, newDeadlineAtMs: request.deadlineAtMs,
    previousRepairLimit: budget.repairLimit, newRepairLimit: request.repairLimit, spentRepairs: budget.spentRepairs,
    authorizedAtMs: nowMs, reason: request.reason, ...(request.operator === undefined ? {} : { operator: request.operator }),
    ...(renewedPhase ? { renewedPhase } : {}) };
  return { ...budget, totalDeadlineAtMs: request.deadlineAtMs, repairLimit: request.repairLimit,
    authorizationGeneration: generation, authorizations: [...budget.authorizations, receipt],
    activePhase: renewedPhase ?? budget.activePhase,
    phaseHistory: renewedPhase && budget.activePhase ? [...budget.phaseHistory, budget.activePhase] : budget.phaseHistory };
}

/** Create a phase checkpoint without ever extending the delivery deadline. */
export function enterDeliveryBudgetPhase(budget: DeliveryBudgetState, phase: DeliveryBudgetPhase, identity: string, nowMs: number): DeliveryBudgetState {
  if (!isDeliveryBudgetState(budget) || !text(identity) || !uint(nowMs)) throw new Error("Invalid delivery budget phase");
  if (nowMs < budget.totalStartedAtMs) throw new Error("Delivery clock precedes the recorded total start");
  const current = budget.activePhase;
  if (current?.phase === phase && current.identity === identity) return budget;
  if (nowMs >= budget.totalDeadlineAtMs) throw new Error("Delivery total budget exhausted");
  const prior = [...budget.phaseHistory].reverse().find(p => p.phase === phase && p.identity === identity);
  if (prior) return { ...budget, activePhase: prior, phaseHistory: current ? [...budget.phaseHistory, current] : budget.phaseHistory };
  const phaseDeadline = nowMs + budget.phaseLimitsMs[phase];
  if (!Number.isSafeInteger(phaseDeadline)) throw new Error("Delivery phase deadline overflow");
  const next: DeliveryBudgetCheckpoint = { phase, identity, startedAtMs: nowMs,
    deadlineAtMs: Math.min(budget.totalDeadlineAtMs, phaseDeadline), authorizationGeneration: budget.authorizationGeneration };
  return { ...budget, activePhase: next, phaseHistory: current ? [...budget.phaseHistory, current] : budget.phaseHistory };
}

/** Persist a successful observation before dispatching subsequent work. */
export function completeDeliveryBudgetPhase(budget: DeliveryBudgetState, phase: DeliveryBudgetPhase, identity: string, nowMs: number): DeliveryBudgetState {
  if (!isDeliveryBudgetState(budget) || !timestamp(nowMs)) throw new Error("Invalid delivery budget completion");
  const active = budget.activePhase;
  if (!active || active.phase !== phase || active.identity !== identity) throw new Error("Delivery budget phase identity changed");
  if (nowMs < active.startedAtMs || nowMs >= active.deadlineAtMs || nowMs >= budget.totalDeadlineAtMs) {
    throw new Error("Delivery budget exhausted or clock regressed before completion");
  }
  if (active.completedAtMs !== undefined) return budget;
  return { ...budget, activePhase: { ...active, completedAtMs: nowMs } };
}
