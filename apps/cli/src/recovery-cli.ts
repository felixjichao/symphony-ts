/** Explicit host-policy authorization, separate from native Decision/Delivery unblocking. */
import path from "node:path";
import { beginRecoveryEpoch } from "@symphony/orchestrator";
import { FileRetryReservationStorage } from "./recovery-storage";
import { FileRecoveryLedger } from "./recovery-ledger";
export function runRecoveryCli(argv: readonly string[], io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }): number {
  try {
    const [command, file, id] = argv;
    if (!file || !["list", "show", "authorize"].includes(command ?? "") || argv.length > 3) throw new Error("Invalid recovery command");
    const ledger = new FileRecoveryLedger(path.resolve(file));
    if (command === "list") {
      io.stdout.write(`${JSON.stringify(ledger.incidents(), null, 2)}\n`);
      return 0;
    }
    if (!id) throw new Error("Exact incident ID required");
    const incident = ledger.incidents().find(i => i.id === id);
    if (!incident) throw new Error("Unknown incident");
    if (command === "show") { io.stdout.write(`${JSON.stringify(incident, null, 2)}\n`); return 0; }
    const current = ledger.list().find(b => b.incident?.id === id);
    if (!current) throw new Error("Incident is no longer current");
    // Authorizing an exact worker-launch incident attests that its executor was
    // inspected and stopped. Decision/Delivery still use their native fenced APIs.
    const retryToken = incident.expectedAction === "coding:retry" ? incident.fence.retryToken : undefined;
    if (retryToken) {
      const retries = new FileRetryReservationStorage(path.join(path.dirname(ledger.file), "retries.json"));
      const records = retries.load();
      const record = records.find(r => r.token === retryToken);
      if (record && record.phase !== "blocked" && record.phase !== "launch_pending") throw new Error("Native retry fence changed");
      if (!record && records.some(r => r.workKey?.provider === incident.workKey.provider && r.workKey.key === incident.workKey.key
        || r.issueId === incident.workKey.key)) throw new Error("Native retry successor owns this work");
      // Explicit authorization attests that the old executor was inspected and stopped.
      // Native removal precedes policy clear: a crash leaves policy blocked, not runnable.
      if (record) retries.remove(record.issueId, retryToken);
    }
    ledger.transact(current.scope, latest => {
      if (!latest || latest.epoch !== incident.epoch || latest.incident?.id !== id) throw new Error("Stale authorization");
      return beginRecoveryEpoch(latest);
    });
    io.stdout.write(`Authorized recovery epoch for ${id}; native authority blocks still require their own exact authorization.\n`);
    return 0;
  } catch {
    io.stderr.write("Usage: symphony recovery list <ledger-file> | show <ledger-file> <incident-id> | authorize <ledger-file> <incident-id>\n");
    return 1;
  }
}
