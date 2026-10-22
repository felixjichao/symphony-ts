/** Shared landing intent representation for skill and `pr land` (§11.5/§17). */
import path from "node:path";
import type { LandingIntentStorage, LandingIntent } from "@symphony/domain";
import { GitHubDeliveryService, DefaultGhRunner } from "@symphony/tracker";
import { FileDeliveryStateStorage, withDeliveryAuthority } from "./delivery-skill-cli";
import { beginDeliverySubprocess } from "./file-authority";

export class FileLandingIntentStorage implements LandingIntentStorage {
  constructor(private readonly cwd: string, private readonly locked = false) {}
  async withExclusive<T>(action: (storage: LandingIntentStorage) => Promise<T>): Promise<T> {
    if (this.locked) return action(this);
    return withDeliveryAuthority(this.cwd, () => action(new FileLandingIntentStorage(this.cwd, true)));
  }
  private storage() { return new FileDeliveryStateStorage(path.join(this.cwd, ".symphony", "delivery-state.json"), true); }
  read() { return this.storage().readState()?.landing ?? null; }
  write(intent: LandingIntent): void {
    const storage = this.storage();
    const state = storage.readState();
    if (state && (state.repo.toLowerCase() !== intent.context.repo.toLowerCase()
      || state.issueNumber !== intent.context.issueNumber || state.workspaceKey !== intent.context.workspaceKey)) {
      throw new Error("Landing work identity mismatch");
    }
    if (state?.isPaused && intent.phase !== "observed") throw new Error("Delivery is paused");
    storage.writeState({ repo: intent.context.repo, issueNumber: intent.context.issueNumber,
      workspaceKey: intent.context.workspaceKey, spentRepairs: 0, spentWaitSeconds: 0, isPaused: false,
      ...state, landing: intent, lastUpdated: new Date().toISOString() });
  }
}
export function createNativeDeliveryService(): GitHubDeliveryService {
  const runner = new DefaultGhRunner();
  return new GitHubDeliveryService({ async exec(args, options) {
    const settled = beginDeliverySubprocess();
    // A thrown/timeout request is ambiguous. Preserve the authority's pending
    // effect marker even if the remote effect may already have completed.
    return runner.exec(args, { ...options, onProcessClose: settled });
  } });
}
