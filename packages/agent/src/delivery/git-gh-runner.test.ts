import { describe, expect, it } from "vitest";

import { sanitizeCredentials } from "./git-gh-runner";

describe("git-gh-runner credential sanitization", () => {
  it("sanitizes classic personal access tokens (ghp_*)", () => {
    const input = "git clone https://ghp_1234567890abcdef1234567890abcdef1234@github.com/repo.git";
    const sanitized = sanitizeCredentials(input);
    expect(sanitized).not.toContain("ghp_1234567890abcdef");
    expect(sanitized).toContain("***:***@");
  });

  it("sanitizes fine-grained personal access tokens (github_pat_*)", () => {
    const input = "fatal: github_pat_11AAAAAAA01234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ: bad credentials";
    const sanitized = sanitizeCredentials(input);
    expect(sanitized).not.toContain("github_pat_");
    expect(sanitized).toContain("***REDACTED_TOKEN***");
  });

  it("sanitizes authorization bearer tokens", () => {
    const input = "Authorization: Bearer my_secret_token_1234567890";
    const sanitized = sanitizeCredentials(input);
    expect(sanitized).not.toContain("my_secret_token_1234567890");
    expect(sanitized).toContain("Bearer ***");
  });

  it("sanitizes embedded user:password URLs", () => {
    const input = "remote origin url: http://user:super_secret_password@git.example.com/repo";
    const sanitized = sanitizeCredentials(input);
    expect(sanitized).not.toContain("super_secret_password");
    expect(sanitized).toContain("http://***:***@git.example.com/repo");
  });
});
