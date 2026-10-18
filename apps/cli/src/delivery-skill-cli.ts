import fs from "node:fs";
import path from "node:path";

import {
  DeliveryStateConflictError,
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
  formatDeliveryHandoffMarkdown,
  type DecisionMaterializedPlan,
  type DeliveryHandoff,
  type DeliveryReviewGate,
  type PersistedDeliveryState,
} from "@symphony/domain";

import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

export interface DeliveryCliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export class FileDeliveryStateStorage implements DeliveryStateStorage {
  private readonly lockPath: string;
  /**
   * Raw file content this instance last read (or wrote). A write whose base content changed
   * is rejected instead of overwriting a newer handoff / HEAD.
   */
  private observedRaw: string | null | undefined = undefined;
  private lockDepth = 0;

  constructor(private readonly filePath: string) {
    this.lockPath = path.join(path.dirname(filePath), ".delivery-state.lock");
  }

  readState(): PersistedDeliveryState | null {
    const raw = this.readRaw();
    this.observedRaw = raw;
    if (raw === null) {
      return null;
    }
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
    if (
      typeof rec["repo"] !== "string" ||
      typeof rec["issueNumber"] !== "number" ||
      typeof rec["workspaceKey"] !== "string" ||
      typeof rec["spentRepairs"] !== "number" ||
      rec["spentRepairs"] < 0 ||
      typeof rec["spentWaitSeconds"] !== "number" ||
      rec["spentWaitSeconds"] < 0 ||
      (rec["deadlineTimestampMs"] !== undefined &&
        (typeof rec["deadlineTimestampMs"] !== "number" || !Number.isFinite(rec["deadlineTimestampMs"]) || rec["deadlineTimestampMs"] < 0)) ||
      typeof rec["isPaused"] !== "boolean"
    ) {
      throw new Error(`Corrupted delivery state file at ${this.filePath}: invalid state schema`);
    }
    return rec as unknown as PersistedDeliveryState;
  }

  writeState(state: PersistedDeliveryState): void {
    const nested = this.lockDepth > 0;
    if (!nested) {
      this.acquireSync();
    }
    try {
      const current = this.readRaw();
      if (this.observedRaw !== undefined && current !== this.observedRaw) {
        throw new DeliveryStateConflictError(
          `delivery state changed since it was read (${this.filePath}); re-read before writing`,
        );
      }
      this.writeRaw(state);
    } finally {
      if (!nested) {
        this.releaseSync();
      }
    }
  }

