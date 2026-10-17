import fs from "node:fs";
import { FileDeliveryLock } from "../src/delivery-skill-cli";

const statePath = process.env.DELIVERY_LOCK_CRASH_STATE;
if (!statePath) throw new Error("Missing fixture state path");
const phase = process.env.DELIVERY_LOCK_CRASH_PHASE;
if (phase === "published") {
  const link = fs.linkSync;
  fs.linkSync = (source, target) => {
    link(source, target);
    // Exit after the actual publication, before candidate cleanup or finally.
    process.exit(23);
  };
}
const lock = new FileDeliveryLock(statePath, {
  inProcessMutex: false,
  _beforeStaleReclaimRetire: () => process.exit(23),
});
await lock.acquire();
throw new Error("Crash barrier was not reached");
