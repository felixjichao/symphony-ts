import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectGitOperationState } from "./git-operation-state";

let directory: string | undefined;
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
it("inspects per-worktree Git state without modifying files, including broken symlinks", () => {
  const gitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-"));
  directory = gitDirectory;
  expect(inspectGitOperationState(gitDirectory)).toEqual([]);
  fs.writeFileSync(path.join(gitDirectory, "MERGE_HEAD"), "pinned base\n");
  fs.mkdirSync(path.join(gitDirectory, "rebase-merge"));
  fs.symlinkSync(path.join(gitDirectory, "missing"), path.join(gitDirectory, "CHERRY_PICK_HEAD"));
  expect(inspectGitOperationState(gitDirectory)).toEqual(["MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD"]);
  expect(fs.readFileSync(path.join(gitDirectory, "MERGE_HEAD"), "utf8")).toBe("pinned base\n");
});
it("fails closed on invalid or missing metadata directories", () => {
  expect(() => inspectGitOperationState("relative/.git")).toThrow("absolute");
  const gitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-"));
  directory = gitDirectory;
  expect(() => inspectGitOperationState(path.join(gitDirectory, "missing"))).toThrow();
  fs.writeFileSync(path.join(gitDirectory, "file"), "gitdir: elsewhere");
  expect(() => inspectGitOperationState(path.join(gitDirectory, "file"))).toThrow("not a directory");
});
