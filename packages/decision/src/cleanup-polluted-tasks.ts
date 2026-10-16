import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DecisionTask } from "@symphony/domain";
import { DecisionStoreLockError } from "./errors.js";
import { DecisionService } from "./service.js";
import { DurableDecisionStore } from "./store.js";

export interface CleanupPollutedTasksOptions {
  readonly store?: string | null | undefined;
  readonly bridgeUrl?: string | null | undefined;
  readonly token?: string | null | undefined;
  readonly session?: string | undefined;
  readonly apply?: boolean | undefined;
  readonly help?: boolean | undefined;
}

export interface CleanupPollutedTasksResult {
  readonly matched: number;
  readonly cancelled: number;
  readonly taskIds: readonly string[];
}

export interface CleanupIo {
  log(message: string): void;
  error?(message: string): void;
}

export function parseArgs(argv: readonly string[]): CleanupPollutedTasksOptions {
  let store: string | null = null;
  let bridgeUrl: string | null = null;
  let token: string | null = null;
  let session = "github:felixjichao/symphony-ts#99";
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--store") {
      store = argv[++i] ?? null;
    } else if (arg.startsWith("--store=")) {
      store = arg.slice("--store=".length);
    } else if (arg === "--bridge-url") {
      bridgeUrl = argv[++i] ?? null;
    } else if (arg.startsWith("--bridge-url=")) {
      bridgeUrl = arg.slice("--bridge-url=".length);
    } else if (arg === "--token") {
      token = argv[++i] ?? null;
    } else if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
    } else if (arg === "--session") {
      session = argv[++i] ?? session;
    } else if (arg.startsWith("--session=")) {
      session = arg.slice("--session=".length);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { store, bridgeUrl, token, session, apply, help: false };
}

