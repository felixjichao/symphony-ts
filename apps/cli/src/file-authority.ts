/** Native filesystem exclusion for host commits and Delivery (§8/§17).
 * Dead owners may be reclaimed only when no subprocess outcome is ambiguous. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

interface Owner { pid: number; hostname: string; nonce: string; effectsPending: boolean }
const deliveryOwner = new AsyncLocalStorage<{ update: (pending: boolean) => void; count: number; file: string }>();
function dead(owner: Owner): boolean {
  if (owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function read(file: string): Owner | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Owner>;
    return typeof r.pid === "number" && typeof r.hostname === "string" && typeof r.nonce === "string"
      && typeof r.effectsPending === "boolean" ? r as Owner : null;
  } catch { return null; }
}
function write(fd: number, owner: Owner): void {
  const data = Buffer.from(JSON.stringify(owner));
  fs.writeSync(fd, data, 0, data.length, 0);
  fs.ftruncateSync(fd, data.length);
  fs.fsyncSync(fd);
}
export function acquireFileAuthority(file: string): { release(): void; update(pending: boolean): void } {
  if (fs.existsSync(`${file}.reclaim`)) throw Object.assign(new Error(`Authority reclamation unverified: ${file}`), { code: "EEXIST" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner: Owner = { pid: process.pid, hostname: os.hostname(), nonce: randomUUID(), effectsPending: false };
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = read(file);
    if (!old || !dead(old) || old.effectsPending) throw Object.assign(new Error(`Authority locked or outcome unverified: ${file}`), { code: "EEXIST" });
    // A separate reclaim mutex serializes check/unlink/open. Its own abandoned
    // or legacy metadata is conservative: operator verification is required.
    const reclaim = `${file}.reclaim`;
    const guard = fs.openSync(reclaim, "wx", 0o600);
    try {
      write(guard, owner);
      if (read(file)?.nonce !== old.nonce || !dead(old)) throw new Error("Authority owner changed");
      fs.unlinkSync(file);
      fd = fs.openSync(file, "wx", 0o600);
    } finally { fs.closeSync(guard); if (read(reclaim)?.nonce === owner.nonce) fs.unlinkSync(reclaim); }
  }
  try { write(fd, owner); }
  catch (error) { fs.closeSync(fd); throw error; }
  let released = false;
  const finishRelease = () => {
    fs.closeSync(fd);
    if (read(file)?.nonce === owner.nonce) fs.unlinkSync(file);
  };
  return {
    update(pending) {
      if (read(file)?.nonce !== owner.nonce) throw new Error("Stale filesystem authority");
      owner.effectsPending = pending;
      write(fd, owner);
      if (released && !pending) finishRelease();
    },
    release() {
      released = true;
      if (!owner.effectsPending) finishRelease();
    },
  };
}
/** Stable lifecycle mutex outside the directory that cleanup may remove (§9/§17).
 * Canonicalize the parent, not the workspace: the key survives deletion/recreation. */
export function deliveryLifecycleAuthorityPath(cwd: string): string {
  const absolute = path.resolve(cwd);
  const parent = fs.realpathSync(path.dirname(absolute));
  const key = createHash("sha256").update(path.join(parent, path.basename(absolute))).digest("hex");
  return path.join(parent, ".symphony-host", "delivery-authorities", `${key}.lock`);
}
/** Shared by upgraded hosts and offline maintenance; kept outside issue workspaces. */
export function hostMaintenanceAuthorityPath(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  return path.join(fs.realpathSync(root), ".symphony-host", "host-maintenance.lock");
}
export async function withDeliveryLifecycleAuthority<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const authority = acquireFileAuthority(deliveryLifecycleAuthorityPath(cwd));
  try { return await action(); } finally { authority.release(); }
}
export async function withDeliveryFileAuthority<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lifecycle = acquireFileAuthority(deliveryLifecycleAuthorityPath(path.dirname(path.dirname(file))));
  try {
    const authority = acquireFileAuthority(file);
    try {
      return await deliveryOwner.run({ update: pending => {
        // Outer uncertainty survives even if the workspace is externally removed.
        lifecycle.update(pending);
        authority.update(pending);
      }, count: 0, file }, action);
    } finally { authority.release(); }
  } finally { lifecycle.release(); }
}
/** Mark uncertainty BEFORE spawning; only a confirmed close settles a subprocess.
 * If the parent dies in either gap, recovery blocks rather than replaying an orphan. */
export function beginDeliverySubprocess(): () => void {
  const owner = deliveryOwner.getStore();
  if (!owner) return () => {};
  owner.update(true);
  owner.count++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    owner.count--;
    if (owner.count === 0) owner.update(false);
  };
}

/** Source fact for admission; the owning async action may re-observe under its lock. */
export function deliveryAuthorityBlock(file: string): string | null {
  if (deliveryOwner.getStore()?.file === file) return null;
  if (fs.existsSync(`${file}.reclaim`)) return "delivery_reclaim_interrupted: inspect authority before resuming";
  if (!fs.existsSync(file)) return null;
  const owner = read(file);
  if (!owner) return "legacy_delivery_authority_requires_verification";
  if (owner.effectsPending) return "delivery_subprocess_outcome_unverified: verify old children and remote effects";
  return !dead(owner) ? "delivery_authority_owned" : null;
}
