/** Offline external completion coordinator. Remote access is GET-only. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { settleExternalDelivery, type DeliveryGitGhRunner } from "@symphony/agent";
import { DurableDecisionStore, DecisionService, validateStoreRecord, type DecisionStoreRecord } from "@symphony/decision";
import { decisionSessionId, externalDeliveryStateFingerprint, externalSettlementFingerprint,
  parseExternalDeliverySettlementRequest, type ExternalDeliverySettlementRequest,
  type WorkKey } from "@symphony/domain";
import { verifyExternalDelivery } from "@symphony/tracker";
import { acquireFileAuthority, hostMaintenanceAuthorityPath, withDeliveryLifecycleAuthority } from "./file-authority";
import { FileDeliveryStateStorage, withDeliveryAuthority, type DeliveryCliIo } from "./delivery-skill-cli";
import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";
import { FileWorkRecoveryStorage, FileRetryReservationStorage, writeDurableJson } from "./recovery-storage";
import { externalSettlementJournalPath, readExternalSettlementJournal, type ExternalSettlementJournal } from "./external-settlement-journal";

type Draft = Omit<ExternalDeliverySettlementRequest, "expected" | "operationId">;
const emptyExpected = { deliveryHash: "0".repeat(64), decisionHash: "0".repeat(64), decisionSequence: 0,
  recoveryHash: "0".repeat(64), retryHash: "0".repeat(64) };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const keyFor = (r: ExternalDeliverySettlementRequest): WorkKey => ({ provider: "github", key: `${r.context.repo}#${r.context.issueNumber}` });
function files(r: ExternalDeliverySettlementRequest) {
  const root = path.dirname(r.workspace);
  return { root, delivery: path.join(r.workspace, ".symphony", "delivery-state.json"),
    recovery: new FileWorkRecoveryStorage(path.join(root, ".symphony-host", "recovery.json")),
    retry: new FileRetryReservationStorage(path.join(root, ".symphony-host", "retries.json")) };
}
function scopes(r: ExternalDeliverySettlementRequest) {
  const f = files(r), key = decisionSessionId(keyFor(r));
  const requests = f.recovery.load().filter(x => decisionSessionId(x.workKey) === key);
  const all = f.retry.load();
  if (all.some(x => !x.workKey)) throw new Error("Unscoped retries require separate verification");
  return { requests, retries: all.filter(x => x.workKey && decisionSessionId(x.workKey) === key) };
}
function assertPaths(r: ExternalDeliverySettlementRequest, missingWorkspace = false): void {
  if (!path.isAbsolute(r.workspace) || !path.isAbsolute(r.decisionStore)
    || fs.realpathSync(r.decisionStore) !== r.decisionStore
    || fs.realpathSync(path.dirname(r.workspace)) !== path.dirname(r.workspace)
    || (!missingWorkspace && fs.realpathSync(r.workspace) !== r.workspace)) throw new Error("Settlement paths must be canonical absolute paths");
  // Native state directories may not redirect this operation outside its inspected workspace/root.
  for (const dir of [path.join(r.workspace, ".symphony"), path.join(r.workspace, ".symphony", "delivery-state.json"),
    path.join(r.decisionStore, "store.json"), path.join(path.dirname(r.workspace), ".symphony-host"),
    path.join(path.dirname(r.workspace), ".symphony-host", "external-settlements"),
    externalSettlementJournalPath(path.dirname(r.workspace), keyFor(r))]) {
    if (fs.existsSync(dir) && fs.realpathSync(dir) !== dir) throw new Error("Symlinked native state refuses settlement");
  }
  if (!fs.existsSync(path.join(r.decisionStore, "store.json"))) throw new Error("Missing existing Decision store");
}
function assertDelivery(r: ExternalDeliverySettlementRequest, state: NonNullable<ReturnType<FileDeliveryStateStorage["readState"]>>): void {
  const c = r.context;
  if (state.repo !== c.repo || state.issueNumber !== c.issueNumber || state.workspaceKey !== c.workspaceKey
    || [state.continuation?.headBranch, state.landing?.context.headBranch, state.handoff?.headBranch].some(b => b !== undefined && b !== c.headBranch)
    || [state.continuation?.baseBranch, state.landing?.context.baseBranch].some(b => b !== undefined && b !== c.baseBranch)) {
    throw new Error("External completion work/workspace/branch mismatch");
  }
}
function decisionSnapshot(dir: string): { record: DecisionStoreRecord; hash: string } {
  const raw = fs.readFileSync(path.join(dir, "store.json"));
  const record = JSON.parse(raw.toString()) as DecisionStoreRecord;
  validateStoreRecord(record);
  return { record, hash: sha(raw) };
}
async function verify(r: ExternalDeliverySettlementRequest, runner: DeliveryGitGhRunner): Promise<void> {
  const cwd = fs.existsSync(r.workspace) ? r.workspace : path.dirname(r.workspace);
  await verifyExternalDelivery(r, { exec: (args, options) => runner.gh(args, cwd, options?.timeoutMs) });
}

export async function prepareExternalSettlement(draft: Draft, runner: DeliveryGitGhRunner): Promise<ExternalDeliverySettlementRequest> {
  const r = parseExternalDeliverySettlementRequest({ ...draft, operationId: randomUUID(), expected: emptyExpected });
  assertPaths(r);
  if (readExternalSettlementJournal(files(r).root, keyFor(r))) throw new Error("Resume the existing settlement request");
  const delivery = new FileDeliveryStateStorage(files(r).delivery).readState();
  if (!delivery || delivery.externalSettlement) throw new Error("Missing or already settled Delivery state");
  assertDelivery(r, delivery);
  const decision = decisionSnapshot(r.decisionStore);
  if (!decision.record.sessions[decisionSessionId(keyFor(r))]) throw new Error("Missing Decision session for this WorkKey");
  const scoped = scopes(r);
  const request = { ...r, expected: { deliveryHash: externalDeliveryStateFingerprint(delivery), decisionHash: decision.hash,
    decisionSequence: decision.record.transactionSequence, recoveryHash: externalSettlementFingerprint(scoped.requests),
    retryHash: externalSettlementFingerprint(scoped.retries) } };
  await verify(request, runner);
  return request;
}

/** Optional checkpoint is a fault-injection seam, never an executor or recovery policy. */
export async function applyExternalSettlement(request: ExternalDeliverySettlementRequest, runner: DeliveryGitGhRunner,
  checkpoint?: (phase: "prepared" | "decision" | "delivery" | "retired" | "complete") => void | Promise<void>): Promise<ExternalSettlementJournal> {
  const r = parseExternalDeliverySettlementRequest(request);
  if (!r.authorization.executorsStopped) throw new Error("Operator must verify all old executors stopped");
  const f = files(r), key = keyFor(r);
  assertPaths(r, !fs.existsSync(r.workspace));
  const maintenance = acquireFileAuthority(hostMaintenanceAuthorityPath(f.root));
  try {
    const action = async (): Promise<ExternalSettlementJournal> => {
      let journal = readExternalSettlementJournal(f.root, key);
      const requestHash = externalSettlementFingerprint(r);
      if (journal && journal.receipt.requestHash !== requestHash) throw new Error("Different authorization cannot replace a settlement");
      const storage = new FileDeliveryStateStorage(f.delivery, true);
      const state = storage.readState();
      if (!state && journal?.phase !== "complete") throw new Error("Missing Delivery state before settlement completion");
      if (state) {
        assertDelivery(r, state);
        if (externalDeliveryStateFingerprint(state) !== r.expected.deliveryHash
          || (state.externalSettlement && state.externalSettlement.requestHash !== requestHash)
          || (journal?.phase === "complete" && !state.externalSettlement)) throw new Error("Delivery authority changed");
      }
      const store = new DurableDecisionStore({ storeDir: r.decisionStore });
      try {
        await store.open();
        const op = store.getOperationReceipt(`external-settlement:${r.operationId}`);
        const snapshot = decisionSnapshot(r.decisionStore);
        if (!op && (snapshot.hash !== r.expected.decisionHash || snapshot.record.transactionSequence !== r.expected.decisionSequence)) {
          throw new Error("Decision owner or snapshot changed");
        }
        const scoped = scopes(r);
        if (!journal && (externalSettlementFingerprint(scoped.requests) !== r.expected.recoveryHash
          || externalSettlementFingerprint(scoped.retries) !== r.expected.retryHash)) throw new Error("Recovery owner changed");
        if (journal && (scoped.requests.some(x => !journal!.recoveryRequests.some(old => JSON.stringify(old) === JSON.stringify(x)))
          || scoped.retries.some(x => !journal!.retries.some(old => JSON.stringify(old) === JSON.stringify(x))))) {
          throw new Error("New recovery owner refuses settlement replay");
        }
        await verify(r, runner);
        if (!journal) {
          if (!state) throw new Error("Missing original Delivery state");
          journal = { schemaVersion: 1, phase: "prepared", request: r, originalDelivery: state,
            recoveryRequests: scoped.requests, retries: scoped.retries,
            receipt: { schemaVersion: 1, kind: "external_completion", operationId: r.operationId,
              requestHash, sourceStateHash: r.expected.deliveryHash, context: r.context, target: r.target,
              operator: r.authorization.operator, reason: r.authorization.reason, settledAtMs: Date.now() } };
          writeDurableJson(externalSettlementJournalPath(f.root, key), journal);
          await checkpoint?.("prepared");
        }
        const service = new DecisionService(store);
        await service.recordExternalCompletion(journal.receipt, r.expected.decisionSequence);
        if (journal.phase === "complete") return journal;
        await checkpoint?.("decision");
        await settleExternalDelivery(storage, journal.receipt);
        await checkpoint?.("delivery");
        f.recovery.retireForExternalCompletion(key, journal.recoveryRequests);
        f.retry.retireForExternalCompletion(key, journal.retries);
        const remaining = scopes(r);
        if (remaining.requests.length || remaining.retries.length) throw new Error("New recovery owner refuses settlement completion");
        await checkpoint?.("retired");
        journal = { ...journal, phase: "complete" };
        writeDurableJson(externalSettlementJournalPath(f.root, key), journal);
        await checkpoint?.("complete");
        return journal;
      } finally { await store.close(); }
    };
    // A completed receipt remains readable after workspace cleanup without recreating it.
    return fs.existsSync(r.workspace) ? await withDeliveryAuthority(r.workspace, action)
      : await withDeliveryLifecycleAuthority(r.workspace, action);
  } finally { maintenance.release(); }
}

