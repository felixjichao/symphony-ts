/** Durable incident outbox. An uncertain POST is only looked up, never blindly resent. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RecoveryIncident } from "@symphony/domain";
import type { DeliveryGitGhRunner } from "@symphony/agent";
import { FileRecoveryLedger } from "./recovery-ledger";
import { withStorageMutation, writeDurableJson } from "./recovery-storage";

interface Receipt { id: string; attempts: number; phase: "ready" | "claimed" | "send_pending" | "reported" | "unverified" | "exhausted"; owner: string; url: string | null }
const MAX_REPORT_ATTEMPTS = 3;
export function formatRecoveryIncident(i: RecoveryIncident): string {
  return [`<!-- symphony:recovery-incident:${i.id} -->`, "## Symphony recovery incident", "",
    `Work: ${i.workKey.provider}:${i.workKey.key}`, `Expected action/stage: ${i.expectedAction}`,
    `Owner: ${i.owner ?? "unknown"}`, `Target: ${i.target}`, `Recovery epoch: ${i.epoch}`,
    `Fence: ${JSON.stringify(i.fence)}`, `Failure classification: ${i.failure.classification} (${i.failure.reason})`,
    `Last progress timestamp: ${i.lastProgressAt}`, `Attempt/recovery count: ${i.attempts}`,
    `Recovery actions tried: ${i.actions.join(", ") || "none"}`, `Blocked reason: ${i.blockedReason}`,
    `Resume/unblock condition: ${i.unblock}`, "", "This report records the named recovery epoch; inspect current authority facts before authorizing recovery."].join("\n");
}
export class RecoveryIncidentReporter {
  constructor(private readonly ledger: FileRecoveryLedger, private readonly runner: Pick<DeliveryGitGhRunner, "gh">, private readonly cwd: string) {}
  private get file() { return `${this.ledger.file}.outbox`; }
  private read(): Receipt[] {
    if (!fs.existsSync(this.file)) return [];
    const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("Invalid incident outbox");
    const s = raw as Record<string, unknown>;
    if (s["schemaVersion"] !== 1 || !Array.isArray(s["receipts"])) throw new Error("Invalid incident outbox schema");
    for (const value of s["receipts"]) {
      if (!value || typeof value !== "object") throw new Error("Invalid incident receipt");
      const r = value as Record<string, unknown>;
      if (typeof r["id"] !== "string" || !Number.isSafeInteger(r["attempts"]) || Number(r["attempts"]) < 0
        || typeof r["phase"] !== "string" || !["ready", "claimed", "send_pending", "reported", "unverified", "exhausted"].includes(r["phase"])
        || typeof r["owner"] !== "string" || !(r["url"] === null || typeof r["url"] === "string")) throw new Error("Invalid incident receipt");
    }
    const receipts = s["receipts"] as Receipt[];
    if (new Set(receipts.map(r => r.id)).size !== receipts.length) throw new Error("Duplicate incident receipts");
    return receipts;
  }
  private update(id: string, transform: (current: Receipt | null) => Receipt | null): Receipt | null {
    let result: Receipt | null = null;
    withStorageMutation(this.file, () => {
      const receipts = this.read();
      const index = receipts.findIndex(r => r.id === id);
      result = transform(receipts[index] ?? null);
      if (result) {
        if (index < 0) receipts.push(result); else receipts[index] = result;
        writeDurableJson(this.file, { schemaVersion: 1, receipts });
      }
    });
    return result;
  }
  async publish(isCurrent: (incident: RecoveryIncident) => Promise<boolean>, canCommit: () => boolean): Promise<void> {
    for (const budget of this.ledger.list()) {
      const incident = budget.incident;
      if (!incident || !canCommit() || incident.workKey.provider !== "github") continue;
      const match = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(incident.workKey.key);
      if (!match || !await isCurrent(incident) || !canCommit()) continue;
      const owner = randomUUID();
      // A process can die while claimed. Subsequent reconciliation may only verify
      // its marker, not take over permission to POST. Concurrent lookups are harmless.
      const claim = this.update(incident.id, old => {
        if (old?.phase === "reported" || old?.phase === "exhausted" || (old?.attempts ?? 0) >= MAX_REPORT_ATTEMPTS) return null;
        return { id: incident.id, attempts: (old?.attempts ?? 0) + 1,
          phase: old?.phase === "send_pending" || old?.phase === "claimed" || old?.phase === "unverified" ? "unverified" : "claimed",
          owner, url: null };
      });
      if (!claim) continue;
      const endpoint = `repos/${match[1]}/issues/${match[2]}/comments`;
      try {
        const lookup = await this.runner.gh(["api", endpoint, "--paginate", "--slurp"], this.cwd);
        if (lookup.exitCode !== 0) throw new Error("Incident lookup unavailable");
        const pages: unknown = JSON.parse(lookup.stdout);
        if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid comment pages");
        const comments: unknown[] = pages.flat();
        if (!comments.every(c => c && typeof c === "object" && typeof (c as Record<string, unknown>)["body"] === "string")) throw new Error("Invalid comments");
        const marker = `<!-- symphony:recovery-incident:${incident.id} -->`;
        const found = comments.find(c => (c as Record<string, unknown>)["body"]!.toString().includes(marker)) as Record<string, unknown> | undefined;
        if (found) {
          if (await isCurrent(incident) && canCommit()) this.update(incident.id, old => old?.owner === owner ? { ...old, phase: "reported", url: typeof found["html_url"] === "string" ? found["html_url"] : null } : null);
          continue;
        }
        if (claim.phase === "unverified" || !await isCurrent(incident) || !canCommit()) continue;
        // Commit permission before crossing POST boundary; a lost ACK never restores it.
        const intent = this.update(incident.id, old => old?.owner === owner && old.phase === "claimed" ? { ...old, phase: "send_pending" } : null);
        if (!intent) continue;
        const bodyFile = path.join(path.dirname(this.file), `incident-${randomUUID()}.json`);
        fs.writeFileSync(bodyFile, JSON.stringify({ body: formatRecoveryIncident(incident) }), { mode: 0o600, flag: "wx" });
        try {
          if (!canCommit() || !await isCurrent(incident)) continue;
          const sent = await this.runner.gh(["api", endpoint, "--method", "POST", "--input", bodyFile], this.cwd);
          if (sent.exitCode !== 0) throw new Error("Incident POST unverified");
          const response = JSON.parse(sent.stdout) as Record<string, unknown>;
          if (await isCurrent(incident) && canCommit()) this.update(incident.id, old => old?.owner === owner ? { ...old, phase: "reported", url: typeof response["html_url"] === "string" ? response["html_url"] : null } : null);
        } finally { fs.unlinkSync(bodyFile); }
      } catch {
        this.update(incident.id, old => old?.owner === owner ? { ...old,
          phase: old.phase === "send_pending" || claim.phase === "unverified" ? "unverified" : old.attempts >= MAX_REPORT_ATTEMPTS ? "exhausted" : "ready" } : null);
      }
    }
  }
}
