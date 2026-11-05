import { GitHubDeliveryService } from "@symphony/tracker";
import { withDeliveryFileAuthority } from "./file-authority";
import { hasExternalSettlementFence } from "./external-settlement-journal";
import { runExternalSettlementCli } from "./external-settlement";
import { writeDurableJson } from "./recovery-storage";
import fs from "node:fs";
import path from "node:path";

import {
  recoverDeliveryHandoff,
  runDeliverySkill,
  type DeliveryGitGhRunner,
  type DeliveryStateStorage,
  type RunDeliverySkillOptions,
} from "@symphony/agent";
import {
  DecisionBridgeClient,
  DecisionPlanningGate,
  DecisionReviewGate,
} from "@symphony/decision";
import {
  decisionSessionId,
  isDeliveryContinuation,
  isDeliveryBudgetState,
  isDeliveryBudgetExhaustion,
  authorizePersistedDeliveryBudget,
  migrateLegacyDeliveryBudget,
  isDeliveryMergeConflictRepair,
  isLandingIntent,
  validateExternalDeliveryState,
  formatDeliveryHandoffMarkdown,
  type DecisionMaterializedPlan,
  type DeliveryHandoff,
  type DeliveryBudgetPhase,
  type DeliveryReviewGate,
  type PersistedDeliveryState,
} from "@symphony/domain";

import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

export interface DeliveryCliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export function formatDeliveryBudgetInspection(state: PersistedDeliveryState, nowMs: number): string {
  let budget = state.budget;
  let ambiguousLegacy = false;
  if (!budget) {
    try { budget = migrateLegacyDeliveryBudget(state); }
    catch { ambiguousLegacy = true; }
  }
  const deadline = state.deadlineTimestampMs;
  const valid = deadline !== undefined && Number.isSafeInteger(deadline) && deadline >= 0 && deadline <= 8_640_000_000_000_000;
  const date = valid ? new Date(deadline) : null;
  const remaining = valid ? Math.max(0, deadline - nowMs) : null;
  const limit = budget?.repairLimit ?? state.continuation?.maxRepairAttempts ?? state.handoff?.maxRepairs;
  const phase = budget?.activePhase;
  const phaseRemaining = phase ? Math.max(0, phase.deadlineAtMs - nowMs) : null;
  const phaseBlocks = phaseRemaining === 0 && !(phase?.phase === "ci" && state.continuation?.phase === "ci_passed");
  return [
    `Delivery budget for ${state.repo}#${state.issueNumber} (${state.workspaceKey})`,
    `Total deadline UTC: ${date?.toISOString() ?? "unknown"}`,
    `Total deadline local: ${date?.toString() ?? "unknown"}`,
    `Remaining: ${remaining === null ? "unknown" : `${remaining}ms`}`,
    `Stage: ${phase ? `${phase.phase} (${phase.identity})` : state.continuation?.phase ?? "unknown"}; stage deadline: ${phase ? new Date(phase.deadlineAtMs).toISOString() : "unavailable"}`,
    `Stage remaining: ${phaseRemaining === null ? "unknown" : `${phaseRemaining}ms`}`,
    `State generation: ${state.stateGeneration ?? 0}; authorization generation: ${state.budget?.authorizationGeneration ?? 0}`,
    `Repairs: ${state.spentRepairs} / ${limit ?? "unknown"}`,
    `Ordinary resume: ${ambiguousLegacy ? "blocked by ambiguous legacy budget" : remaining === null || remaining === 0 ? "blocked by total budget" : phaseBlocks ? "blocked by phase budget" : "budget available; other gates unverified"}`,
    `Pending compensation: ${state.pendingCompensation === true ? "yes" : "no"}`,
    "",
  ].join("\n");
}

export class FileDeliveryStateStorage implements DeliveryStateStorage {
  constructor(private readonly filePath: string, private readonly lockHeld = false) {}

  async withExclusive<T>(action: (storage: DeliveryStateStorage) => Promise<T>): Promise<T> {
    if (this.lockHeld) return action(this);
    return withDeliveryAuthority(path.dirname(path.dirname(this.filePath)),
      () => action(new FileDeliveryStateStorage(this.filePath, true)));
  }