  /**
   * Exclusive read → validate → write section, serialized across processes with an atomic
   * lock directory. Reentrant per instance so `writeState` inside a section is a no-op lock.
   */
  async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  private readRaw(): string | null {
    return fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, "utf8") : null;
  }

  private writeRaw(state: PersistedDeliveryState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const serialized = JSON.stringify(state, null, 2);
    const tmpFile = path.join(
      dir,
      `.delivery-state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmpFile, serialized, "utf8");
    fs.renameSync(tmpFile, this.filePath);
    this.observedRaw = serialized;
  }

  private async acquire(): Promise<void> {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      return;
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fs.promises.mkdir(this.lockPath);
        fs.writeFileSync(path.join(this.lockPath, "owner"), String(process.pid), "utf8");
        this.lockDepth = 1;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        this.assertNotOwnedByThisProcess();
        await this.breakStaleLock();
        if (Date.now() > deadline) {
          throw new DeliveryStateConflictError(
            `timed out waiting for the delivery state lock (${this.lockPath})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  /**
   * Synchronous variant used by `writeState`, whose contract is `void`.
   *
   * Contention only happens with another process; the wait is bounded and the process is
   * about to fail or succeed a single write, so blocking briefly is preferable to silently
   * skipping the guard.
   */
  private acquireSync(): void {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      return;
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.mkdirSync(this.lockPath);
        fs.writeFileSync(path.join(this.lockPath, "owner"), String(process.pid), "utf8");
        this.lockDepth = 1;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        // A synchronous wait on a lock held by the same process would deadlock the event
        // loop; report a conflict so the caller re-reads and re-decides instead.
        this.assertNotOwnedByThisProcess();
        this.breakStaleLockSync();
        if (Date.now() > deadline) {
          throw new DeliveryStateConflictError(
            `timed out waiting for the delivery state lock (${this.lockPath})`,
          );
        }
        sleepSync(10);
      }
    }
  }

  private async release(): Promise<void> {
    if (this.lockDepth === 0) {
      return;
    }
    this.lockDepth -= 1;
    if (this.lockDepth === 0) {
      await fs.promises.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private releaseSync(): void {
    if (this.lockDepth === 0) {
      return;
    }
    this.lockDepth -= 1;
    if (this.lockDepth === 0) {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  /** A lock older than 60s belongs to a dead process; reclaim it instead of hanging. */
  private async breakStaleLock(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.lockPath);
      if (Date.now() - stat.mtimeMs > 60_000) {
        await fs.promises.rm(this.lockPath, { recursive: true, force: true });
      }
    } catch {
      /* The lock disappeared while probing; retry acquisition. */
    }
  }

  private assertNotOwnedByThisProcess(): void {
    try {
      const owner = Number(fs.readFileSync(path.join(this.lockPath, "owner"), "utf8").trim());
      if (Number.isInteger(owner) && owner === process.pid) {
        throw new DeliveryStateConflictError(
          `delivery state is already locked by this process (${this.lockPath})`,
        );
      }
    } catch (error) {
      if (error instanceof DeliveryStateConflictError) {
        throw error;
      }
      /* No owner file: an older or foreign lock, handled by the stale-lock probe. */
    }
  }

  private breakStaleLockSync(): void {
    try {
      const stat = fs.statSync(this.lockPath);
      if (Date.now() - stat.mtimeMs > 60_000) {
        fs.rmSync(this.lockPath, { recursive: true, force: true });
      }
    } catch {
      /* The lock disappeared while probing; retry acquisition. */
    }
  }
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** Bounded synchronous sleep for the file lock only. */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function parseSafeNonNegativeInteger(val: string, flagName: string): number {
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid value for ${flagName}: '${val}' must be a non-negative integer`);
  }
  return n;
}

export function parseDeliverySkillArgs(argv: readonly string[]): {
  action: "run" | "halt" | "recover-handoff";
  repo?: string | undefined;
  issueNumber?: number | undefined;
  workspaceKey?: string | undefined;
  headBranch?: string | undefined;
  baseBranch?: string | undefined;
  validationCommand?: string | undefined;
  repairCommand?: string | undefined;
  maxRepairs?: number | undefined;
  maxWait?: number | undefined;
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
} {
  let action: "run" | "halt" | "recover-handoff" = "run";
  let repo: string | undefined;
  let issueNumber: number | undefined;
  let workspaceKey: string | undefined;
  let headBranch: string | undefined;
  let baseBranch: string | undefined;
  let validationCommand: string | undefined;
  let repairCommand: string | undefined;
  let maxRepairs: number | undefined;
  let maxWait: number | undefined;
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

  let i = 0;
  if (argv[0] === "run" || argv[0] === "halt" || argv[0] === "recover-handoff" || argv[0] === "compensate-handoff") {
    action = argv[0] === "compensate-handoff" ? "recover-handoff" : (argv[0] as "run" | "halt" | "recover-handoff");
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]!;
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
    } else if (arg === "--repair-cmd" && i + 1 < argv.length) {
      repairCommand = argv[++i];
    } else if (arg === "--max-repairs" && i + 1 < argv.length) {
      maxRepairs = parseSafeNonNegativeInteger(argv[++i]!, "--max-repairs");
    } else if (arg === "--max-wait" && i + 1 < argv.length) {
      maxWait = parseSafeNonNegativeInteger(argv[++i]!, "--max-wait");
    } else if (arg === "--ready-label" && i + 1 < argv.length) {
      readyLabel = argv[++i];
    } else if (arg === "--opt-in" || arg === "--opt-in-land") {
      optInLand = true;
    } else if (arg === "--no-land") {
      optInLand = false;
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
    repairCommand,
    maxRepairs,
    maxWait,
    readyLabel,
    optInLand,
    resume,
    requiredChecks,
    cwd,
    bridgeUrl,
    bridgeToken,
    sessionId,
    reason,
    details,
  };
}

export async function runDeliverySkillCli(
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

  if (parsed.action === "recover-handoff") {
    const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
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

    const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
    let existingState: PersistedDeliveryState | null = null;
    try {
      existingState = stateStorage.readState();
    } catch {
      // ignore
    }

    const spentRepairs = existingState?.spentRepairs ?? (parsed.maxRepairs ?? 3);
    const spentWaitSeconds = existingState?.spentWaitSeconds ?? (parsed.maxWait ?? 300);
    const handoffId = `handoff-${parsed.repo.replace("/", "-")}-${parsed.issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const handoff: DeliveryHandoff = {
      reason,
      details,
      repo: parsed.repo,
      issueNumber: parsed.issueNumber,
      headBranch: parsed.headBranch ?? `symphony/GH-${parsed.issueNumber}`,
      prNumber: null,
      prUrl: null,
      headSha: null,
      spentRepairs,
      maxRepairs: parsed.maxRepairs ?? spentRepairs,
      spentWaitSeconds,
      maxWaitSeconds: parsed.maxWait ?? spentWaitSeconds,
      readyLabel,
      readyLabelRemoved: false,
      commentPosted: false,
      handoffId,
    };

    // 先持久化 paused 状态和待补偿事实
    await stateStorage.writeState({
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
    await stateStorage.writeState({
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
    await stateStorage.writeState({
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

  const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));

  let reviewGate = customReviewGate;
  let plan: DecisionMaterializedPlan | null | undefined = undefined;
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
      // The planning gate verifies the current Issue requirements against the
      // durable plan. If GitHub facts cannot be read, fail closed instead of
      // silently skipping the requirement-drift check.
      let requirements: { readonly title: string; readonly body: string };
      try {
        const viewRes = await runner.gh(
          ["issue", "view", String(parsed.issueNumber), "--json", "title,body", "--repo", parsed.repo],
          cwd,
        );
        if (viewRes.exitCode !== 0) {
          throw new Error(viewRes.stderr || `gh issue view exited ${viewRes.exitCode}`);
        }
        const data = JSON.parse(viewRes.stdout || "{}");
        if (!data || typeof data.title !== "string") {
          throw new Error("Issue view response is missing a string title");
        }
        requirements = { title: data.title, body: typeof data.body === "string" ? data.body : "" };
      } catch (err) {
        io.stderr.write(
          `symphony delivery-skill: error: failed to read current Issue #${parsed.issueNumber} requirements for planning gate verification: ${String(err)}\n`,
        );
        return 1;
      }

      const planningGate = new DecisionPlanningGate(client);
      const eligibility = await planningGate.verifyPlanEligibility(sId, requirements);
      if (!eligibility.eligible) {
        io.stderr.write(`symphony delivery-skill: error: planning gate verification failed: ${eligibility.reason}\n`);
        return 1;
      }
      if (eligibility.plan) {
        plan = eligibility.plan;
      }
    }
  }

  const options: RunDeliverySkillOptions = {
    cwd,
    repo: parsed.repo,
    issueNumber: parsed.issueNumber,
    workspaceKey,
    headBranch,
    baseBranch,
    validationCommand: parsed.validationCommand,
    repairCommand: parsed.repairCommand,
    maxRepairAttempts: parsed.maxRepairs,
    maxWaitSeconds: parsed.maxWait,
    readyLabel,
    optInLand: parsed.optInLand,
    resume: parsed.resume,
    requiredChecks: parsed.requiredChecks,
    reviewGate,
    sessionId: parsed.sessionId,
    plan,
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
    if (result.handoffMarkdown) {
      io.stdout.write(result.handoffMarkdown + "\n");
    }
    return 1;
  } catch (err) {
    io.stderr.write(`symphony delivery-skill: execution error: ${String(err)}\n`);
    return 1;
  }
}
