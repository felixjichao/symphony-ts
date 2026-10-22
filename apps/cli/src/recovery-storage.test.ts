import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkContinuityObservation, WorkRecoveryRequest } from "@symphony/domain";
import { WorkContinuityCoordinator } from "@symphony/orchestrator";
import { FileWorkRecoveryStorage, writeDurableJson } from "./recovery-storage";

const directories: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-intent-"));
  directories.push(dir);
  return { dir, file: path.join(dir, "host", "recovery.json") };
}
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const key = { provider: "github", key: "fixture/repo#1" };
const request: WorkRecoveryRequest = { invocationId: "first", workKey: key, version: "head-and-fence",
  stage: "review", action: "reclaim", authority: { kind: "internal", authority: "decision" },
  taskRef: { taskId: "task", revision: 1 }, fence: { leaseGeneration: 2 }, leaseExpiresAt: 100 };
const facts: WorkContinuityObservation = { workKey: key, observedAt: 1000, version: "head-and-fence",
  available: true, unavailableSources: [], active: true, stage: "review", expectedFence: { leaseGeneration: 2 },
  owner: null, blocked: null, scheduled: null, externalWait: null, contradictions: [] };

describe("durable recovery invocation storage", () => {
  it("preserves an intent across a killed process and suppresses replay after restart", async () => {
    const { file, dir } = fixture();
    await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true }, build: {
      ssr: fileURLToPath(new URL("./recovery-storage.ts", import.meta.url)),
      outDir: path.join(dir, "bundle"), target: "node20",
      rollupOptions: { output: { entryFileNames: "storage.mjs" } },
    } });
    const source = `import { FileWorkRecoveryStorage } from ${JSON.stringify(pathToFileURL(path.join(dir, "bundle", "storage.mjs")).href)};
new FileWorkRecoveryStorage(${JSON.stringify(file)}).put(${JSON.stringify(request)});
process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const store = new FileWorkRecoveryStorage(file);
    expect(store.load()).toEqual([request]);
    let calls = 0;
    const coordinator = new WorkContinuityCoordinator({ recoveryStorage: store, listWork: async () => [],
      observe: async () => facts, recover: async () => { calls++; return "applied"; } });
    const result = await coordinator.reconcile();
    expect(result[0]?.result).toBe("unverified");
    expect(calls).toBe(0);
    expect(coordinator.hasUnverifiedRecovery(key)).toBe(true);
  });
  it("does not overwrite an unresolved slot or acknowledge a later invocation", () => {
    const { file } = fixture();
    const first = new FileWorkRecoveryStorage(file);
    const second = new FileWorkRecoveryStorage(file);
    first.put(request);
    expect(() => second.put({ ...request, invocationId: "second" })).toThrow("already pending");
    first.remove(request);
    second.put({ ...request, invocationId: "second" });
    first.remove(request);
    expect(second.load()[0]?.invocationId).toBe("second");
  });
  it("commits before authority I/O, retains ambiguous effects, and resolves from native evidence", async () => {
    const { file } = fixture();
    let calls = 0;
    let resolved = false;
    const ports = { recoveryStorage: new FileWorkRecoveryStorage(file), listWork: async () => [key],
      observe: async () => ({ ...facts, blocked: resolved ? "operator" : null }),
      isRecoveryResolved: async () => resolved,
      recover: async () => {
        expect(new FileWorkRecoveryStorage(file).load()).toHaveLength(1);
        calls++; throw new Error("effect committed, response lost");
      } };
    await new WorkContinuityCoordinator(ports).reconcile();
    const reopened = new WorkContinuityCoordinator({ ...ports, recoveryStorage: new FileWorkRecoveryStorage(file) });
    await reopened.reconcile();
    expect(calls).toBe(1);
    resolved = true;
    await reopened.reconcile();
    expect(ports.recoveryStorage.load()).toEqual([]);
    expect(calls).toBe(1);
  });
  it("does not perform effects after a failed durable commit", async () => {
    const { file } = fixture();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "operator verification required");
    let calls = 0;
    const coordinator = new WorkContinuityCoordinator({ recoveryStorage: new FileWorkRecoveryStorage(file),
      listWork: async () => [key], observe: async () => facts,
      recover: async () => { calls++; return "applied"; } });
    await coordinator.reconcile();
    expect(calls).toBe(0);
  });
  it.each(["not-json", '{}', '{"schemaVersion":2,"requests":[]}', '{"schemaVersion":1,"requests":[{}]}'])("fails closed for invalid state %s", raw => {
    const { file } = fixture();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    expect(() => new FileWorkRecoveryStorage(file).load()).toThrow();
  });
  it("atomically replaces delivery state without leaving ordinary temporary files", () => {
    const { file } = fixture();
    writeDurableJson(file, { paused: true });
    writeDurableJson(file, { paused: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ paused: false });
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
