import crypto from "node:crypto";
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

/**
 * File-backed Delivery state storage with a **ticket-directory** mutex.
 *
 * Every acquirer creates a ticket directory named by a number strictly greater than any
 * ticket currently visible, and the live ticket with the **lowest number** owns the critical
 * section. The number is a total order established by directory-creation exclusivity, not by
 * clocks, so a later contender can never outrank a running owner.
 *
 * Crucially, ownership is never "taken over": a live owner's ticket is never removed and the
 * shared namespace is never vacated. Only a ticket whose recorded process is provably gone is
 * deleted, and each ticket lives at its own unique path, so deleting one cannot affect any
 * other owner. There is therefore no window in which two processes both believe they own the
 * section — the failure mode that check-then-delete and rename-then-verify both still had.
 */
export class FileDeliveryStateStorage implements DeliveryStateStorage {
  private readonly lockRoot: string;
  /**
   * Raw file content this instance last read (or wrote). A write whose base content changed
   * is rejected instead of overwriting a newer handoff / HEAD.
   */
  private observedRaw: string | null | undefined = undefined;
  private lockDepth = 0;
  /** This instance's ticket number; release removes only this exact ticket. */
  private lockTicket: number | null = null;

  constructor(
    private readonly filePath: string,
    private readonly lockTimeoutMs = 10_000,
  ) {
    this.lockRoot = path.join(path.dirname(filePath), ".delivery-state.lock");
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
    const ticket = this.takeTicket();
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      for (;;) {
        const winner = this.evaluateWinner();
        if (winner !== null && winner.ticket === ticket) {
          this.lockTicket = ticket;
          this.lockDepth = 1;
          return;
        }
        if (Date.now() > deadline) {
          throw new DeliveryStateConflictError(
            `timed out waiting for the delivery state lock (${this.lockRoot})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      if (this.lockDepth === 0) {
        this.releaseTicket(ticket);
      }
    }
  }

  /**
   * Synchronous variant used by `writeState`, whose contract is `void`.
   *
   * Waiting on a same-process owner would deadlock the event loop, so that case reports a
   * conflict instead; a foreign live owner is never preempted.
   */
  private acquireSync(): void {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      return;
    }
    const ticket = this.takeTicket();
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      for (;;) {
        const winner = this.evaluateWinner();
        if (winner !== null && winner.ticket === ticket && winner.pid === process.pid) {
          this.lockTicket = ticket;
          this.lockDepth = 1;
          return;
        }
        if (winner !== null && winner.ticket !== ticket && winner.pid === process.pid) {
          throw new DeliveryStateConflictError(
            `delivery state is already locked by this process (${this.lockRoot})`,
          );
        }
        if (Date.now() > deadline) {
          throw new DeliveryStateConflictError(
            `timed out waiting for the delivery state lock (${this.lockRoot})`,
          );
        }
        sleepSync(10);
      }
    } finally {
      if (this.lockDepth === 0) {
        this.releaseTicket(ticket);
      }
    }
  }

  private async release(): Promise<void> {
    if (this.lockDepth === 0) {
      return;
    }
    this.lockDepth -= 1;
    if (this.lockDepth === 0) {
      this.releaseLockIfOwned();
    }
  }

  private releaseSync(): void {
    if (this.lockDepth === 0) {
      return;
    }
    this.lockDepth -= 1;
    if (this.lockDepth === 0) {
      this.releaseLockIfOwned();
    }
  }

  private get ticketRoot(): string {
    return path.join(this.lockRoot, "tickets");
  }

  private ticketDir(ticket: number): string {
    return path.join(this.ticketRoot, String(ticket));
  }

  private tombstoneDir(ticket: number): string {
    return path.join(this.ticketRoot, `released-${ticket}`);
  }

  /**
   * Allocates a ticket that is **provably above every other visible ticket**.
   *
   * Registration is two syscalls (`mkdir` then publishing `owner.json`), so a candidate can
   * be based on a stale directory listing, and another process can observe the directory
   * before it is published. Both cases are handled explicitly:
   *
   * - the published ticket is re-read to prove the directory was not reaped meanwhile;
   * - the candidate is compared against the whole current namespace and abandoned when any
   *   other ticket has a number at least as large (a stale snapshot or a freed number must
   *   never enter below a running owner);
   * - an unpublished ticket is not skipped by `evaluateWinner`; it keeps its position and
   *   blocks every higher ticket.
   */
  private takeTicket(): number {
    fs.mkdirSync(this.ticketRoot, { recursive: true });
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const candidate = this.highestTicket() + 1;
      if (!this.publishTicket(candidate)) {
        continue;
      }
      if (candidate <= this.highestOtherTicket(candidate)) {
        this.tombstone(candidate);
        continue;
      }
      return candidate;
    }
    throw new DeliveryStateConflictError(`delivery state ticket space exhausted (${this.lockRoot})`);
  }

  /** Creates the ticket directory and publishes its owner atomically enough to verify. */
  private publishTicket(ticket: number): boolean {
    try {
      fs.mkdirSync(this.ticketDir(ticket));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
    const token = crypto.randomUUID();
    try {
      fs.writeFileSync(
        path.join(this.ticketDir(ticket), "owner.json"),
        JSON.stringify({ pid: process.pid, token, ticket }),
        "utf8",
      );
    } catch {
      this.tombstone(ticket);
      return false;
    }
    const published = this.readOwner(ticket);
    if (published.kind !== "ok" || published.token !== token) {
      // Reaped as a stale registration between mkdir and write, or the owner record cannot
      // be verified. Either way this candidate must not be used.
      this.tombstone(ticket);
      return false;
    }
    return true;
  }

  /**
   * Reads a ticket's owner **without conflating absence with unreadability**.
   *
   * `missing` is the only state that may be treated as "not published yet". Any read or
   * parse failure is `unreadable` — evidence is unavailable, so no caller may infer that the
   * owner is gone or that the ticket is stale.
   */
  protected readOwner(ticket: number):
    | { readonly kind: "ok"; readonly pid: number; readonly token: string }
    | { readonly kind: "missing" }
    | { readonly kind: "unreadable"; readonly reason: string } {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.ticketDir(ticket), "owner.json"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "unreadable", reason: `read failed: ${String(code ?? error)}` };
    }
    try {
      const raw = JSON.parse(text) as { pid?: unknown; token?: unknown };
      if (
        typeof raw.pid !== "number" ||
        !Number.isInteger(raw.pid) ||
        typeof raw.token !== "string"
      ) {
        return { kind: "unreadable", reason: "invalid owner record" };
      }
      return { kind: "ok", pid: raw.pid, token: raw.token };
    } catch {
      return { kind: "unreadable", reason: "invalid owner JSON" };
    }
  }

  /** Ticket directory metadata, keeping "gone" distinct from "cannot tell". */
  protected ticketStat(ticket: number):
    | { readonly kind: "ok"; readonly mtimeMs: number }
    | { readonly kind: "gone" }
    | { readonly kind: "error"; readonly reason: string } {
    try {
      return { kind: "ok", mtimeMs: fs.statSync(this.ticketDir(ticket)).mtimeMs };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT"
        ? { kind: "gone" }
        : { kind: "error", reason: String(code ?? error) };
    }
  }

  /** Highest number ever allocated, including retained tombstones. */
  protected highestTicket(): number {
    return this.highestMatching(Number.POSITIVE_INFINITY);
  }

  private highestOtherTicket(exclude: number): number {
    return this.highestMatching(exclude);
  }

  private highestMatching(exclude: number): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.ticketRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
    let highest = 0;
    for (const name of names) {
      const released = /^released-(\d+)$/.exec(name);
      const ticket = released ? Number(released[1]) : Number(name);
      if (!Number.isInteger(ticket) || ticket <= 0 || ticket === exclude) {
        continue;
      }
      if (ticket > highest) {
        highest = ticket;
      }
    }
    return highest;
  }

  /** Retires a ticket number without ever reusing it below a running owner. */
  private tombstone(ticket: number): void {
    const source = this.ticketDir(ticket);
    const target = this.tombstoneDir(ticket);
    if (!fs.existsSync(target)) {
      try {
        fs.renameSync(source, target);
      } catch {
        /* Already tombstoned or removed by another process. */
      }
    } else {
      try {
        fs.rmSync(source, { recursive: true, force: true });
      } catch {
        /* Already gone. */
      }
    }
    this.pruneTombstones();
  }

  /** Keeps only the highest tombstone; lower ones can never affect allocation. */
  private pruneTombstones(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.ticketRoot);
    } catch {
      return;
    }
    const tombstones = names
      .map((name) => {
        const match = /^released-(\d+)$/.exec(name);
        return match ? Number(match[1]) : null;
      })
      .filter((value): value is number => value !== null);
    if (tombstones.length <= 1) {
      return;
    }
    const highest = Math.max(...tombstones);
    for (const ticket of tombstones) {
      if (ticket === highest) {
        continue;
      }
      try {
        fs.rmSync(this.tombstoneDir(ticket), { recursive: true, force: true });
      } catch {
        /* Already gone. */
      }
    }
  }

  private releaseTicket(ticket: number): void {
    this.tombstone(ticket);
    // The lock root is left in place while any ticket or tombstone exists.
    try {
      fs.rmdirSync(this.lockRoot);
    } catch {
      /* Still in use. */
    }
  }

  /**
   * Returns the ticket that may enter the critical section: the lowest **live or
   * not-yet-published** ticket.
   *
   * An unpublished registration is deliberately treated as a blocking contender rather than
   * skipped — skipping it would let a higher ticket enter while the lower one is still about
   * to publish, which is exactly how two owners could overlap. Only a registration older
   * than the grace period is considered crashed and reaped; a live registrant detects the
   * reaping through its post-publish verification and retries.
   */
  private evaluateWinner(): { ticket: number; pid: number } | null {
    let names: string[];
    try {
      names = fs.readdirSync(this.ticketRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const live: Array<{ ticket: number; pid: number }> = [];
    for (const name of names) {
      if (/^released-\d+$/.test(name)) {
        continue;
      }
      const ticket = Number(name);
      if (!Number.isInteger(ticket) || ticket <= 0) {
        continue;
      }
      const owner = this.readOwner(ticket);
      if (owner.kind === "unreadable") {
        // Evidence is unavailable: never infer staleness from a failed read. The ticket
        // keeps its place and blocks everyone else (fail safe).
        live.push({ ticket, pid: -1 });
        continue;
      }
      if (owner.kind === "missing") {
        const stat = this.ticketStat(ticket);
        if (stat.kind === "gone") {
          continue;
        }
        if (stat.kind === "error") {
          // Metadata is unavailable too: treat as an unknown blocker, not as death.
          live.push({ ticket, pid: -1 });
          continue;
        }
        if (Date.now() - stat.mtimeMs > REGISTRATION_GRACE_MS) {
          // Published owner never appeared and the directory is old: crashed registration.
          this.tombstone(ticket);
        } else {
          // Not published yet: keeps its place and blocks every higher ticket.
          live.push({ ticket, pid: -1 });
        }
        continue;
      }
      if (owner.pid === process.pid || isProcessAlive(owner.pid)) {
        live.push({ ticket, pid: owner.pid });
      } else {
        this.tombstone(ticket);
      }
    }

    live.sort((a, b) => a.ticket - b.ticket);
    return live[0] ?? null;
  }

  private releaseLockIfOwned(): void {
    const ticket = this.lockTicket;
    this.lockTicket = null;
    if (ticket === null) {
      return;
    }
    this.releaseTicket(ticket);
  }
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** How long an unpublished ticket blocks before it is considered a crashed registration. */
const REGISTRATION_GRACE_MS = 5_000;

/** `kill(pid, 0)` probes liveness without signalling; EPERM still means the process exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

  // Narrowed once so the value survives into the Delivery critical-section callback.
  const repo = parsed.repo;
  const issueNumber = parsed.issueNumber;

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
    const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));
    // The whole halt handoff — read → remove label → post report → final write — is one
    // Delivery authority critical section. A compensator can therefore never observe the
    // pending handoff and post a second report for the same handoff id.
    return await stateStorage.withExclusive(async () => {
    const reason = (parsed.reason ?? "budget_exhausted") as DeliveryHandoff["reason"];
    const details = parsed.details ?? "Delivery budget exhausted or manual blocker triggered.";

    let existingState: PersistedDeliveryState | null = null;
    try {
      existingState = stateStorage.readState();
    } catch {
      // ignore
    }

    const spentRepairs = existingState?.spentRepairs ?? (parsed.maxRepairs ?? 3);
    const spentWaitSeconds = existingState?.spentWaitSeconds ?? (parsed.maxWait ?? 300);
    const handoffId = `handoff-${repo.replace("/", "-")}-${issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const handoff: DeliveryHandoff = {
      reason,
      details,
      repo: repo,
      issueNumber: issueNumber,
      headBranch: parsed.headBranch ?? `symphony/GH-${issueNumber}`,
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
      repo: repo,
      issueNumber: issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${issueNumber}`),
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
        ["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", readyLabel],
        cwd,
      );
      if (editRes.exitCode !== 0) {
        labelCheckError = `Failed to remove label '${readyLabel}': ${editRes.stderr}`;
      } else {
        // 检查标签事实
        const labelCheck = await runner.gh(
          ["issue", "view", String(issueNumber), "--repo", repo, "--json", "labels"],
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
                labelCheckError = `Label '${readyLabel}' is still present on issue #${issueNumber}`;
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
      repo: repo,
      issueNumber: issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${issueNumber}`),
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
        ["issue", "comment", String(issueNumber), "--repo", repo, "--body", handoffMarkdown],
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
      repo: repo,
      issueNumber: issueNumber,
      workspaceKey: parsed.workspaceKey ?? (existingState?.workspaceKey ?? `GH-${issueNumber}`),
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
        `symphony delivery-skill: halt failed: could not remove label '${readyLabel}' from issue #${issueNumber} (${labelCheckError ?? "unverified"}). Dispatch not halted.\n`,
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
    });
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