export async function cleanupPollutedTasks(
  options: CleanupPollutedTasksOptions,
  io: CleanupIo = console,
): Promise<CleanupPollutedTasksResult> {
  const { store, bridgeUrl, token, session, apply } = options;

  if (store && bridgeUrl) {
    throw new Error("Conflicting options: Cannot specify both --store and --bridge-url");
  }
  if (!store && !bridgeUrl) {
    throw new Error("Must specify either --store <dir> or --bridge-url <url>");
  }
  if (!session || typeof session !== "string" || !session.trim()) {
    throw new Error("Target session ID must be non-empty");
  }

  const targetSessionId = session.trim();
  const cancelledTaskIds: string[] = [];

  if (store) {
    const resolvedStoreDir = path.resolve(store);
    const storePath = path.join(resolvedStoreDir, "store.json");
    try {
      await fs.access(storePath);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
        io.log(`Store file not found at ${storePath}. Nothing to clean up.`);
        return { matched: 0, cancelled: 0, taskIds: [] };
      }
      throw err;
    }

    const storeInstance = new DurableDecisionStore({ storeDir: resolvedStoreDir });
    try {
      await storeInstance.open();
    } catch (err) {
      if (
        err instanceof DecisionStoreLockError ||
        (err && typeof err === "object" && (err as { name?: string }).name === "DecisionStoreLockError")
      ) {
        throw new Error(
          `Store directory "${resolvedStoreDir}" is currently locked by a running process. Local modification is rejected to prevent data corruption; use --bridge-url instead while the service is active.`
        );
      }
      throw err;
    }

    try {
      const decisionService = new DecisionService(storeInstance);
      const allTasks = storeInstance.getTasksForSession(targetSessionId);
      const targetTasks = allTasks.filter((t): t is DecisionTask => {
        return (
          Boolean(t) &&
          t.sessionId === targetSessionId &&
          t.kind === "plan" &&
          ["pending", "claimed", "running"].includes(t.status)
        );
      });

      io.log(`Found ${targetTasks.length} pending plan task(s) for session "${targetSessionId}" in local store.`);

      if (targetTasks.length === 0) {
        return { matched: 0, cancelled: 0, taskIds: [] };
      }

      if (!apply) {
        io.log("[DRY-RUN] Tasks that would be cancelled:");
        for (const t of targetTasks) {
          io.log(`  - ${t.id} (status: ${t.status}, kind: ${t.kind}, revision: ${t.revision})`);
        }
        io.log("[DRY-RUN] Run with --apply to execute cancellation.");
        return { matched: targetTasks.length, cancelled: 0, taskIds: targetTasks.map((t) => t.id) };
      }

      for (const t of targetTasks) {
        await decisionService.cancelTask(t.id);
        cancelledTaskIds.push(t.id);
        io.log(`Cancelled task ${t.id}`);
      }

      io.log(`Successfully cancelled ${cancelledTaskIds.length} task(s) in local store.`);
      return { matched: targetTasks.length, cancelled: cancelledTaskIds.length, taskIds: cancelledTaskIds };
    } finally {
      await storeInstance.close();
    }
  }

  if (bridgeUrl) {
    const effectiveToken = token ?? process.env.DECISION_BRIDGE_TOKEN ?? null;
    const headers: Record<string, string> = {
      "Accept": "application/json",
      ...(effectiveToken ? { "Authorization": `Bearer ${effectiveToken}` } : {}),
    };

    const sessionTasksUrl = `${bridgeUrl.replace(/\/+$/, "")}/v1/sessions/${encodeURIComponent(targetSessionId)}/tasks`;
    const res = await fetch(sessionTasksUrl, { method: "GET", headers });

    if (res.status === 404) {
      io.log(`Session "${targetSessionId}" not found on bridge. Nothing to clean up.`);
      return { matched: 0, cancelled: 0, taskIds: [] };
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to query tasks from bridge (${res.status}): ${errText}`);
    }

    const body = (await res.json()) as { tasks?: DecisionTask[] };
    const tasks = body.tasks || [];
    const targetTasks = tasks.filter((t) => {
      return (
        Boolean(t) &&
        t.sessionId === targetSessionId &&
        t.kind === "plan" &&
        ["pending", "claimed", "running"].includes(t.status)
      );
    });

    io.log(`Found ${targetTasks.length} pending plan task(s) for session "${targetSessionId}" on bridge.`);

    if (targetTasks.length === 0) {
      return { matched: 0, cancelled: 0, taskIds: [] };
    }

    if (!apply) {
      io.log("[DRY-RUN] Tasks that would be cancelled:");
      for (const t of targetTasks) {
        io.log(`  - ${t.id} (status: ${t.status}, kind: ${t.kind}, revision: ${t.revision})`);
      }
      io.log("[DRY-RUN] Run with --apply to execute cancellation.");
      return { matched: targetTasks.length, cancelled: 0, taskIds: targetTasks.map((t) => t.id) };
    }

    for (const t of targetTasks) {
      const cancelUrl = `${bridgeUrl.replace(/\/+$/, "")}/v1/tasks/${encodeURIComponent(t.id)}/cancel`;
      const cancelRes = await fetch(cancelUrl, { method: "POST", headers });
      if (!cancelRes.ok) {
        const cancelErr = await cancelRes.text();
        throw new Error(`Failed to cancel task ${t.id} (${cancelRes.status}): ${cancelErr}`);
      }
      cancelledTaskIds.push(t.id);
      io.log(`Cancelled task ${t.id}`);
    }

    io.log(`Successfully cancelled ${cancelledTaskIds.length} task(s) on bridge.`);
    return { matched: targetTasks.length, cancelled: cancelledTaskIds.length, taskIds: cancelledTaskIds };
  }

  return { matched: 0, cancelled: 0, taskIds: [] };
}

export function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  let parsed: CleanupPollutedTasksOptions;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (parsed.help) {
    console.log(`
Usage: node scripts/cleanup-polluted-tasks.mjs [options]

Directionally cancels polluted/stuck Decision Plan tasks for a specific session (defaulting to #99).
Explicitly leaves #137 and all other sessions untouched.

Options:
  --store <dir>         Local decision store directory
  --bridge-url <url>    Remote decision bridge URL
  --token <token>       Bridge auth token (optional, or DECISION_BRIDGE_TOKEN)
  --session <id>        Target session ID (default: "github:felixjichao/symphony-ts#99")
  --apply               Execute cancellation (default is dry-run)
  -h, --help            Show this help message
`);
    process.exit(0);
  }

  cleanupPollutedTasks(parsed)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
