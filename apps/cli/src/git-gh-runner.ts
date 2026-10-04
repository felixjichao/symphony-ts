import { spawn } from "node:child_process";
import {
  sanitizeCredentials,
  type DeliveryGitGhRunner,
  type DeliverySubprocessResult,
} from "@symphony/agent";

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already be dead
    }
  }
}

export class DefaultDeliveryGitGhRunner implements DeliveryGitGhRunner {
  async git(args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<DeliverySubprocessResult> {
    return this.runProcess("git", args, cwd, timeoutMs);
  }

  async gh(args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<DeliverySubprocessResult> {
    return this.runProcess("gh", args, cwd, timeoutMs);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs = 60_000,
    env?: Record<string, string>,
  ): Promise<DeliverySubprocessResult> {
    return this.runProcess("/bin/sh", ["-c", command], cwd, timeoutMs, env);
  }

  private runProcess(
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    extraEnv?: Record<string, string>,
  ): Promise<DeliverySubprocessResult> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...extraEnv },
        });
      } catch (err) {
        reject(new Error(`Failed to spawn ${command}: ${sanitizeCredentials(String(err))}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let forceSettleTimer: NodeJS.Timeout | null = null;

      const finish = (result: DeliverySubprocessResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(result);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
          child.stdout?.destroy();
          child.stderr?.destroy();
          forceSettleTimer = setTimeout(() => {
            finish({
              stdout: sanitizeCredentials(stdout),
              stderr: sanitizeCredentials(
                stderr ? `${stderr}\nTimed out after ${timeoutMs}ms` : `Timed out after ${timeoutMs}ms`,
              ),
              exitCode: 124,
            });
          }, 100);
        }, timeoutMs);
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        reject(new Error(`${command} execution failed: ${sanitizeCredentials(err.message)}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (timedOut) {
          finish({
            stdout: sanitizeCredentials(stdout),
            stderr: sanitizeCredentials(
              stderr ? `${stderr}\nTimed out after ${timeoutMs}ms` : `Timed out after ${timeoutMs}ms`,
            ),
            exitCode: 124,
          });
          return;
        }
        finish({
          stdout: sanitizeCredentials(stdout),
          stderr: sanitizeCredentials(stderr),
          exitCode: code ?? 1,
        });
      });
    });
  }
}
