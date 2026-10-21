/** Thin work-level reconciliation; authorities alone commit mutations (§7/§8/§14). */
import { sanitizeOwnershipFence, validateOwnershipFence, formatWorkKey,
  type ExpectedNextAction, type WorkContinuityObservation, type WorkContinuityDiagnosis,
  type WorkKey, type WorkRecoveryRequest, type WorkRecoveryResult,
} from "@symphony/domain";

export function deriveWorkContinuity(f: WorkContinuityObservation): WorkContinuityDiagnosis {
  const authority = f.stage === "plan" || f.stage === "review" ? "decision"
    : f.stage === "coding" ? "orchestrator" : "delivery";
  const next: ExpectedNextAction = {
    action: f.stage === "handoff" ? "compensate" : "dispatch",
    description: `${f.stage}: re-observe and continue through ${authority}`,
    authority: { kind: "internal", authority }, taskRef: f.taskRef, target: f.target,
  };
  const result = (status: WorkContinuityDiagnosis["status"], reasons: readonly string[], recovery: WorkContinuityDiagnosis["recovery"] = "none", expected = next): WorkContinuityDiagnosis => ({
    workKey: f.workKey, observedAt: f.observedAt, status, next: expected,
    owner: f.owner === null ? null : { id: f.owner.id, fence: sanitizeOwnershipFence(f.owner.fence), liveness: f.owner.liveness }, reasons, recovery,
  });
  if (!f.available) return result("observation_unavailable", f.unavailableSources);
  if (!f.active) return result("inactive", []);
  if (f.contradictions.length) return result("contradictory", f.contradictions);
  if (f.owner && !validateOwnershipFence(f.expectedFence, f.owner.fence).valid) {
    return result("contradictory", ["stale_or_conflicting_owner_fence"]);
  }
  // Blocked work can finish a pending report, but must never resume execution.
  if (f.blocked && f.stage !== "handoff") return result("blocked", [f.blocked], "none", {
    action: "require_human", description: f.blocked,
    authority: { kind: "human", role: "operator", instruction: f.blocked },
  });
  if (f.externalWait) return result("external_wait", [f.externalWait.condition], "none", {
    action: "await_external", description: f.externalWait.condition,
    authority: { kind: "external", ...f.externalWait },
  });
  if (f.scheduled) return result("scheduled", [f.scheduled.due ? "due_owned_by_scheduler" : "scheduled"]);
  if (f.owner) {
    const l = f.owner.liveness;
    if (f.owner.leaseExpiresAt !== undefined) {
      if (f.observedAt >= f.owner.leaseExpiresAt) return result("stranded", ["execution_lease_expired"], "reclaim");
      return result(l.lastProgressAt === "unknown" ? "unknown" : "healthy", ["valid_execution_lease"]);
    }
    const baseline = l.lastProgressAt === "unknown" ? l.startedAt : l.lastProgressAt;
    const timedOut = (l.deadlineAt !== undefined && f.observedAt > l.deadlineAt)
      || (l.stallPolicy !== undefined && Number.isFinite(l.stallPolicy.timeoutMs) && l.stallPolicy.timeoutMs > 0 && f.observedAt - baseline > l.stallPolicy.timeoutMs);
    if (timedOut) return result("stalled", ["progress_deadline_exceeded"], "retry");
    return result(l.lastProgressAt === "unknown" ? "unknown" : "healthy", []);
  }
  if (f.blocked && f.stage === "handoff") return result("stranded", ["pending_handoff_compensation"], "compensate");
  return result("stranded", ["no_executor_or_scheduled_recovery"], next.action);
}

