import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execute, remote, saveRemote } from "../test-fixtures/durable-delivery-harness";
import { FileDeliveryStateStorage, withDeliveryAuthority } from "./delivery-skill-cli";

let bundle: string;
let bundleDir: string;
const directories: string[] = [];
beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-delivery-bundle-"));
  bundle = path.join(bundleDir, "fixture.mjs");
  await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true }, build: {
    ssr: fileURLToPath(new URL("../test-fixtures/durable-delivery-harness.ts", import.meta.url)),
    outDir: bundleDir, target: "node20", rollupOptions: { output: { entryFileNames: "fixture.mjs" } },
  } });
}, 30000);
afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-delivery-"));
  directories.push(dir);
  saveRemote(dir, { head: "a".repeat(40), merged: false, merges: 0, comments: [], labels: ["symphony-ready"], repairs: 0 });
  return dir;
}
function crash(dir: string, fault: string, merge = false, verdict = "pending") {
  const child = spawnSync(process.execPath, [bundle], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, DURABLE_FIXTURE_DIR: dir, DURABLE_FAULT: fault, DURABLE_MERGE: merge ? "1" : "0", DURABLE_VERDICT: verdict } });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}
const state = (dir: string) => new FileDeliveryStateStorage(path.join(dir, ".symphony", "delivery-state.json")).readState()!;
describe("native Delivery crash windows", () => {
  it.each(["review_intent", "review_effect", "review_ack"])("resumes %s through the same Decision receipt without coding replay", async fault => {
    const dir = fixture();
    crash(dir, fault);
    const first = await execute(dir);
    expect(first.result).toMatchObject({ status: "waiting" });
    expect(first.tasks).toHaveLength(1);
    const second = await execute(dir, "", false, "approve");
    expect(second.result).toMatchObject({ status: "ready_to_land" });
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]?.id).toBe(first.tasks[0]?.id);
    expect(remote(dir).merges).toBe(0);
    expect(state(dir).continuation?.phase).toBe("ready");
  });
  it.each(["merge_intent", "merge_effect", "merge_ack"])("re-observes %s and confirms one merge despite lost acknowledgement", async fault => {
    const dir = fixture();
    crash(dir, fault, true, "approve");
    const result = await execute(dir, "", true, "approve");
    expect(result.result).toMatchObject({ status: "completed" });
    expect(remote(dir).merges).toBe(1);
    expect(state(dir).landing).toMatchObject({ phase: "observed", headSha: "a".repeat(40), mergeCommitSha: "c".repeat(40) });
    await execute(dir, "", true, "approve");
    expect(remote(dir).merges).toBe(1);
  });
  it("does not consume an old review after HEAD changes during downtime", async () => {
    const dir = fixture();
    crash(dir, "review_effect", false, "approve");
    saveRemote(dir, { ...remote(dir), head: "d".repeat(40) });
    const result = await execute(dir, "", true);
    expect(result.result).toMatchObject({ status: "waiting", headSha: "d".repeat(40) });
    expect(remote(dir).merges).toBe(0);
    expect(result.tasks.filter(t => t.status === "pending")).toHaveLength(1);
    expect(state(dir).continuation?.headSha).toBe("d".repeat(40));
  });
  it("blocks an ambiguous repair without repeating its command or initial validation", async () => {
    const dir = fixture();
    crash(dir, "repair_pending", false, "changes_requested");
    const result = await execute(dir);
    expect(result.result).toMatchObject({ status: "blocked" });
    expect(remote(dir).repairs).toBe(0);
    expect(state(dir).isPaused).toBe(true);
    expect(state(dir).pauseReason).toBe("manual_intervention_required");
  });
  it("deduplicates a report received remotely before the local acknowledgement", async () => {
    const dir = fixture();
    crash(dir, "handoff_effect", false, "needs_human");
    expect(remote(dir).comments).toHaveLength(1);
    expect(state(dir).pendingCompensation).toBe(true);
    const before = state(dir);
    const result = await execute(dir, "recover_handoff");
    expect(result.result).toMatchObject({ success: true });
    expect(remote(dir).comments).toHaveLength(1);
    expect(state(dir)).toMatchObject({ isPaused: true, pendingCompensation: false,
      spentRepairs: before.spentRepairs, deadlineTimestampMs: before.deadlineTimestampMs });
  });
  it("refuses compensation after the authoritative PR target changes", async () => {
    const dir = fixture();
    crash(dir, "handoff_effect", false, "needs_human");
    saveRemote(dir, { ...remote(dir), head: "e".repeat(40) });
    const result = await execute(dir, "recover_handoff");
    expect(result.result).toMatchObject({ success: false, pendingCompensation: true });
    expect(remote(dir).comments).toHaveLength(1);
  });
  it("reclaims a proven dead clean owner, but never an ambiguous subprocess or legacy owner", async () => {
    const clean = fixture();
    crash(clean, "lock_clean");
    expect(await withDeliveryAuthority(clean, async () => "recovered")).toBe("recovered");
    const ambiguous = fixture();
    crash(ambiguous, "lock_ambiguous");
    await expect(withDeliveryAuthority(ambiguous, async () => "unsafe")).rejects.toThrow("unverified");
    const file = path.join(ambiguous, ".symphony", "delivery-authority.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 1 }));
    await expect(withDeliveryAuthority(ambiguous, async () => "unsafe")).rejects.toThrow("unverified");
  });
  it("serializes competing recovery calls and does not release a successor nonce", async () => {
    const dir = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = withDeliveryAuthority(dir, async () => { await pending; });
    await expect(withDeliveryAuthority(dir, async () => "duplicate")).rejects.toThrow();
    release(); await first;
    const file = path.join(dir, ".symphony", "delivery-authority.lock");
    await withDeliveryAuthority(dir, async () => {
      const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...metadata, nonce: "successor" }));
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).nonce).toBe("successor");
  });
  it("fails closed for corrupt new step schemas", () => {
    const dir = fixture();
    const file = path.join(dir, ".symphony", "delivery-state.json");
    const storage = new FileDeliveryStateStorage(file);
    storage.writeState({ repo: "fixture/durable", issueNumber: 1, workspaceKey: "GH-1", spentRepairs: 0,
      spentWaitSeconds: 0, isPaused: false, lastUpdated: "now" });
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    record["landing"] = { optIn: true };
    fs.writeFileSync(file, JSON.stringify(record));
    expect(() => storage.readState()).toThrow("recovery step schema");
  });
});
