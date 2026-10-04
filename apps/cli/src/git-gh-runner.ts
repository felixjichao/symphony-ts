import { spawn } from "node:child_process";
import {
  sanitizeCredentials,
  type DeliveryGitGhRunner,
  type DeliverySubprocessResult,
} from "@symphony/agent";

export class DefaultDeliveryGitGhRunner implements DeliveryGitGhRunner {
  async git(args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<DeliverySubprocessResult> {
    return this.runProcess("git", args, cwd, timeoutMs);
  }

  async gh(args: readonly string[], cwd: string, timeoutMs = 60_000): Promise<DeliverySubprocessResult> {
    return this.runProcess("gh", args, cwd, timeoutMs);
  }

  async exec(command: string, cwd: string, timeoutMs = 60_000): Promise<DeliverySubprocessResult> {
    return this.runProcess("/bin/sh", ["-c", command], cwd, timeoutMs);
  }

  private runProcess(
    command: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<DeliverySubprocessResult> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
      } catch (err) {
        reject(new Error(`Failed to spawn ${command}: ${sanitizeCredentials(String(err))}`));
        return;
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already be dead
          }
        }, timeoutMs);
      }

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`${command} execution failed: ${sanitizeCredentials(err.message)}`));
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: sanitizeCredentials(stdout),
          stderr: sanitizeCredentials(stderr),
          exitCode: code ?? 1,
        });
      });
    });
  }
}