export interface WorkContinuityPorts {
  /** Union of active tracker work and known source identities. Never only running workers. */
  listWork(): Promise<readonly WorkKey[]>;
  /** Fresh source reads, not operations projections. Missing essential facts must fail closed. */
  observe(work: WorkKey): Promise<WorkContinuityObservation>;
  /** Authority MUST atomically revalidate request version/fence and admission at commit. */
  recover(request: WorkRecoveryRequest, canCommit: () => boolean): Promise<WorkRecoveryResult>;
  /** Fresh native evidence that an uncertain action completed or its exact target is invalidated.
   * Missing evidence, elapsed time, heartbeat and unrelated version changes must return false. */
  isRecoveryResolved?(request: WorkRecoveryRequest): Promise<boolean>;
}
export interface WorkContinuityReconciliation {
  readonly workKey: WorkKey;
  readonly diagnosis: WorkContinuityDiagnosis | null;
  readonly result: WorkRecoveryResult | "unchanged" | "observation_unavailable" | "unverified";
}
export class WorkContinuityCoordinator {
  private stopping = false;
  private latest: readonly WorkContinuityReconciliation[] = [];
  get observations(): readonly WorkContinuityReconciliation[] { return this.latest; }
  private active: Promise<readonly WorkContinuityReconciliation[]> | null = null;
  private readonly uncertain = new Map<string, WorkRecoveryRequest>();
  hasUnverifiedRecovery(work: WorkKey): boolean { return this.uncertain.has(formatWorkKey(work)); }
  constructor(private readonly ports: WorkContinuityPorts) {}
  reconcile(): Promise<readonly WorkContinuityReconciliation[]> {
    if (this.stopping) return Promise.resolve([]);
    if (this.active) return this.active;
    const run = this.scan();
    this.active = run;
    void run.then(() => { if (this.active === run) this.active = null; }, () => { if (this.active === run) this.active = null; });
    return run;
  }
  async stop(): Promise<void> {
    this.stopping = true; // synchronous before waiting for in-flight I/O
    await this.active;
  }
  private async scan(): Promise<readonly WorkContinuityReconciliation[]> {
    const results: WorkContinuityReconciliation[] = [];
    const seen = new Set<string>();
    for (const workKey of [...await this.ports.listWork(), ...[...this.uncertain.values()].map(request => request.workKey)]) {
      if (this.stopping) break;
      const key = formatWorkKey(workKey);
      if (seen.has(key)) continue;
      seen.add(key);
      let diagnosis: WorkContinuityDiagnosis | null = null;
      let acted = false;
      try {
        const first = await this.ports.observe(workKey);
        diagnosis = deriveWorkContinuity(first);
        const pending = this.uncertain.get(key);
        if (pending) {
          if (first.available && await this.ports.isRecoveryResolved?.(pending)) this.uncertain.delete(key);
          else {
            results.push({ workKey, diagnosis: first.available ? this.unverified(diagnosis) : diagnosis, result: "unverified" });
            continue;
          }
        }
        if (diagnosis.recovery === "none" || this.stopping) {
          results.push({ workKey, diagnosis, result: "unchanged" }); continue;
        }
        const fresh = await this.ports.observe(workKey);
        const decision = deriveWorkContinuity(fresh);
        if (this.stopping || fresh.version !== first.version || decision.recovery !== diagnosis.recovery) {
          results.push({ workKey, diagnosis: decision, result: "stale" }); continue;
        }
        acted = true;
        const request: WorkRecoveryRequest = { workKey, version: fresh.version, stage: fresh.stage,
          action: decision.recovery, authority: decision.next.authority, fence: fresh.expectedFence, taskRef: fresh.taskRef,
          handoffRef: fresh.handoffRef, leaseExpiresAt: fresh.owner?.leaseExpiresAt };
        // Record before crossing the authority boundary: a rejected promise may follow a commit.
        this.uncertain.set(key, request);
        let result: WorkRecoveryResult;
        try { result = await this.ports.recover(request, () => !this.stopping); }
        catch { result = "unverified"; }
        if (result === "stale" || result === "unsupported" || result === "stopped") this.uncertain.delete(key);
        // Always re-observe, including refused/unsupported actions. Never replay on read failure.
        const after = await this.ports.observe(workKey);
        diagnosis = deriveWorkContinuity(after);
        if (after.available && (result === "applied" || (result === "unverified" && await this.ports.isRecoveryResolved?.(request)))) {
          this.uncertain.delete(key);
        }
        if (this.uncertain.has(key)) {
          result = "unverified";
          if (after.available) diagnosis = this.unverified(diagnosis);
        }
        results.push({ workKey, diagnosis, result });
      } catch {
        results.push({ workKey, diagnosis: diagnosis && this.uncertain.has(key) ? this.unverified(diagnosis) : null,
          result: acted || this.uncertain.has(key) ? "unverified" : "observation_unavailable" });
      }
    }
    this.latest = results;
    return results;
  }
  private unverified(diagnosis: WorkContinuityDiagnosis): WorkContinuityDiagnosis {
    const instruction = "recovery_outcome_unverified: verify native authority before retrying";
    return { ...diagnosis, status: "unverified", recovery: "none", reasons: [...diagnosis.reasons, instruction],
      next: { action: "require_human", description: instruction,
        authority: { kind: "human", role: "operator", instruction } } };
  }
}
