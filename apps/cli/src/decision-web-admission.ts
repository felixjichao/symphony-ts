import type { DecisionTask } from "@symphony/domain";
import { DefaultDeliveryGitGhRunner } from "./git-gh-runner";

/** Fresh GitHub target observation at browser recovery/navigation/Send boundaries.
 * Native lease/revision/binding checks still happen in the Decision transaction afterwards. */
export async function authorizeDecisionWebExecution(
  task: DecisionTask,
  runner: Pick<DefaultDeliveryGitGhRunner, "gh"> = new DefaultDeliveryGitGhRunner(),
): Promise<boolean> {
  if (task.kind !== "review") return true;
  try {
    const response = await runner.gh(["api", `repos/${task.target.repository}/pulls/${task.target.prNumber}`], process.cwd(), 10_000);
    if (response.exitCode !== 0) return false;
    const pr = JSON.parse(response.stdout) as { number?: unknown; state?: unknown; head?: { sha?: unknown } };
    return pr.number === task.target.prNumber && pr.state === "open" && pr.head?.sha === task.target.headSha;
  } catch { return false; }
}
