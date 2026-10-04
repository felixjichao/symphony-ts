/**
 * Subprocess wrapper for the GitHub CLI (gh) with credential sanitization,
 * timeout enforcement, process group cleanup, and structured error mapping.
 */
import { spawn } from "node:child_process";
import { DeliveryError, type DeliveryErrorCode } from "@symphony/domain";

export interface GhExecOptions {
  readonly timeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly maxBuffer?: number | undefined;
  readonly allowedExitCodes?: readonly number[] | undefined;
}

export interface GhExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GhRunner {
  exec(args: readonly string[], options?: GhExecOptions): Promise<GhExecResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * Strips tokens, passwords, and sensitive credentials from strings and URLs.
 */
export function sanitizeCredentials(text: string): string {
  if (!text) return "";
  return text
    // GitHub personal access tokens and OAuth tokens
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "***")
    // Authorization header
    .replace(/(Authorization:\s*)[^\r\n]+/gi, "$1***")
    .replace(/(["']?bearer["']?\s*[:=]\s*["']?)[a-zA-Z0-9_\-.]{10,}["']?/gi, "$1***")
    // URLs with embedded user credentials: https://user:pass@github.com or https://token@github.com
    .replace(/(https?:\/\/)([^:\s/@]+)(?::([^@\s/]+))?@/g, "$1***@")
    // URL query tokens
    .replace(/([?&](?:token|access_token|api_key|client_secret)=)[^&\s#]+/gi, "$1***");
}

export function classifyGhError(exitCode: number, stderr: string, timeout = false): DeliveryErrorCode {
  if (timeout) {
    return "timeout";
  }
  const lower = stderr.toLowerCase();

  if (
    lower.includes("authentication token") ||
    lower.includes("bad credentials") ||
    lower.includes("could not authenticate") ||
    lower.includes("401 unauthorized")
  ) {
    return "auth_failure";
  }

  if (
    lower.includes("rate limit exceeded") ||
    lower.includes("secondary rate limit") ||
    lower.includes("429 too many requests")
  ) {
    return "rate_limited";
  }

  if (
    lower.includes("could not resolve host") ||
    lower.includes("connection refused") ||
    lower.includes("network is unreachable") ||
    lower.includes("connection timed out") ||
    lower.includes("tls handshake timeout")
  ) {
    return "network_failure";
  }

  return "cli_malformed_response";
}

export class DefaultGhRunner implements GhRunner {
  private readonly ghPath: string;

  constructor(ghPath = "gh") {
    this.ghPath = ghPath;
  }

  async exec(args: readonly string[], options: GhExecOptions = {}): Promise<GhExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const allowedCodes = new Set(options.allowedExitCodes ?? [0]);

    // Ensure non-interactive prompts are disabled
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(options.env ?? {}),
    };

    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      try {
        child = spawn(this.ghPath, args, {
          cwd: options.cwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ENOENT") {
          return reject(
            new DeliveryError(`GitHub CLI executable not found: '${this.ghPath}'`, {
              code: "cli_missing",
              cause: error,
            }),
          );
        }
        return reject(
          new DeliveryError(sanitizeCredentials(error.message), {
            code: "cli_malformed_response",
            cause: error,
          }),
        );
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length + chunk.length > maxBuffer) {
          cleanup();
          killProcessGroup(child);
          return reject(
            new DeliveryError("GitHub CLI output exceeded maximum buffer limit", {
              code: "cli_malformed_response",
            }),
          );
        }
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length + chunk.length > maxBuffer) {
          cleanup();
          killProcessGroup(child);
          return reject(
            new DeliveryError("GitHub CLI error output exceeded maximum buffer limit", {
              code: "cli_malformed_response",
            }),
          );
        }
        stderr += chunk.toString("utf8");
      });

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      if (timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child);
        }, timeoutMs);
      }

      child.on("error", (err: Error) => {
        cleanup();
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          return reject(
            new DeliveryError(`GitHub CLI executable not found: '${this.ghPath}'`, {
              code: "cli_missing",
              cause: nodeErr,
            }),
          );
        }
        return reject(
          new DeliveryError(sanitizeCredentials(err.message), {
            code: "cli_malformed_response",
            cause: err,
          }),
        );
      });

      child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        const code = exitCode ?? (signal ? 128 : 1);
        const cleanStdout = sanitizeCredentials(stdout);
        const cleanStderr = sanitizeCredentials(stderr);

        if (timedOut) {
          return reject(
            new DeliveryError(`GitHub CLI timed out after ${timeoutMs}ms: gh ${args[0] ?? ""}`, {
              code: "timeout",
              details: { timeoutMs, stderr: cleanStderr.slice(0, 500) },
            }),
          );
        }

        if (allowedCodes.has(code)) {
          return resolve({
            stdout: cleanStdout,
            stderr: cleanStderr,
            exitCode: code,
          });
        }

        const errorCode = classifyGhError(code, cleanStderr);
        return reject(
          new DeliveryError(`GitHub CLI failed with exit code ${code}: ${cleanStderr.trim() || cleanStdout.trim()}`, {
            code: errorCode,
            details: {
              exitCode: code,
              stderr: cleanStderr.slice(0, 1000),
            },
          }),
        );
      });
    });
  }
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignored
      }
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignored
    }
  }
}
