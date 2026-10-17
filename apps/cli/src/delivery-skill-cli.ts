import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  recoverDeliveryHandoff,
  runDeliverySkill,
  type DeliveryGitGhRunner,
  type DeliveryLock,
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

class InProcessMutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = this.queue;
    this.queue = current.then(() => next);
    await current;
    return release;
  }
}

function getCanonicalLockPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const canonicalDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  const lockBase = base.endsWith(".lock") ? base : `${base}.lock`;
  return path.join(canonicalDir, lockBase);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as { code?: string };
    return error.code === "EPERM";
  }
}

const fileMutexes = new Map<string, InProcessMutex>();

export interface FileDeliveryLockOptions {
  timeoutMs?: number | undefined;
  inProcessMutex?: boolean | undefined;
  _beforeStaleReclaimRetire?: (() => void) | undefined;
  _beforeReclaimRelease?: (() => void) | undefined;
}

export class FileDeliveryLock implements DeliveryLock {
  private inProcessRelease: (() => void) | null = null;
  private lockFd: number | null = null;
  private lockToken: string | null = null;
  private readonly lockFilePath: string;
  private readonly timeoutMs: number;
  private readonly inProcessMutex: boolean;
  private readonly beforeStaleReclaimRetire?: (() => void) | undefined;
  private readonly beforeReclaimRelease?: (() => void) | undefined;

  constructor(filePath: string, options?: FileDeliveryLockOptions) {
    this.lockFilePath = getCanonicalLockPath(filePath);
    this.timeoutMs = options?.timeoutMs ?? 30000;
    this.inProcessMutex = options?.inProcessMutex ?? true;
    this.beforeStaleReclaimRetire = options?._beforeStaleReclaimRetire;
    this.beforeReclaimRelease = options?._beforeReclaimRelease;
  }