  readState(): PersistedDeliveryState | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: invalid JSON (${String(err)})`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: expected object`);
    }
    const rec = parsed as Record<string, unknown>;
    if (rec["stateGeneration"] !== undefined && (!Number.isSafeInteger(rec["stateGeneration"]) || Number(rec["stateGeneration"]) < 0)) {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: invalid state generation`);
    }
    if (rec["budget"] !== undefined && (!isDeliveryBudgetState(rec["budget"])
      || rec["budget"].spentRepairs !== rec["spentRepairs"]
      || rec["budget"].totalDeadlineAtMs !== rec["deadlineTimestampMs"])) {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: invalid budget authority`);
    }
    if (
      typeof rec["repo"] !== "string" || !rec["repo"].trim() ||
      !Number.isSafeInteger(rec["issueNumber"]) || Number(rec["issueNumber"]) <= 0 ||
      typeof rec["workspaceKey"] !== "string" || !rec["workspaceKey"].trim() ||
      !Number.isSafeInteger(rec["spentRepairs"]) || Number(rec["spentRepairs"]) < 0 ||
      !Number.isSafeInteger(rec["spentWaitSeconds"]) || Number(rec["spentWaitSeconds"]) < 0 ||
      (rec["deadlineTimestampMs"] !== undefined &&
        (!Number.isSafeInteger(rec["deadlineTimestampMs"]) || Number(rec["deadlineTimestampMs"]) < 0
          || Number(rec["deadlineTimestampMs"]) > 8_640_000_000_000_000)) ||
      typeof rec["isPaused"] !== "boolean"
    ) {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: invalid state schema`);
    }
    if (rec["mergeConflictRepair"] !== undefined && (!isDeliveryMergeConflictRepair(rec["mergeConflictRepair"])
          || rec["mergeConflictRepair"].attempt > Number(rec["spentRepairs"])) ||
        rec["continuation"] !== undefined && !isDeliveryContinuation(rec["continuation"]) ||
        rec["landing"] !== undefined && (!isLandingIntent(rec["landing"])
          || rec["landing"].context.repo.toLowerCase() !== String(rec["repo"]).toLowerCase()
          || rec["landing"].context.issueNumber !== rec["issueNumber"]
          || rec["landing"].context.workspaceKey !== rec["workspaceKey"])) {
      throw new Error("Corrupted delivery recovery step schema");
    }
    const handoff = rec["handoff"] as DeliveryHandoff | undefined;
    if (handoff?.budgetExhaustion !== undefined && !isDeliveryBudgetExhaustion(handoff.budgetExhaustion)) {
      throw new Error("Corrupted delivery budget exhaustion report");
    }
    if (handoff?.reportDestination !== undefined && (handoff.reportDestination !== "issue" && handoff.reportDestination !== "pr"
      || handoff.reportDestination === "pr" && handoff.prNumber === null)) {
      throw new Error("Corrupted delivery report destination");
    }
    const state = rec as unknown as PersistedDeliveryState;
    validateExternalDeliveryState(state);
    return state;
  }

  writeState(state: PersistedDeliveryState): void {
    const previous = this.readState();
    // External settlement receipts hash the complete pre-settlement state. Its
    // terminal fence prevents later budget authorization, so preserve that hash.
    if (state.externalSettlement !== undefined) {
      writeDurableJson(this.filePath, { ...state, stateGeneration: previous?.stateGeneration });
      return;
    }
    const generation = (previous?.stateGeneration ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Delivery state generation overflow");
    writeDurableJson(this.filePath, { ...state, stateGeneration: generation });
  }
}

function parseSafeNonNegativeInteger(val: string, flagName: string): number {
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid value for ${flagName}: '${val}' must be a non-negative integer`);
  }
  return n;
}

