import type { DeliveryGitGhRunner, DeliverySubprocessResult } from "./git-gh-runner";

// SPEC §9 adjacent: runtime state never becomes source, including staged state.
export const SOURCE_PATHS = [":(top)**", ":(top,exclude).symphony", ":(top,exclude).symphony/**"] as const;

/** Enumerate tracked (including deleted) and non-ignored untracked files first.
 * Wildcard git-add pathspecs can report ignored .symphony as an error after
 * partially staging source. NUL records + literal top paths also handle filenames
 * containing whitespace, newlines or pathspec magic, from a nested cwd. */
export async function stageSourceChanges(runner: DeliveryGitGhRunner, cwd: string, timeoutMs?: number): Promise<DeliverySubprocessResult> {
  const files = await runner.git(["ls-files", "--full-name", "--cached", "--others", "--exclude-standard", "-z", "--", ...SOURCE_PATHS], cwd, timeoutMs);
  if (files.exitCode !== 0) return files;
  const paths = [...new Set(files.stdout.split("\0").filter(p => p && p !== ".symphony" && !p.startsWith(".symphony/")))];
  for (let start = 0; start < paths.length; start += 100) {
    const result = await runner.git(["add", "-A", "--", ...paths.slice(start, start + 100).map(p => `:(top,literal)${p}`)], cwd, timeoutMs);
    if (result.exitCode !== 0) return result;
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