  private tryReclaimAndAcquire(token: string, observedStat: fs.Stats): boolean {
    const reclaimPath = `${this.lockFilePath}.reclaim`;
    const reclaimToken = crypto.randomUUID();
    let reclaimFd: number | null = null;
    try {
      try {
        reclaimFd = fs.openSync(reclaimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
        fs.writeFileSync(reclaimFd, JSON.stringify({ pid: process.pid, token: reclaimToken, time: Date.now() }), "utf8");
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error && error.code === "EEXIST") {
          try {
            const reclaimStat = fs.statSync(reclaimPath);
            let reclaimOwnerAlive = true;
            let validJson = false;
            let existingToken: string | null = null;
            try {
              const data = JSON.parse(fs.readFileSync(reclaimPath, "utf8"));
              if (typeof data.pid === "number") {
                reclaimOwnerAlive = isProcessAlive(data.pid);
                validJson = true;
              }
              if (typeof data.token === "string") {
                existingToken = data.token;
              }
            } catch {
              // empty or corrupt reclaim lock
            }

            // CRITICAL (Blocker 2 & Round 7 Blocker):
            // 1. A living arbitrator MUST NEVER be preempted merely due to elapsed time.
            // 2. Retiring a stale arbitrator MUST NOT delete or steal a newly established living successor.
            // Only clean up if the owner process is confirmed dead (!reclaimOwnerAlive),
            // or if the file is corrupt/empty (!validJson) AND stale (> 60000ms).
            const isStale = Date.now() - reclaimStat.mtimeMs > 60000;
            if ((!reclaimOwnerAlive && isStale) || (!validJson && isStale)) {
              // Mutex directory to arbitrate retirement among competing cleaners
              const authDir = `${reclaimPath}.retire-${reclaimStat.ino}`;
              const authOwnerToken = crypto.randomUUID();
              const authOwnerPath = path.join(authDir, "owner.json");
              let acquiredAuth = false;
              let authOwnerFd: number | null = null;

              // Ensure the authority directory container exists (never renamed or moved)
              try {
                fs.mkdirSync(authDir);
              } catch (err: unknown) {
                const error = err as { code?: string };
                if (!error || error.code !== "EEXIST") {
                  return false;
                }
              }

              // Attempt exclusive creation of owner.json
              try {
                authOwnerFd = fs.openSync(authOwnerPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
                fs.writeFileSync(
                  authOwnerFd,
                  JSON.stringify({
                    pid: process.pid,
                    token: authOwnerToken,
                    createdAt: Date.now(),
                  }),
                  "utf8"
                );
                acquiredAuth = true;
              } catch (err: unknown) {
                const error = err as { code?: string };
                if (error && error.code === "EEXIST") {
                  // owner.json already exists: inspect ownership
                  try {
                    const ownerStat = fs.statSync(authOwnerPath);
                    let authOwnerAlive = false;
                    let validAuthJson = false;

                    try {
                      const authData = JSON.parse(fs.readFileSync(authOwnerPath, "utf8"));
                      if (typeof authData.pid === "number") {
                        authOwnerAlive = isProcessAlive(authData.pid);
                        validAuthJson = true;
                      }
                    } catch {
                      // empty or invalid JSON (e.g. "{" or corrupted)
                    }

                    if (validAuthJson && authOwnerAlive) {
                      // CRITICAL: A living owner MUST NEVER be preempted, regardless of elapsed time!
                      acquiredAuth = false;
                    } else {
                      // It is abandoned if:
                      // 1. Valid owner record exists but owner process is confirmed DEAD (!authOwnerAlive).
                      // 2. Corrupt/empty owner record (!validAuthJson) and the file or directory is aged (> 5000ms).
                      const dirAge = Date.now() - fs.statSync(authDir).mtimeMs;
                      const fileAge = Date.now() - ownerStat.mtimeMs;
                      const isAbandoned =
                        (validAuthJson && !authOwnerAlive) ||
                        (!validAuthJson && (fileAge > 5000 || dirAge > 5000));

                      if (isAbandoned) {
                        // Safe eviction of abandoned metadata:
                        // Never rename authDir itself to avoid exposing idle path gaps.
                        // Verify inode and mtime haven't changed, and re-verify not living before unlinking.
                        let canUnlink = false;
                        try {
                          const curStat = fs.statSync(authOwnerPath);
                          if (curStat.ino === ownerStat.ino && curStat.mtimeMs === ownerStat.mtimeMs) {
                            try {
                              const curData = JSON.parse(fs.readFileSync(authOwnerPath, "utf8"));
                              if (typeof curData.pid === "number" && isProcessAlive(curData.pid)) {
                                canUnlink = false;
                              } else {
                                canUnlink = true;
                              }
                            } catch {
                              canUnlink = true;
                            }
                          }
                        } catch {
                          canUnlink = false;
                        }

                        if (canUnlink) {
                          try {
                            fs.unlinkSync(authOwnerPath);
                          } catch {
                            // lost race to another unlinker
                          }
                          // Now try O_CREAT | O_EXCL
                          try {
                            authOwnerFd = fs.openSync(authOwnerPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
                            fs.writeFileSync(
                              authOwnerFd,
                              JSON.stringify({
                                pid: process.pid,
                                token: authOwnerToken,
                                createdAt: Date.now(),
                              }),
                              "utf8"
                            );
                            acquiredAuth = true;
                          } catch {
                            acquiredAuth = false;
                          }
                        }
                      }
                    }
                  } catch {
                    acquiredAuth = false;
                  }
                } else {
                  acquiredAuth = false;
                }
              }

              if (acquiredAuth && authOwnerFd !== null) {
                try {
                  if (this.beforeStaleReclaimRetire) {
                    try {
                      this.beforeStaleReclaimRetire();
                    } catch {
                      // ignore hook error
                    }
                  }

                  // CRITICAL (Round 10 Commit Fence):
                  // Verify that our open file descriptor is still linked (nlink === 1),
                  // its inode matches the path on disk, and the content matches our token and PID!
                  try {
                    const fstat = fs.fstatSync(authOwnerFd);
                    if (fstat.nlink !== 1) {
                      return false;
                    }
                    const curStat = fs.statSync(authOwnerPath);
                    if (curStat.ino !== fstat.ino) {
                      return false;
                    }
                    const curData = JSON.parse(fs.readFileSync(authOwnerPath, "utf8"));
                    if (curData.token !== authOwnerToken || curData.pid !== process.pid) {
                      return false;
                    }
                  } catch {
                    return false;
                  }

                  // Verify identity before retirement: inode, mtime, and token must still match
                  const currentReclaimStat = fs.statSync(reclaimPath);
                  if (currentReclaimStat.ino !== reclaimStat.ino || currentReclaimStat.mtimeMs !== reclaimStat.mtimeMs) {
                    return false;
                  }

                  if (validJson && existingToken !== null) {
                    try {
                      const currentData = JSON.parse(fs.readFileSync(reclaimPath, "utf8"));
                      if (currentData.token !== existingToken) {
                        return false;
                      }
                    } catch {
                      return false;
                    }
                  }

                  // Safely retire via atomic rename to unique tombstone then unlink
                  const tombstone = `${reclaimPath}.retired.${reclaimStat.ino}.${Date.now()}.${crypto.randomUUID()}`;
                  try {
                    fs.renameSync(reclaimPath, tombstone);
                    try {
                      fs.unlinkSync(tombstone);
                    } catch {
                      // ignore
                    }
                    // Attempt immediate acquisition of reclaimPath now that stale file is retired
                    try {
                      reclaimFd = fs.openSync(reclaimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
                      fs.writeFileSync(reclaimFd, JSON.stringify({ pid: process.pid, token: reclaimToken, time: Date.now() }), "utf8");
                    } catch {
                      // grabbed by another contender or failed, will retry in loop
                    }
                  } catch {
                    // ignore rename error
                  }
                } catch {
                  // ignore
                } finally {
                  if (authOwnerFd !== null) {
                    try {
                      fs.closeSync(authOwnerFd);
                    } catch {
                      // ignore
                    }
                    authOwnerFd = null;
                  }

                  // Release authority:
                  // Only remove our own owner.json if it still contains our token and PID!
                  try {
                    let isOurToken = false;
                    try {
                      if (fs.existsSync(authOwnerPath)) {
                        const d = JSON.parse(fs.readFileSync(authOwnerPath, "utf8"));
                        if (d.token === authOwnerToken && d.pid === process.pid) {
                          isOurToken = true;
                        }
                      }
                    } catch {
                      isOurToken = false;
                    }

                    if (isOurToken) {
                      try {
                        fs.unlinkSync(authOwnerPath);
                      } catch {
                        // ignore
                      }
                      try {
                        fs.rmdirSync(authDir);
                      } catch {
                        // ignore if directory not empty
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
              }
            }
          } catch {
            // ignore
          }
          if (reclaimFd === null) {
            return false;
          }
        } else {
          return false;
        }
      }

      // We hold exclusive reclamation arbitration.
      // Re-verify that the lock file still matches observed identity (inode and mtime)
      try {
        const currentStat = fs.statSync(this.lockFilePath);
        if (currentStat.ino !== observedStat.ino || currentStat.mtimeMs !== observedStat.mtimeMs) {
          // File identity changed: someone else replaced it or touched it; abort reclamation
          return false;
        }

        let ownerAlive = true;
        let validJson = false;
        try {
          const content = fs.readFileSync(this.lockFilePath, "utf8");
          const data = JSON.parse(content);
          if (typeof data.pid === "number") {
            ownerAlive = isProcessAlive(data.pid);
            validJson = true;
          }
        } catch {
          // empty or corrupt
        }

        const isStale = Date.now() - currentStat.mtimeMs > 60000;
        if (!((!ownerAlive && isStale) || (!validJson && isStale))) {
          // No longer stale
          return false;
        }

        // Stale file identity confirmed. Safely unlink the stale file.
        fs.unlinkSync(this.lockFilePath);
      } catch (statErr: unknown) {
        const error = statErr as { code?: string };
        if (!error || error.code !== "ENOENT") {
          return false;
        }
      }

      // Atomically create the new lock file before releasing reclaim arbitration
      try {
        this.lockFd = fs.openSync(this.lockFilePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
        fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, token, time: Date.now() }), "utf8");
        this.lockToken = token;
        return true;
      } catch {
        if (this.lockFd !== null) {
          try {
            fs.closeSync(this.lockFd);
          } catch {
            // ignore
          }
          this.lockFd = null;
          try {
            fs.unlinkSync(this.lockFilePath);
          } catch {
            // ignore
          }
        }
        return false;
      }
    } finally {
      if (reclaimFd !== null) {
        try {
          fs.closeSync(reclaimFd);
        } catch {
          // ignore
        }
        reclaimFd = null;
        try {
          if (this.beforeReclaimRelease) {
            try {
              this.beforeReclaimRelease();
            } catch {
              // ignore
            }
          }
          // Token-bound release: Only delete reclaimPath if it still contains our own reclaimToken!
          if (fs.existsSync(reclaimPath)) {
            const content = fs.readFileSync(reclaimPath, "utf8");
            const data = JSON.parse(content);
            if (data.token === reclaimToken) {
              const releaseTombstone = `${reclaimPath}.released.${crypto.randomUUID()}`;
              try {
                fs.renameSync(reclaimPath, releaseTombstone);
                try {
                  fs.unlinkSync(releaseTombstone);
                } catch {
                  // ignore
                }
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  async acquire(): Promise<void> {
    let releaseMutex: (() => void) | null = null;
    if (this.inProcessMutex) {
      let mutex = fileMutexes.get(this.lockFilePath);
      if (!mutex) {
        mutex = new InProcessMutex();
        fileMutexes.set(this.lockFilePath, mutex);
      }
      releaseMutex = await mutex.acquire();
      this.inProcessRelease = releaseMutex;
    }

    try {
      const lockDir = path.dirname(this.lockFilePath);
      if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
      }

      const token = crypto.randomUUID();
      const start = Date.now();
      while (true) {
        try {
          this.lockFd = fs.openSync(this.lockFilePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
          fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, token, time: Date.now() }), "utf8");
          this.lockToken = token;
          break;
        } catch (err: unknown) {
          const error = err as { code?: string };
          if (error && error.code === "EEXIST") {
            let reclaimed = false;
            try {
              const stat = fs.statSync(this.lockFilePath);
              let ownerAlive = true;
              let validJson = false;
              try {
                const content = fs.readFileSync(this.lockFilePath, "utf8");
                const data = JSON.parse(content);
                if (typeof data.pid === "number") {
                  ownerAlive = isProcessAlive(data.pid);
                  validJson = true;
                }
              } catch {
                // unable to read/parse: empty or corrupted lock file
              }

              const isStale = Date.now() - stat.mtimeMs > 60000;
              if ((!ownerAlive && isStale) || (!validJson && isStale)) {
                if (this.tryReclaimAndAcquire(token, stat)) {
                  reclaimed = true;
                }
              }
            } catch {
              // ignore stat/read failure and proceed to timeout check
            }

            if (reclaimed) {
              break;
            }

            // CRITICAL (Blocker 1): All retry paths MUST pass through deadline check and yield
            if (Date.now() - start > this.timeoutMs) {
              throw new Error(`Timed out waiting for delivery lock at ${this.lockFilePath}`);
            }
            await new Promise((r) => setTimeout(r, 50));
          } else {
            if (this.lockFd !== null) {
              try {
                fs.closeSync(this.lockFd);
              } catch {
                // ignore
              }
              this.lockFd = null;
              try {
                fs.unlinkSync(this.lockFilePath);
              } catch {
                // ignore
              }
            }
            throw err;
          }
        }
      }
    } catch (err) {
      if (this.inProcessRelease) {
        const rel = this.inProcessRelease;
        this.inProcessRelease = null;
        rel();
      }
      if (this.lockFd !== null) {
        try {
          fs.closeSync(this.lockFd);
        } catch {
          // ignore
        }
        this.lockFd = null;
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          // ignore
        }
      }
      this.lockToken = null;
      throw err;
    }
  }

  async release(): Promise<void> {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {
        // ignore
      }
      this.lockFd = null;
    }
    if (this.lockToken !== null) {
      const tokenToRelease = this.lockToken;
      this.lockToken = null;
      try {
        if (fs.existsSync(this.lockFilePath)) {
          const content = fs.readFileSync(this.lockFilePath, "utf8");
          const data = JSON.parse(content);
          if (data.token === tokenToRelease) {
            fs.unlinkSync(this.lockFilePath);
          }
        }
      } catch {
        // ignore
      }
    }
    if (this.inProcessRelease) {
      const rel = this.inProcessRelease;
      this.inProcessRelease = null;
      rel();
    }
  }
}

const sharedLocks = new Map<string, DeliveryLock>();

export function getOrCreateDeliveryLock(filePath: string): DeliveryLock {
  const normalized = getCanonicalLockPath(filePath);
  let lock = sharedLocks.get(normalized);
  if (!lock) {
    lock = new FileDeliveryLock(normalized);
    sharedLocks.set(normalized, lock);
  }
  return lock;
}

export class FileDeliveryStateStorage implements DeliveryStateStorage {
  public readonly lock: DeliveryLock;

  constructor(private readonly filePath: string, lock?: DeliveryLock) {
    this.lock = lock ?? getOrCreateDeliveryLock(filePath);
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
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = path.join(
      dir,
      `.delivery-state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpFile, this.filePath);
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
      lock: stateStorage.lock,
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
    await stateStorage.lock.acquire();
    try {
      let existingState: PersistedDeliveryState | null = null;
      try {
        existingState = stateStorage.readState();
      } catch {
        // ignore
      }

      if (
        existingState?.isPaused &&
        !existingState.pendingCompensation &&
        existingState.readyLabelRemoved &&
        existingState.commentPosted
      ) {
        io.stdout.write("symphony delivery-skill: dispatch already halted and compensated\n");
        return 0;
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
    stateStorage.writeState({
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
    } finally {
      await stateStorage.lock.release();
    }
  }

  const headBranch = parsed.headBranch ?? `symphony/GH-${parsed.issueNumber}`;
  const baseBranch = parsed.baseBranch ?? "main";
  const workspaceKey = parsed.workspaceKey ?? `GH-${parsed.issueNumber}`;

  const stateStorage = new FileDeliveryStateStorage(path.join(cwd, ".symphony", "delivery-state.json"));

  let existingDeliveryState: PersistedDeliveryState | null = null;
  await stateStorage.lock.acquire();
  try {
    existingDeliveryState = stateStorage.readState();
  } catch {
    // ignore
  } finally {
    await stateStorage.lock.release();
  }

  if (existingDeliveryState?.isPaused && !parsed.resume) {
    io.stderr.write(
      `symphony delivery-skill: delivery is paused (${existingDeliveryState.pauseReason ?? "manual intervention required"}). Use --resume or recover-handoff first.\n`,
    );
    return 1;
  }

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
