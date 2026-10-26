import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeOwnershipFence, type RecoveryContext } from "@symphony/domain";
import { reserveRecovery, OrchestratorAuthority, createOrchestratorRuntimeState } from "@symphony/orchestrator";
import { FileRetryReservationStorage } from "./recovery-storage";
import { createHostRecovery } from "./host-recovery";
import { FileRecoveryLedger } from "./recovery-ledger";
import { RecoveryIncidentReporter, formatRecoveryIncident } from "./recovery-reporter";
import { runRecoveryCli } from "./recovery-cli";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const context: RecoveryContext = { workKey: { provider: "github", key: "owner/repo#1" }, expectedAction: "coding:retry", target: "runtime",
  owner: "orchestrator", fence: sanitizeOwnershipFence({ leaseToken: "secret-lease", lifecycleGeneration: 2 }),
  lastProgressAt: 123, failure: { classification: "recoverable", reason: "port_exit" }, unblock: "Inspect process; authorize exact incident" };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-recovery-")); dirs.push(dir);
  const ledger = new FileRecoveryLedger(path.join(dir, "recovery.json"));
  const reserve = (invocation: string, ctx = context) => reserveRecovery({ ledger, policy: { maxAttempts: 1, maxStrategyAttempts: 1 },
    context: ctx, invocation, strategies: ["retry"], now: 1000 });
  return { dir, ledger, reserve };
}
describe("durable recovery evidence and outbox", () => {
  it("survives restart, preserves historical incidents, and requires exact current authorization", () => {
    const { ledger, reserve } = fixture();
    reserve("one"); const blocked = reserve("two");
    const reopened = new FileRecoveryLedger(ledger.file);
    expect(reopened.list()[0]?.incident).toEqual(blocked.incident);
    let text = "";
    const io = { stdout: { write: (value: string) => { text += value; } }, stderr: { write() {} } };
    expect(runRecoveryCli(["list", ledger.file], io)).toBe(0);
    expect(text).toContain("recovery_exhausted");
    expect(runRecoveryCli(["authorize", ledger.file, "wrong"], io)).toBe(1);
    expect(runRecoveryCli(["authorize", ledger.file, blocked.incident!.id], io)).toBe(0);
    expect(runRecoveryCli(["authorize", ledger.file, blocked.incident!.id], io)).toBe(1);
    expect(reserve("new").attempts).toBe(1);
    expect(reopened.incidents()).toHaveLength(1);
    expect(reserve("next").incident?.epoch).toBe(2);
    expect(reopened.incidents()).toHaveLength(2);
    expect(fs.readFileSync(ledger.file, "utf8")).not.toContain("secret-lease");
  });
  it("releases only the exactly authorized native worker block, including its live cached owner", () => {
    const { ledger, dir } = fixture();
    const retries = new FileRetryReservationStorage(path.join(dir, "retries.json"));
    retries.put({ workKey: context.workKey, issueId: "1", identifier: "GH-1", issueUrl: null, attempt: 4,
      kind: "failure", error: "worker_launch_unverified", phase: "blocked", dueAtUtcMs: 1000, token: "original" }, null);
    const state = createOrchestratorRuntimeState({ pollIntervalMs: 1000, maxConcurrentAgents: 1 });
    const authority = new OrchestratorAuthority({ state, retryStorage: retries,
      policy: { activeStates: ["open"], terminalStates: ["closed"], requiredLabels: [], maxConcurrentAgentsByState: {} },
      runner: async () => { throw new Error("must not launch"); }, createAttemptOptions: () => { throw new Error("must not launch"); },
      tracker: { fetchIssuesByIds: async () => [] }, resolveWorkspacePath: () => dir });
    authority.restoreRetries();
    const native = retries.load()[0]!;
    const blockedContext: RecoveryContext = { ...context, fence: sanitizeOwnershipFence({ retryToken: native.token }),
      failure: { classification: "outcome_unknown", reason: "worker_launch_unverified" } };
    const incident = reserveRecovery({ ledger, policy: { maxAttempts: 6, maxStrategyAttempts: 2 }, context: blockedContext,
      priorAttempts: 4, invocation: "crash", strategies: [], now: 1000 }).incident!;
    const recovery = createHostRecovery(ledger, () => ({ maxAttempts: 6, maxStrategyAttempts: 2 }), () => 1000);
    expect(authority.releaseAuthorizedRetry("1", "wrong")).toBe(false);
    expect(runRecoveryCli(["authorize", ledger.file, incident.id], { stdout: { write() {} }, stderr: { write() {} } })).toBe(0);
    expect(retries.load()).toEqual([]);
    recovery.resumeAuthorizedRetry(authority, "1", context.workKey);
    expect(authority.continuityBlock("1")).toBeNull();
    expect(state.claimed.has("1")).toBe(false);
    expect(ledger.incidents()[0]?.attempts).toBe(4);
  });
  it("does not use a reviewed native token to release a successor reservation", () => {
    const { ledger, dir } = fixture();
    const retries = new FileRetryReservationStorage(path.join(dir, "retries.json"));
    retries.put({ workKey: context.workKey, issueId: "1", identifier: "GH-1", issueUrl: null, attempt: 1,
      kind: "failure", error: "unknown", phase: "blocked", dueAtUtcMs: 1000, token: "successor" }, null);
    const incident = reserveRecovery({ ledger, policy: { maxAttempts: 1, maxStrategyAttempts: 1 }, context: { ...context,
      fence: sanitizeOwnershipFence({ retryToken: "reviewed-old" }), failure: { classification: "outcome_unknown", reason: "launch_unknown" } },
      invocation: "crash", strategies: [], now: 1000 }).incident!;
    expect(runRecoveryCli(["authorize", ledger.file, incident.id], { stdout: { write() {} }, stderr: { write() {} } })).toBe(1);
    expect(retries.load()[0]?.token).toBe("successor");
    expect(ledger.list()[0]?.incident?.id).toBe(incident.id);
  });
  it("fails closed on corrupt/unknown schemas before invoking any update", () => {
    const { ledger } = fixture();
    fs.writeFileSync(ledger.file, JSON.stringify({ schemaVersion: 99, budgets: [], incidents: [] }));
    let called = false;
    expect(() => ledger.transact("scope", () => { called = true; throw new Error("not reached"); })).toThrow();
    expect(called).toBe(false);
  });
  it("deduplicates publication after an ACK loss and restart using the remote marker", async () => {
    const { ledger, reserve, dir } = fixture();
    reserve("one"); const incident = reserve("two").incident!;
    let postCount = 0;
    const comments: { body: string; html_url: string }[] = [];
    const runner = { gh: async (args: readonly string[]) => {
      if (args.includes("POST")) {
        postCount++;
        const bodyFile = args[args.indexOf("--input") + 1]!;
        comments.push({ body: (JSON.parse(fs.readFileSync(bodyFile, "utf8")) as { body: string }).body, html_url: "https://example.test/comment/1" });
        throw new Error("ACK lost");
      }
      return { exitCode: 0, stdout: JSON.stringify([comments]), stderr: "" };
    } };
    await new RecoveryIncidentReporter(ledger, runner, dir).publish(async () => true, () => true);
    await new RecoveryIncidentReporter(new FileRecoveryLedger(ledger.file), runner, dir).publish(async () => true, () => true);
    await new RecoveryIncidentReporter(ledger, runner, dir).publish(async () => true, () => true);
    expect(postCount).toBe(1);
    expect(comments[0]?.body).toContain(incident.id);
    for (const field of ["Work:", "Expected action/stage:", "Owner:", "Failure classification:", "Last progress timestamp:", "Attempt/recovery count:", "Recovery actions tried:", "Blocked reason:", "Resume/unblock condition:"]) expect(formatRecoveryIncident(incident)).toContain(field);
    expect(comments[0]?.body).not.toContain("secret-lease");
  });
  it("never reposts an ambiguous send without a receipt, and bounds reporter failures", async () => {
    const { ledger, reserve, dir } = fixture(); reserve("one"); reserve("two");
    let sends = 0; let reads = 0;
    const reporter = new RecoveryIncidentReporter(ledger, { gh: async args => {
      if (args.includes("POST")) { sends++; throw new Error("unknown"); }
      reads++; return { exitCode: 0, stdout: "[[]]", stderr: "" };
    } }, dir);
    for (let i = 0; i < 10; i++) await reporter.publish(async () => true, () => true);
    expect(sends).toBe(1); expect(reads).toBe(3); expect(ledger.incidents()).toHaveLength(1);
  });
  it("does not publish or acknowledge stale generations or stopped work", async () => {
    const { ledger, reserve, dir } = fixture(); reserve("one"); reserve("two"); let calls = 0;
    const reporter = new RecoveryIncidentReporter(ledger, { gh: async () => { calls++; throw new Error("unexpected"); } }, dir);
    await reporter.publish(async () => false, () => true);
    await reporter.publish(async () => true, () => false);
    expect(calls).toBe(0);
    let current = true; let posts = 0;
    const racing = new RecoveryIncidentReporter(ledger, { gh: async args => {
      if (args.includes("POST")) posts++;
      current = false; return { exitCode: 0, stdout: "[[]]", stderr: "" };
    } }, dir);
    await racing.publish(async () => current, () => true);
    expect(posts).toBe(0);
  });
  it("serializes independent reporter instances before the POST boundary", async () => {
    const { ledger, reserve, dir } = fixture(); reserve("one"); reserve("two"); let posts = 0;
    const runner = { gh: async (args: readonly string[]) => { if (args.includes("POST")) posts++; return { exitCode: 0, stdout: args.includes("POST") ? "{}" : "[[]]", stderr: "" }; } };
    await Promise.all([new RecoveryIncidentReporter(ledger, runner, dir).publish(async () => true, () => true),
      new RecoveryIncidentReporter(new FileRecoveryLedger(ledger.file), runner, dir).publish(async () => true, () => true)]);
    expect(posts).toBeLessThanOrEqual(1);
    expect(ledger.incidents()).toHaveLength(1);
  });
  it("retains a reservation after SIGKILL and deduplicates cross-process exhaustion", async () => {
    const { dir, ledger } = fixture();
    const entry = path.join(dir, "entry.ts");
    fs.writeFileSync(entry, `export { FileRecoveryLedger } from ${JSON.stringify(fileURLToPath(new URL("./recovery-ledger.ts", import.meta.url)))};\nexport { reserveRecovery } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/orchestrator/src/recovery-policy.ts", import.meta.url)))};`);
    await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true }, build: { ssr: entry, outDir: path.join(dir, "bundle"),
      target: "node20", rollupOptions: { external: [], output: { entryFileNames: "entry.mjs" } } } });
    const moduleUrl = pathToFileURL(path.join(dir, "bundle", "entry.mjs")).href;
    const script = `import { FileRecoveryLedger, reserveRecovery } from ${JSON.stringify(moduleUrl)};
const result = reserveRecovery({ ledger: new FileRecoveryLedger(${JSON.stringify(ledger.file)}), policy: { maxAttempts: 1, maxStrategyAttempts: 1 }, context: ${JSON.stringify(context)}, invocation: process.argv[1], strategies: ['retry'], now: 1000 });`;
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `${script}\nprocess.kill(process.pid, 'SIGKILL');`, "initial"], { encoding: "utf8" });
    expect(killed.signal, killed.stderr).toBe("SIGKILL");
    expect(ledger.list()[0]?.attempts).toBe(1);
    const child = (invocation: string) => new Promise<number | null>(resolve => {
      const processChild = spawn(process.execPath, ["--input-type=module", "-e", `try { ${script.replace(/^import[^\n]+\n/, "")} } catch { process.exitCode = 2; }`.replace(/^/, `import { FileRecoveryLedger, reserveRecovery } from ${JSON.stringify(moduleUrl)};\n`), invocation], { stdio: "ignore" });
      processChild.on("exit", code => resolve(code));
    });
    const results = await Promise.all([child("first"), child("second")]);
    expect(results.some(code => code === 0)).toBe(true);
    expect(ledger.list()[0]?.attempts).toBe(1); expect(ledger.incidents()).toHaveLength(1);
  });
});