export function parseDeliverySkillArgs(argv: readonly string[]): {
  action: "run" | "halt" | "recover-handoff" | "budget-inspect" | "budget-authorize";
  repo?: string | undefined;
  issueNumber?: number | undefined;
  workspaceKey?: string | undefined;
  headBranch?: string | undefined;
  baseBranch?: string | undefined;
  validationCommand?: string | undefined;
  validationTimeoutMs?: number | undefined;
  repairCommand?: string | undefined;
  maxRepairs?: number | undefined;
  maxWait?: number | undefined;
  ciWait?: number | undefined;
  reviewWait?: number | undefined;
  repairBudget?: number | undefined;
  validationBudget?: number | undefined;
  readyLabel?: string | undefined;
  optInLand?: boolean | undefined;
  resume?: boolean | undefined;
  requiredChecks?: readonly string[] | undefined;
  cwd?: string | undefined;
  bridgeUrl?: string | undefined;
  bridgeToken?: string | undefined;
  sessionId?: string | undefined;
  reason?: string | undefined;
  details?: string | undefined;
  conflictOperation?: string | undefined;
  conflictAttempt?: number | undefined;
  expectedHead?: string | undefined;
  executorStopped?: boolean | undefined;
  budgetDeadline?: string | undefined;
  budgetAddSeconds?: number | undefined;
  budgetAuthorizationId?: string | undefined;
  budgetExpectedGeneration?: number | undefined;
  budgetOperator?: string | undefined;
  budgetRenewPhase?: string | undefined;
  budgetPhaseIdentity?: string | undefined;
} {
  let action: "run" | "halt" | "recover-handoff" | "budget-inspect" | "budget-authorize" = "run";
  let repo: string | undefined;
  let issueNumber: number | undefined;
  let workspaceKey: string | undefined;
  let headBranch: string | undefined;
  let baseBranch: string | undefined;
  let validationCommand: string | undefined;
  let validationTimeoutMs: number | undefined;
  let repairCommand: string | undefined;
  let maxRepairs: number | undefined;
  let maxWait: number | undefined;
  let ciWait: number | undefined;
  let reviewWait: number | undefined;
  let repairBudget: number | undefined;
  let validationBudget: number | undefined;
  const seenRunBudgets = new Set<string>();
  let readyLabel: string | undefined;
  let optInLand = false;
  let resume = false;
  let requiredChecks: string[] | undefined;
  let cwd: string | undefined;
  let bridgeUrl: string | undefined;
  let bridgeToken: string | undefined;
  let sessionId: string | undefined;
  let reason: string | undefined;
  let details: string | undefined;
  let conflictOperation: string | undefined;
  let conflictAttempt: number | undefined;
  let expectedHead: string | undefined;
  let executorStopped = false;
  let budgetDeadline: string | undefined;
  let budgetAddSeconds: number | undefined;
  let budgetAuthorizationId: string | undefined;
  let budgetExpectedGeneration: number | undefined;
  let budgetOperator: string | undefined;
  let budgetRenewPhase: string | undefined;
  let budgetPhaseIdentity: string | undefined;
  const seenBudgetFlags = new Set<string>();

  let i = 0;
  if (argv[0] === "run" || argv[0] === "halt" || argv[0] === "recover-handoff" || argv[0] === "compensate-handoff" || argv[0] === "budget-inspect" || argv[0] === "budget-authorize") {
    action = argv[0] === "compensate-handoff" ? "recover-handoff" : argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (action === "run" && ["--max-wait", "--total-wait", "--ci-wait", "--review-wait", "--repair-budget", "--validation-budget", "--max-repairs"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      const key = arg === "--max-wait" || arg === "--total-wait" ? "total" : arg;
      if (seenRunBudgets.has(key)) throw new Error(`Duplicate or incompatible budget option: ${arg}`);
      seenRunBudgets.add(key);
    }
    if (action === "budget-authorize" && !["--repo", "--issue", "--workspace-key", "--cwd", "--deadline", "--add-seconds", "--authorization-id", "--expected-generation", "--operator", "--reason", "--max-repairs", "--renew-phase", "--phase-identity"].includes(arg)) {
      throw new Error(`Unknown budget authorization option: ${arg}`);
    }
    if (action === "budget-authorize") {
      if (seenBudgetFlags.has(arg)) throw new Error(`Duplicate option ${arg}`);
      seenBudgetFlags.add(arg);
    }
    if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg === "--issue" && i + 1 < argv.length) {
      issueNumber = parseSafeNonNegativeInteger(argv[++i]!, "--issue");
    } else if (arg === "--workspace-key" && i + 1 < argv.length) {
      workspaceKey = argv[++i];
    } else if (arg === "--head" && i + 1 < argv.length) {
      headBranch = argv[++i];
    } else if (arg === "--base" && i + 1 < argv.length) {
      baseBranch = argv[++i];
    } else if (arg === "--validate" && i + 1 < argv.length) {
      validationCommand = argv[++i];
    } else if (arg === "--validation-timeout") {
      const seconds = Number(argv[++i]);
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2_147_483) {
        throw new Error("Invalid value for --validation-timeout: expected integer seconds between 1 and 2147483");
      }
      validationTimeoutMs = seconds * 1000;
    } else if (arg === "--repair-cmd" && i + 1 < argv.length) {
      repairCommand = argv[++i];
    } else if (arg === "--max-repairs" && i + 1 < argv.length) {
      maxRepairs = parseSafeNonNegativeInteger(argv[++i]!, "--max-repairs");
    } else if ((arg === "--max-wait" || arg === "--total-wait") && i + 1 < argv.length) {
      maxWait = parseSafeNonNegativeInteger(argv[++i]!, arg);
    } else if (["--ci-wait", "--review-wait", "--repair-budget", "--validation-budget"].includes(arg) && i + 1 < argv.length) {
      const seconds = parseSafeNonNegativeInteger(argv[++i]!, arg);
      if (seconds === 0 || !Number.isSafeInteger(seconds * 1_000)) throw new Error(`${arg} must be positive seconds within range`);
      if (arg === "--ci-wait") ciWait = seconds;
      else if (arg === "--review-wait") reviewWait = seconds;
      else if (arg === "--repair-budget") repairBudget = seconds;
      else validationBudget = seconds;
    } else if (arg === "--ready-label" && i + 1 < argv.length) {
      readyLabel = argv[++i];
    } else if (arg === "--opt-in" || arg === "--opt-in-land") {
      optInLand = true;
    } else if (arg === "--no-land") {
      optInLand = false;
    } else if (arg === "--recover-conflict-operation" && i + 1 < argv.length) {
      conflictOperation = argv[++i];
    } else if (arg === "--recover-conflict-attempt" && i + 1 < argv.length) {
      conflictAttempt = parseSafeNonNegativeInteger(argv[++i]!, "--recover-conflict-attempt");
    } else if (arg === "--expected-head" && i + 1 < argv.length) {
      expectedHead = argv[++i];
    } else if (arg === "--confirm-executor-stopped") {
      executorStopped = true;
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--required-checks" && i + 1 < argv.length) {
      const raw = argv[++i]!;
      requiredChecks = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      cwd = argv[++i];
    } else if (arg === "--bridge-url" && i + 1 < argv.length) {
      bridgeUrl = argv[++i];
    } else if (arg === "--bridge-token" && i + 1 < argv.length) {
      bridgeToken = argv[++i];
    } else if (arg === "--session-id" && i + 1 < argv.length) {
      sessionId = argv[++i];
    } else if (arg === "--reason" && i + 1 < argv.length) {
      reason = argv[++i];
    } else if (arg === "--details" && i + 1 < argv.length) {
      details = argv[++i];
    } else if (arg === "--deadline" && i + 1 < argv.length) {
      budgetDeadline = argv[++i];
    } else if (arg === "--add-seconds" && i + 1 < argv.length) {
      budgetAddSeconds = parseSafeNonNegativeInteger(argv[++i]!, arg);
    } else if (arg === "--authorization-id" && i + 1 < argv.length) {
      budgetAuthorizationId = argv[++i];
    } else if (arg === "--expected-generation" && i + 1 < argv.length) {
      budgetExpectedGeneration = parseSafeNonNegativeInteger(argv[++i]!, arg);
    } else if (arg === "--operator" && i + 1 < argv.length) {
      budgetOperator = argv[++i];
    } else if (arg === "--renew-phase" && i + 1 < argv.length) {
      budgetRenewPhase = argv[++i];
    } else if (arg === "--phase-identity" && i + 1 < argv.length) {
      budgetPhaseIdentity = argv[++i];
    } else if (action === "budget-authorize") {
      throw new Error(`Unknown or incomplete budget authorization option: ${arg}`);
    }
  }

  return {
    action,
    repo,
    issueNumber,
    workspaceKey,
    headBranch,
    baseBranch,
    validationCommand,
    validationTimeoutMs,
    repairCommand,
    maxRepairs,
    maxWait,
    ciWait, reviewWait, repairBudget, validationBudget,
    readyLabel,
    optInLand,
    resume,
    conflictOperation, conflictAttempt, expectedHead, executorStopped,
    requiredChecks,
    cwd,
    bridgeUrl,
    bridgeToken,
    sessionId,
    reason,
    details,
    budgetDeadline, budgetAddSeconds, budgetAuthorizationId, budgetExpectedGeneration, budgetOperator, budgetRenewPhase, budgetPhaseIdentity,
  };
}

