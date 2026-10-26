/** Local, bounded execution metadata. Never store prompts, replies, credentials or raw errors. */
import type { DriverStep } from "./checkpoint";
import { SELECTORS, type ResponseWaitState } from "./probes";

export type DriverDiagnosticStage = DriverStep | "response_wait" | "result_submitting" | "result_accepted" | "result_submit_error" | "task_failed";
export interface DriverDiagnostic {
  readonly stage: DriverDiagnosticStage;
  readonly taskId: string;
  readonly kind: "plan" | "review";
  readonly revision: number;
  readonly wait?: ResponseWaitState | undefined;
}
export interface DiagnosticRecord extends DriverDiagnostic { readonly atMs: number }

function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return choices.some(choice => choice === value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function metadata(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanWait(value: unknown): ResponseWaitState | undefined {
  if (!metadata(value)) return undefined;
  const { phase, reason, selector, baselineCount, currentCount, candidateFound,
    matchingTaskResult, stopPresent, elapsedMs } = value;
  if (!oneOf(phase, ["waiting", "completed", "timeout", "aborted"] as const) ||
      !oneOf(reason, ["no_new_turn", "generating", "empty_turn", "ineligible_result", "stabilizing", "ready"] as const) ||
      !(selector === null || typeof selector === "string" && selector.split(", ").every(
        part => SELECTORS.assistantTurn.some(known => known === part))) ||
      !nonnegativeInteger(baselineCount) || !nonnegativeInteger(currentCount) || !nonnegativeInteger(elapsedMs) ||
      typeof candidateFound !== "boolean" || typeof matchingTaskResult !== "boolean" || typeof stopPresent !== "boolean") return undefined;
  return { phase, reason, selector, baselineCount, currentCount, candidateFound, matchingTaskResult, stopPresent, elapsedMs };
}

function cleanRecord(value: unknown): DiagnosticRecord | null {
  if (!metadata(value) || !nonnegativeInteger(value.atMs) || typeof value.taskId !== "string" ||
      !oneOf(value.kind, ["plan", "review"] as const) || !nonnegativeInteger(value.revision) ||
      !oneOf(value.stage, ["claimed", "navigating", "started", "prompt_submitting", "waiting_response",
        "result_extracted", "completed", "rebind_submitting", "bootstrap_submitting", "bootstrap_waiting",
        "response_wait", "result_submitting", "result_accepted", "result_submit_error", "task_failed"] as const)) return null;
  const wait = cleanWait(value.wait);
  return { atMs: value.atMs, stage: value.stage, taskId: value.taskId, kind: value.kind, revision: value.revision,
    ...(wait ? { wait } : {}) };
}

export class DriverDiagnostics {
  private readonly records: DiagnosticRecord[] = [];
  constructor(private readonly storageKey: string, private readonly render: (text: string) => void) {
    // Render only our reconstructed metadata, never arbitrary persisted properties.
    try {
      const stored: unknown = typeof GM_getValue === "function" ? GM_getValue(storageKey, "[]") : "[]";
      const parsed: unknown = typeof stored === "string" ? JSON.parse(stored) : [];
      if (Array.isArray(parsed)) {
        for (const entry of parsed.slice(-50)) {
          const record = cleanRecord(entry);
          if (record) this.records.push(record);
        }
      }
    } catch { /* Storage is optional. */ }
    this.show();
  }
  record(entry: DriverDiagnostic): void {
    try {
      const record = cleanRecord({ ...entry, atMs: Date.now() });
      if (!record) return;
      this.records.push(record);
      if (this.records.length > 50) this.records.shift();
      if (typeof GM_setValue === "function") GM_setValue(this.storageKey, JSON.stringify(this.records));
    } catch { /* Diagnostics must never affect task execution. */ }
    this.show();
  }
  private show(): void {
    try { this.render(JSON.stringify(this.records, null, 2)); } catch { /* Best effort HUD. */ }
  }
}