export async function runExternalSettlementCli(argv: readonly string[], io: DeliveryCliIo, customRunner?: DeliveryGitGhRunner): Promise<number> {
  try {
    const [action, flag, file, ...rest] = argv;
    if (!["prepare-external", "settle-external"].includes(action ?? "") || flag !== "--request" || !file
      || rest.length > 1 || rest.some(x => x !== "--apply") || (action === "prepare-external" && rest.length)) {
      throw new Error("Usage: delivery-skill prepare-external|settle-external --request <json> [--apply]");
    }
    const input: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const runner = customRunner ?? new DefaultDeliveryGitGhRunner();
    if (action === "prepare-external") {
      // Domain validation rejects unknown draft fields after snapshot fields are added.
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.hasOwn(input, "expected") || Object.hasOwn(input, "operationId")) {
        throw new Error("Preparation requires a draft without expected/operationId");
      }
      const prepared = await prepareExternalSettlement(input as Draft, runner);
      io.stdout.write(JSON.stringify(prepared, null, 2) + "\n");
    } else {
      const request = parseExternalDeliverySettlementRequest(input);
      if (!rest.includes("--apply")) {
        io.stdout.write(JSON.stringify({ mode: "preview", request, requestHash: externalSettlementFingerprint(request) }, null, 2) + "\n");
      } else {
        const done = await applyExternalSettlement(request, runner);
        io.stdout.write(JSON.stringify({ mode: "external_completion", receipt: done.receipt }, null, 2) + "\n");
      }
    }
    return 0;
  } catch {
    // Arbitrary provider/native JSON errors may contain credentials; never echo them.
    io.stderr.write("External settlement refused: verify request, native fences, offline owners and closed/merged target.\n");
    return 1;
  }
}
