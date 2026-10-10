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

// Real Pulls API responses contain HTTPS URLs followed by git@ SSH URLs.
describe("structured GitHub output", () => {
  it("preserves compact JSON and SHA fields when HTTPS and SSH URLs coexist", () => {
    const response = {
      url: "https://api.github.com/repos/owner/repo/pulls/19",
      head: { sha: "a".repeat(40), repo: { html_url: "https://github.com/owner/repo", ssh_url: "git@github.com:owner/repo.git" } },
      base: { sha: "b".repeat(40) },
      body: "Reviewer @owner must check this commit",
    };
    const input = JSON.stringify(response);
    const output = sanitizeCredentials(input);
    expect(output).toBe(input);
    expect(JSON.parse(output)).toEqual(response);
  });

  it("redacts actual credentials without crossing JSON string boundaries", () => {
    const input = JSON.stringify({ url: "https://user:secret@github.com/owner/repo.git", next: "https://github.com/owner/repo", ssh: "git@github.com:owner/repo.git" });
    const output = sanitizeCredentials(input);
    expect(output).not.toContain("user:secret");
    expect(JSON.parse(output)).toEqual({ url: "https://***:***@github.com/owner/repo.git", next: "https://github.com/owner/repo", ssh: "git@github.com:owner/repo.git" });
  });
});
