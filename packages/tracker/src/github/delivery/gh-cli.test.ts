import { describe, expect, it } from "vitest";
import { DeliveryError } from "@symphony/domain";
import {
  DefaultGhRunner,
  classifyGhError,
  sanitizeCredentials,
} from "./gh-cli";

describe("gh-cli transport & safety", () => {
  describe("sanitizeCredentials", () => {
    it("strips personal access tokens (ghp_*)", () => {
      const input = "Using token ghp_1234567890abcdefghijklmnopqrstuvwxyzAB in request";
      const sanitized = sanitizeCredentials(input);
      expect(sanitized).toBe("Using token *** in request");
      expect(sanitized).not.toContain("ghp_");
    });

    it("strips fine-grained personal access tokens (github_pat_*)", () => {
      const input = "Token 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 expired";
      const sanitized = sanitizeCredentials(input);
      expect(sanitized).toBe("Token *** expired");
      expect(sanitized).not.toContain("github_pat_");
    });

    it("strips embedded userinfo from https URLs", () => {
      const input = "Remote origin is https://x-access-token:ghp_secretpassword@github.com/org/repo.git";
      const sanitized = sanitizeCredentials(input);
      expect(sanitized).toBe("Remote origin is https://***@github.com/org/repo.git");
      expect(sanitized).not.toContain("secretpassword");
      expect(sanitized).not.toContain("x-access-token");
    });

    it("strips query string token parameters", () => {
      const input = "https://api.github.com/repo/checks?token=secret12345&other=1";
      const sanitized = sanitizeCredentials(input);
      expect(sanitized).toContain("token=***");
      expect(sanitized).not.toContain("secret12345");
    });

    it("strips Authorization headers", () => {
      const input = "Headers: Authorization: Bearer gho_supersecrettoken12345\nContent-Type: application/json";
      const sanitized = sanitizeCredentials(input);
      expect(sanitized).toContain("Authorization: ***");
      expect(sanitized).not.toContain("gho_");
    });
  });

  describe("classifyGhError", () => {
    it("classifies timeout", () => {
      expect(classifyGhError(1, "", true)).toBe("timeout");
    });

    it("classifies authentication failures", () => {
      expect(classifyGhError(1, "gh: Authentication token is invalid")).toBe("auth_failure");
      expect(classifyGhError(1, "HTTP 401: Bad credentials")).toBe("auth_failure");
    });

    it("classifies rate limiting", () => {
      expect(classifyGhError(1, "HTTP 429: API rate limit exceeded for user")).toBe("rate_limited");
      expect(classifyGhError(1, "secondary rate limit hit")).toBe("rate_limited");
    });

    it("classifies network failures", () => {
      expect(classifyGhError(1, "Could not resolve host: github.com")).toBe("network_failure");
      expect(classifyGhError(1, "connection refused")).toBe("network_failure");
      expect(classifyGhError(1, "TLS handshake timeout")).toBe("network_failure");
    });

    it("defaults other errors to cli_malformed_response", () => {
      expect(classifyGhError(1, "unknown error occurred")).toBe("cli_malformed_response");
    });
  });

  describe("DefaultGhRunner execution", () => {
    it("rejects with cli_missing when gh executable does not exist", async () => {
      const runner = new DefaultGhRunner("non_existent_gh_binary_12345");
      await expect(runner.exec(["version"])).rejects.toThrowError(DeliveryError);
      try {
        await runner.exec(["version"]);
      } catch (err) {
        expect((err as DeliveryError).code).toBe("cli_missing");
      }
    });

    it("executes real command (echo) when given custom binary", async () => {
      const runner = new DefaultGhRunner("echo");
      const res = await runner.exec(["hello", "world"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello world");
    });

    it("allows specified exit codes (e.g. 8 for checks pending)", async () => {
      // Use bash or sh to return exit 8
      const runner = new DefaultGhRunner("sh");
      const res = await runner.exec(["-c", "exit 8"], { allowedExitCodes: [0, 8] });
      expect(res.exitCode).toBe(8);
    });

    it("terminates process on timeout and throws timeout error", async () => {
      const runner = new DefaultGhRunner("sleep");
      await expect(runner.exec(["10"], { timeoutMs: 100 })).rejects.toThrowError(DeliveryError);
      try {
        await runner.exec(["10"], { timeoutMs: 100 });
      } catch (err) {
        expect((err as DeliveryError).code).toBe("timeout");
      }
    });

    it("ensures zero token leakage in Error.message on command failure with fixed safe message", async () => {
      const runner = new DefaultGhRunner("sh");
      const secret = "ghp_supersecretvalue123456789012345";
      try {
        await runner.exec(["-c", `echo "Error with ${secret}" >&2; exit 1`]);
        expect.fail("Should have failed");
      } catch (err) {
        const delErr = err as DeliveryError;
        expect(delErr.message).not.toContain(secret);
        expect(delErr.message).toBe("GitHub CLI failed with exit code 1 on gh -c");
      }
    });

    it("extracts HTTP status code and maps to fixed safe message", async () => {
      const runner = new DefaultGhRunner("sh");
      const secretToken = "40_char_token_abcdef1234567890abcdef1234567890";
      try {
        await runner.exec(["-c", `echo "HTTP 403: token ${secretToken} permission denied" >&2; exit 1`]);
        expect.fail("Should have failed");
      } catch (err) {
        const delErr = err as DeliveryError;
        expect(delErr.message).toBe("GitHub CLI command failed with HTTP 403 (exit code 1)");
        expect(delErr.message).not.toContain(secretToken);
        expect(delErr.details?.["httpStatus"]).toBe(403);
        expect(delErr.code).toBe("auth_failure");
      }
    });

    it("preserves JSON payload structure in stdout when field contains KEY=value", async () => {
      const runner = new DefaultGhRunner("echo");
      const jsonPayload = JSON.stringify({
        title: "Configure API_KEY=some_value",
        body: "<!-- symphony-delivery-marker: test -->",
      });
      const res = await runner.exec([jsonPayload]);
      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.title).toBe("Configure API_KEY=some_value");
      expect(parsed.body).toBe("<!-- symphony-delivery-marker: test -->");
    });
  });
});