/** One filesystem authority lock shared by run, halt, and automatic/manual compensation.
 * Never steal a lock by age: an old process may still be executing a GitHub mutation.
 */
export async function withDeliveryAuthority<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  return withDeliveryFileAuthority(path.join(cwd, ".symphony", "delivery-authority.lock"), action);
}

export async function runDeliverySkillCli(
  argv: readonly string[], io: DeliveryCliIo, customRunner?: DeliveryGitGhRunner,
  customReviewGate?: DeliveryReviewGate,
): Promise<number> {
  try {
    if ((argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))
      || (argv.length === 2 && ["run", "budget-inspect", "budget-authorize"].includes(argv[0] ?? "") && argv[1] === "--help")) {
      io.stdout.write("Usage: symphony delivery-skill run|budget-inspect|budget-authorize [options]\n" +
        "  --repo <owner/repo> --issue <number> --workspace-key <key> --cwd <workspace>\n" +
        "  run: --total-wait <seconds> [--ci-wait <seconds>] [--review-wait <seconds>]\n" +
        "       [--repair-budget <seconds>] [--validation-budget <seconds>] [--max-repairs <count>] [--resume]\n" +
        "       --max-wait is a deprecated alias for --total-wait (total wall-clock time).\n" +
        "  budget-inspect: show deadlines, remaining time, repair usage and state generation.\n" +
        "  budget-authorize: (--deadline <UTC ISO time> | --add-seconds <seconds>)\n" +
        "       --authorization-id <id> --expected-generation <generation> --reason <reason>\n" +
        "       [--max-repairs <cumulative limit>] [--operator <name>]\n" +
        "       [--renew-phase <ci|review|repair|validation> --phase-identity <identity>]\n");
      return 0;
    }
    if (argv[0] === "prepare-external" || argv[0] === "settle-external") {
      return runExternalSettlementCli(argv, io, customRunner);
    }
    const parsed = parseDeliverySkillArgs(argv);
    if (parsed.repo && parsed.issueNumber && hasExternalSettlementFence(path.dirname(path.resolve(parsed.cwd ?? process.cwd())),
      { provider: "github", key: `${parsed.repo}#${parsed.issueNumber}` })) {
      throw new Error("External completion is fenced; ordinary Delivery commands cannot replay it");
    }
    return await withDeliveryAuthority(parsed.cwd ?? process.cwd(), () => runDeliverySkillCliLocked(argv, io, customRunner, customReviewGate));
  } catch (error) {
    io.stderr.write(`symphony delivery-skill: ${String(error)}\n`);
    return 1;
  }
}

