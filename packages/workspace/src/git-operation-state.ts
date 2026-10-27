/** Read-only Git lifecycle inspection for Delivery (§9 adjacent, #186).
 * The caller obtains the per-worktree metadata directory from Git itself;
 * linked worktrees can legitimately keep metadata outside the checkout. */
import { lstatSync } from "node:fs";
import path from "node:path";

export function inspectGitOperationState(gitDirectory: string): readonly string[] {
  if (!path.isAbsolute(gitDirectory)) throw new Error("Git metadata directory must be absolute");
  if (!lstatSync(gitDirectory).isDirectory()) throw new Error("Git metadata directory is not a directory");
  const present: string[] = [];
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
    try { lstatSync(path.join(gitDirectory, name)); present.push(name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return present;
}