async function runDeliverySkillCliLocked(
  argv: readonly string[],
  io: DeliveryCliIo,
  customRunner?: DeliveryGitGhRunner,
  customReviewGate?: DeliveryReviewGate,
): Promise<number> {
  let parsed: ReturnType<typeof parseDeliverySkillArgs>;
  try {
    parsed = parseDeliverySkillArgs(argv);
  } catch (err) {
    io.stderr.write(`symphony delivery-skill: invalid argument: ${String(err)}\n`);
    return 1;
  }

  const runner = customRunner ?? new DefaultDeliveryGitGhRunner();
  const cwd = parsed.cwd ?? process.cwd();
  const readyLabel = parsed.readyLabel ?? "symphony-ready";

  if (!parsed.repo || !parsed.issueNumber) {
    io.stderr.write("symphony delivery-skill: missing required --repo <owner/repo> or --issue <number>\n");
    return 1;
  }

  if (parsed.action === "budget-authorize") {
    if (!parsed.workspaceKey || !parsed.budgetAuthorizationId?.trim() || !parsed.reason?.trim()
      || parsed.budgetExpectedGeneration === undefined
      || (parsed.budgetDeadline === undefined) === (parsed.budgetAddSeconds === undefined)) {
      throw new Error("Budget authorization requires work identity, --authorization-id, --expected-generation, --reason and exactly one of --deadline or --add-seconds");
    }
    if ((parsed.budgetRenewPhase === undefined) !== (parsed.budgetPhaseIdentity === undefined)
      || (parsed.budgetRenewPhase !== undefined && (!(["ci", "review", "repair", "validation"] as const).includes(parsed.budgetRenewPhase as DeliveryBudgetPhase)
        || !parsed.budgetPhaseIdentity?.trim()))) throw new Error("Phase renewal requires a valid --renew-phase and exact --phase-identity");
    const storage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"), true);
    const state = storage.readState();
    if (!state) throw new Error("Delivery state not found");
    if (state.repo.toLowerCase() !== parsed.repo.toLowerCase() || state.issueNumber !== parsed.issueNumber
      || state.workspaceKey !== parsed.workspaceKey) throw new Error("Delivery budget work identity does not match persisted state");
    const budget = state.budget ?? migrateLegacyDeliveryBudget(state);
    const priorAuthorization = budget.authorizations.find(a => a.id === parsed.budgetAuthorizationId);
    if (priorAuthorization ? priorAuthorization.expectedStateGeneration !== parsed.budgetExpectedGeneration
      : (state.stateGeneration ?? 0) !== parsed.budgetExpectedGeneration) {
      throw new Error("Stale delivery state generation");
    }
    let deadlineAtMs: number;
    if (parsed.budgetDeadline !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed.budgetDeadline)) {
        throw new Error("--deadline must be an absolute UTC ISO timestamp");
      }
      deadlineAtMs = Date.parse(parsed.budgetDeadline);
      const canonical = parsed.budgetDeadline.includes(".") ? parsed.budgetDeadline : parsed.budgetDeadline.replace(/Z$/, ".000Z");
      if (!Number.isSafeInteger(deadlineAtMs) || new Date(deadlineAtMs).toISOString() !== canonical) {
        throw new Error("Invalid --deadline");
      }
    } else {
      const seconds = parsed.budgetAddSeconds!;
      if (seconds === 0 || !Number.isSafeInteger(seconds * 1_000)) throw new Error("--add-seconds must be positive and within range");
      const originalDeadline = priorAuthorization?.previousDeadlineAtMs ?? budget.totalDeadlineAtMs;
      deadlineAtMs = originalDeadline + seconds * 1_000;
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs > 8_640_000_000_000_000) throw new Error("Authorized deadline overflow");
    }
    const next = authorizePersistedDeliveryBudget(state,
      { repo: parsed.repo, issueNumber: parsed.issueNumber, workspaceKey: parsed.workspaceKey },
      { id: parsed.budgetAuthorizationId, expectedGeneration: priorAuthorization ? priorAuthorization.generation - 1 : budget.authorizationGeneration,
        deadlineAtMs, repairLimit: parsed.maxRepairs ?? priorAuthorization?.newRepairLimit ?? budget.repairLimit, reason: parsed.reason,
        ...(parsed.budgetRenewPhase ? { renewPhase: { phase: parsed.budgetRenewPhase as DeliveryBudgetPhase, identity: parsed.budgetPhaseIdentity! } } : {}),
        ...((parsed.budgetOperator ?? process.env["USER"])?.trim()
          ? { operator: (parsed.budgetOperator ?? process.env["USER"])!.trim() } : {}) }, Date.now());
    if (next !== state) {
      const newBudget = next.budget!;
      const receipts = [...newBudget.authorizations];
      receipts[receipts.length - 1] = { ...receipts[receipts.length - 1]!, expectedStateGeneration: parsed.budgetExpectedGeneration };
      storage.writeState({ ...next, budget: { ...newBudget, authorizations: receipts } });
    }
    const recorded = storage.readState()!;
    io.stdout.write(`Delivery budget authorization ${parsed.budgetAuthorizationId} recorded; state generation ${recorded.stateGeneration ?? 0}; authorization generation ${recorded.budget!.authorizationGeneration}; deadline ${new Date(recorded.deadlineTimestampMs!).toISOString()}; repairs ${recorded.spentRepairs}/${recorded.budget!.repairLimit}.\n`);
    return 0;
  }

  if (parsed.action === "budget-inspect") {
    const state = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"), true).readState();
    if (!state) throw new Error("Delivery state not found");
    const workspaceKey = parsed.workspaceKey ?? `GH-${parsed.issueNumber}`;
    if (state.repo.toLowerCase() !== parsed.repo.toLowerCase() || state.issueNumber !== parsed.issueNumber || state.workspaceKey !== workspaceKey) {
      throw new Error("Delivery budget work identity does not match persisted state");
    }
    io.stdout.write(formatDeliveryBudgetInspection(state, Date.now()));
    return 0;
  }

  if (parsed.action === "recover-handoff") {
    const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"), true);
    const result = await recoverDeliveryHandoff({
      cwd,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      workspaceKey: parsed.workspaceKey,
      readyLabel: parsed.readyLabel,
      headBranch: parsed.headBranch,
      maxRepairs: parsed.maxRepairs,
      maxWait: parsed.maxWait,
      stateStorage,
      runner,
      log: (msg) => io.stdout.write(`${msg}\n`),
    });

    if (result.message) {
      io.stderr.write(`symphony delivery-skill: ${result.message}\n`);
      return 0;
    }

    if (!result.success) {
      io.stderr.write(`symphony delivery-skill: ${result.error ?? "handoff recovery incomplete"}\n`);
      return 1;
    }

    io.stdout.write("symphony delivery-skill: handoff recovery completed successfully\n");
    return 0;
  }

  if (parsed.action === "halt") {
    // 显式停止派发命令（例如预算耗尽或 operator 触发）
    const reason = (parsed.reason ?? "budget_exhausted") as DeliveryHandoff["reason"];
    const details = parsed.details ?? "Delivery budget exhausted or manual blocker triggered.";

    const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"), true);
    // A damaged or foreign record is evidence, never permission to replace it.
    const existingState = stateStorage.readState();
    if (existingState && (existingState.repo.toLowerCase() !== parsed.repo.toLowerCase()
      || existingState.issueNumber !== parsed.issueNumber
      || (parsed.workspaceKey !== undefined && existingState.workspaceKey !== parsed.workspaceKey))) {
      throw new Error("Delivery halt work identity does not match persisted state");
    }

    if (existingState?.isPaused) {
      if (!existingState.pendingCompensation) return 0;
      const recovered = await recoverDeliveryHandoff({ cwd, repo: parsed.repo, issueNumber: parsed.issueNumber,
        workspaceKey: parsed.workspaceKey, stateStorage, runner });
      return recovered.success ? 0 : 1;
    }

    const spentRepairs = existingState?.spentRepairs ?? (parsed.maxRepairs ?? 3);
    const spentWaitSeconds = existingState?.spentWaitSeconds ?? (parsed.maxWait ?? 300);
    const handoffId = `handoff-${parsed.repo.replace("/", "-")}-${parsed.issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const handoff: DeliveryHandoff = {
      reason,
      details,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      headBranch: existingState?.continuation?.headBranch ?? existingState?.landing?.context.headBranch ?? parsed.headBranch ?? `symphony/GH-${parsed.issueNumber}`,
      prNumber: existingState?.continuation?.prNumber ?? existingState?.landing?.prNumber ?? null,
      prUrl: existingState?.handoff?.prUrl ?? null,
      headSha: existingState?.continuation?.headSha ?? existingState?.landing?.headSha ?? null,
      spentRepairs,
      maxRepairs: parsed.maxRepairs ?? spentRepairs,
      spentWaitSeconds,
      maxWaitSeconds: parsed.maxWait ?? spentWaitSeconds,
      readyLabel,
      readyLabelRemoved: false,
      commentPosted: false,
      handoffId,
      reportDestination: "issue",
    };

    // 先持久化 paused 状态和待补偿事实
    stateStorage.writeState({
      ...existingState,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${parsed.issueNumber}`),
      spentRepairs,
      spentWaitSeconds,
      deadlineTimestampMs: existingState?.deadlineTimestampMs,
      isPaused: true,
      pauseReason: reason,
      handoff,
      readyLabelRemoved: false,
      commentPosted: false,
      commentVerifyStatus: "pending",
      pendingCompensation: true,
      lastUpdated: new Date().toISOString(),
    });

    let readyLabelRemoved = false;
    let labelCheckError: string | null = null;
    try {
      const editRes = await runner.gh(
        ["issue", "edit", String(parsed.issueNumber), "--repo", parsed.repo, "--remove-label", readyLabel],
        cwd,
      );
      if (editRes.exitCode !== 0) {
        labelCheckError = `Failed to remove label '${readyLabel}': ${editRes.stderr}`;
      } else {
        // 检查标签事实
        const labelCheck = await runner.gh(
          ["issue", "view", String(parsed.issueNumber), "--repo", parsed.repo, "--json", "labels"],
          cwd,
        );
        if (labelCheck.exitCode !== 0) {
          labelCheckError = `Label removal executed, but failed to re-query issue labels: ${labelCheck.stderr}`;
        } else {
          try {
            const parsedLabels = JSON.parse(labelCheck.stdout || "{}");
            if (!Array.isArray(parsedLabels.labels)) {
              labelCheckError = "Invalid issue labels JSON: missing labels array";
            } else {
              const labels: Array<{ name: string } | string> = parsedLabels.labels;
              if (labels.some((l) => (typeof l === "string" ? l : l.name) === readyLabel)) {
                labelCheckError = `Label '${readyLabel}' is still present on issue #${parsed.issueNumber}`;
              } else {
                readyLabelRemoved = true;
              }
            }
          } catch (e) {
            labelCheckError = `Failed to parse issue labels JSON: ${String(e)}`;
          }
        }
      }
    } catch (err) {
      labelCheckError = `Exception during label removal: ${String(err)}`;
    }

    const handoffAfterLabel = { ...handoff, readyLabelRemoved };
    stateStorage.writeState({
      ...existingState,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${parsed.issueNumber}`),
      spentRepairs,
      spentWaitSeconds,
      deadlineTimestampMs: existingState?.deadlineTimestampMs,
      isPaused: true,
      pauseReason: reason,
      handoff: handoffAfterLabel,
      readyLabelRemoved,
      commentPosted: false,
      commentVerifyStatus: "pending",
      pendingCompensation: true,
      lastUpdated: new Date().toISOString(),
    });

    let commentPosted = false;
    let commentVerifyStatus: "posted" | "failed" | "unverified" = "unverified";
    let handoffMarkdown = formatDeliveryHandoffMarkdown(handoffAfterLabel);

    try {
      const commentRes = await runner.gh(
        ["issue", "comment", String(parsed.issueNumber), "--repo", parsed.repo, "--body", handoffMarkdown],
        cwd,
      );
      if (commentRes.exitCode === 0) {
        commentPosted = true;
        commentVerifyStatus = "posted";
      } else {
        commentVerifyStatus = "failed";
        io.stderr.write(`symphony delivery-skill: warning: failed to post comment: ${commentRes.stderr}\n`);
      }
    } catch (err) {
      commentVerifyStatus = "failed";
      io.stderr.write(`symphony delivery-skill: warning: failed to post comment: ${String(err)}\n`);
      commentPosted = false;
    }

    const finalHandoff = { ...handoffAfterLabel, commentPosted };
    handoffMarkdown = formatDeliveryHandoffMarkdown(finalHandoff);
    io.stdout.write(handoffMarkdown + "\n");

    const pendingCompensation = !(readyLabelRemoved && commentPosted);
    stateStorage.writeState({
      ...existingState,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${parsed.issueNumber}`),
      spentRepairs,
      spentWaitSeconds,
      deadlineTimestampMs: existingState?.deadlineTimestampMs,
      isPaused: true,
      pauseReason: reason,
      handoff: finalHandoff,
      readyLabelRemoved,
      commentPosted,
      commentVerifyStatus,
      pendingCompensation,
      lastUpdated: new Date().toISOString(),
    });

    if (!readyLabelRemoved) {
      io.stderr.write(
        `symphony delivery-skill: halt failed: could not remove label '${readyLabel}' from issue #${parsed.issueNumber} (${labelCheckError ?? "unverified"}). Dispatch not halted.\n`,
      );
      return 1;
    }

    if (!commentPosted) {
      io.stderr.write(
        `symphony delivery-skill: halt warning: label removed, but failed to post handoff comment.\n`,
      );
      return 1;
    }

    return 0;
  }

  const headBranch = parsed.headBranch ?? `symphony/GH-${parsed.issueNumber}`;
  const baseBranch = parsed.baseBranch ?? "main";
  const workspaceKey = parsed.workspaceKey ?? `GH-${parsed.issueNumber}`;

  const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"), true);
  const configuredPhaseSeconds = { ci: parsed.ciWait, review: parsed.reviewWait, repair: parsed.repairBudget, validation: parsed.validationBudget };
  const hasPhaseLimits = Object.values(configuredPhaseSeconds).some(value => value !== undefined);
  let budgetPhaseLimitsMs: RunDeliverySkillOptions["budgetPhaseLimitsMs"];
  if (hasPhaseLimits) {
    const saved = stateStorage.readState();
    if (saved && !saved.budget) throw new Error("Existing legacy delivery cannot receive phase limits from command-line options");
    if (saved?.budget) {
      for (const phase of ["ci", "review", "repair", "validation"] as const) {
        const requested = configuredPhaseSeconds[phase];
        if (requested !== undefined && requested * 1_000 !== saved.budget.phaseLimitsMs[phase]) {
          throw new Error(`Existing delivery ${phase} limit differs from persisted authority`);
        }
      }
    }
    const defaultLimit = Math.max(1, (parsed.maxWait ?? 300) * 1_000);
    if (!Number.isSafeInteger(defaultLimit)) throw new Error("Total budget exceeds safe millisecond range");
    budgetPhaseLimitsMs = saved?.budget?.phaseLimitsMs ?? {
      ci: parsed.ciWait === undefined ? defaultLimit : parsed.ciWait * 1_000,
      review: parsed.reviewWait === undefined ? defaultLimit : parsed.reviewWait * 1_000,
      repair: parsed.repairBudget === undefined ? defaultLimit : parsed.repairBudget * 1_000,
      validation: parsed.validationBudget === undefined ? defaultLimit : parsed.validationBudget * 1_000,
    };
  }

  if (parsed.resume) {
    const state = stateStorage.readState();
    if (state && state.repo.toLowerCase() === parsed.repo.toLowerCase()
      && state.issueNumber === parsed.issueNumber && state.workspaceKey === workspaceKey) {
      io.stdout.write(formatDeliveryBudgetInspection(state, Date.now()));
    }
  }

  let reviewGate = customReviewGate;
  let preflight: RunDeliverySkillOptions["preflight"];
  const bridgeUrl = parsed.bridgeUrl ?? process.env.DECISION_BRIDGE_URL;
  if (bridgeUrl) {
    const token = parsed.bridgeToken ?? process.env.DECISION_BRIDGE_TOKEN;
    const client = new DecisionBridgeClient(bridgeUrl, ...(token ? [{ authToken: token }] : []));
    if (!reviewGate) {
      reviewGate = new DecisionReviewGate(client);
    }
    const sId = parsed.sessionId ?? (parsed.repo && parsed.issueNumber
      ? decisionSessionId({ provider: "github", key: `${parsed.repo.toLowerCase()}#${parsed.issueNumber}` })
      : undefined);
    if (sId) {
      const repo = parsed.repo;
      // Run under the persisted Delivery deadline, including both the GitHub
      // observation and the cancellable Bridge eligibility request.
      preflight = async (remainingMs, signal): Promise<DecisionMaterializedPlan | null | undefined> => {
        const startedAtMs = Date.now();
        let requirements: { title: string; body: string };
        try {
          const viewRes = await runner.gh(
            ["issue", "view", String(parsed.issueNumber), "--json", "title,body", "--repo", repo],
            cwd, Math.min(remainingMs, 2_147_483_647),
          );
          if (viewRes.exitCode !== 0) throw new Error(viewRes.stderr || `gh issue view exited ${viewRes.exitCode}`);
          const data = JSON.parse(viewRes.stdout || "{}");
          if (!data || typeof data.title !== "string") throw new Error("Issue view response is missing a string title");
          requirements = { title: data.title, body: typeof data.body === "string" ? data.body : "" };
        } catch (error) {
          throw new Error(`failed to read current Issue #${parsed.issueNumber} requirements: ${String(error)}`);
        }
        if (signal.aborted || Date.now() - startedAtMs >= remainingMs) throw new Error("Planning eligibility deadline exhausted");
        const eligibility = await new DecisionPlanningGate(client).verifyPlanEligibility(sId, requirements, signal);
        if (!eligibility.eligible) throw new Error(`planning gate verification failed: ${eligibility.reason}`);
        return eligibility.plan;
      };
    }
  }

  const hasRecovery = parsed.conflictOperation !== undefined || parsed.conflictAttempt !== undefined
    || parsed.expectedHead !== undefined || parsed.executorStopped;
  if (hasRecovery && (!parsed.resume || !parsed.conflictOperation || !parsed.conflictAttempt
    || !parsed.expectedHead || !/^[a-f0-9]{40}$/.test(parsed.expectedHead) || !parsed.executorStopped)) {
    throw new Error("Conflict recovery requires --resume, exact operation/attempt/HEAD and --confirm-executor-stopped");
  }
  const options: RunDeliverySkillOptions = {
    readRemoteBranch: createRemoteBranchReader(runner, cwd),
    ...(hasRecovery ? { resumeStageOnly: true, conflictRecoveryAuthorization: { operationId: parsed.conflictOperation!,
      attempt: parsed.conflictAttempt!, expectedHeadSha: parsed.expectedHead!, executorStopped: true as const } } : {}),
    cwd,
    repo: parsed.repo,
    issueNumber: parsed.issueNumber,
    workspaceKey,
    headBranch,
    baseBranch,
    validationCommand: parsed.validationCommand,
    validationTimeoutMs: parsed.validationTimeoutMs,
    repairCommand: parsed.repairCommand,
    maxRepairAttempts: parsed.maxRepairs,
    maxWaitSeconds: parsed.maxWait,
    budgetPhaseLimitsMs,
    readyLabel,
    optInLand: parsed.optInLand,
    resume: parsed.resume,
    requiredChecks: parsed.requiredChecks,
    reviewGate,
    sessionId: parsed.sessionId,
    preflight,
    runner,
    stateStorage,
    log: (msg) => io.stdout.write(`${msg}\n`),
  };

  try {
    const result = await runDeliverySkill(options);
    if (result.status === "completed") {
      io.stdout.write(`symphony delivery-skill: successfully completed and landed PR #${result.prNumber}\n`);
      return 0;
    }
    if (result.status === "ready_to_land") {
      io.stdout.write(`symphony delivery-skill: PR #${result.prNumber} is green and ready to land\n`);
      return 0;
    }
    // blocked
    io.stderr.write(`symphony delivery-skill: blocked (${result.reason})\n`);
    if (result.handoffMarkdown?.startsWith("Planning eligibility check failed:")) {
      io.stderr.write(`symphony delivery-skill: ${result.handoffMarkdown}\n`);
    }
    if (result.handoffMarkdown) {
      io.stdout.write(result.handoffMarkdown + "\n");
    }
    return 1;
  } catch (err) {
    io.stderr.write(`symphony delivery-skill: execution error: ${String(err)}\n`);
    return 1;
  }
}

/** Host composition keeps tracker facts outside the agent package, using the
 * same fenced/sanitized runner as all other delivery subprocesses. */
export function createRemoteBranchReader(runner: DeliveryGitGhRunner, cwd: string) {
  return (repository: string, branch: string, timeoutMs?: number) =>
    new GitHubDeliveryService({ exec: args => runner.gh(args, cwd, timeoutMs) }).readRemoteBranch(repository, branch);
}
