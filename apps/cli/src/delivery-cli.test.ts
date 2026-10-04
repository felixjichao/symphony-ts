import { describe, expect, it, vi } from "vitest";
import { DeliveryError, type PrRecord } from "@symphony/domain";
import { type GitHubDeliveryService, type PrChecksReport } from "@symphony/tracker";
import { parseDeliveryArgs, runDeliveryCli } from "./delivery-cli";

describe("delivery-cli", () => {
  describe("parseDeliveryArgs", () => {
    it("parses ensure action with arguments", () => {
      const args = parseDeliveryArgs([
        "ensure",
        "--repo",
        "felixjichao/symphony-ts",
        "--issue",
        "81",
        "--workspace-key",
        "nest-92",
        "--head",
        "symphony/nest-92",
        "--base",
        "main",
        "--title",
        "PR title",
        "--body",
        "PR body",
        "--draft",
        "--json",
      ]);

      expect(args.action).toBe("ensure");
      expect(args.repo).toBe("felixjichao/symphony-ts");
      expect(args.issueNumber).toBe(81);
      expect(args.workspaceKey).toBe("nest-92");
      expect(args.headBranch).toBe("symphony/nest-92");
      expect(args.baseBranch).toBe("main");
      expect(args.title).toBe("PR title");
      expect(args.body).toBe("PR body");
      expect(args.draft).toBe(true);
      expect(args.json).toBe(true);
    });

    it("parses land action with --opt-in", () => {
      const args = parseDeliveryArgs([
        "land",
        "--repo",
        "felixjichao/symphony-ts",
        "--issue",
        "81",
        "--workspace-key",
        "nest-92",
        "--opt-in",
        "--expected-head",
        "sha123",
        "--delete-branch",
      ]);

      expect(args.action).toBe("land");
      expect(args.optIn).toBe(true);
      expect(args.expectedHeadSha).toBe("sha123");
      expect(args.deleteBranch).toBe(true);
    });
  });

  describe("runDeliveryCli execution", () => {
    const mockPr: PrRecord = {
      number: 81,
      url: "https://github.com/felixjichao/symphony-ts/pull/81",
      title: "PR Title",
      body: "PR Body",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      headBranch: "symphony/nest-92",
      headSha: "sha81",
      baseBranch: "main",
      mergedAt: null,
      mergeCommitSha: null,
      marker: null,
    };

    const mockChecksPass: PrChecksReport = {
      prNumber: 81,
      headSha: "sha81",
      status: "passed",
      canAutoMerge: true,
      reason: "All checks passed",
      requiredChecks: [],
      currentChecks: [],
      failedOrPendingChecks: [],
    };

    const mockChecksFail: PrChecksReport = {
      prNumber: 81,
      headSha: "sha81",
      status: "pending",
      canAutoMerge: false,
      reason: "Check gate is pending",
      requiredChecks: [],
      currentChecks: [],
      failedOrPendingChecks: [],
    };

    const createServiceMock = (overrides: Partial<GitHubDeliveryService> = {}): GitHubDeliveryService => {
      return {
        ensurePr: vi.fn(async () => mockPr),
        readPr: vi.fn(async () => mockPr),
        readChecks: vi.fn(async () => mockChecksPass),
        diagnoseFailedChecks: vi.fn(() => "All checks passed"),
        landPr: vi.fn(async () => ({
          merged: true as const,
          prNumber: 81,
          headSha: "sha81",
          mergeCommitSha: "squashSha81",
          mergedAt: "2026-10-04T09:00:00Z",
        })),
        verifyMerged: vi.fn(async () => ({
          merged: true,
          prNumber: 81,
          headSha: "sha81",
          mergeCommitSha: "squashSha81",
          mergedAt: "2026-10-04T09:00:00Z",
        })),
        ...overrides,
      } as unknown as GitHubDeliveryService;
    };

    it("displays help when called with --help or no action", async () => {
      let stdout = "";
      const code = await runDeliveryCli(["--help"], {
        stdout: { write: (t) => { stdout += t; } },
      });
      expect(code).toBe(0);
      expect(stdout).toContain("Usage: symphony pr <action>");
    });

    it("fails when required context flags are missing", async () => {
      let stderr = "";
      const code = await runDeliveryCli(["ensure", "--repo", "org/repo"], {
        stderr: { write: (t) => { stderr += t; } },
      });
      expect(code).toBe(1);
      expect(stderr).toContain("missing required options");
    });

    it("executes ensure command and prints text", async () => {
      let stdout = "";
      const service = createServiceMock();
      const code = await runDeliveryCli(
        ["ensure", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stdout: { write: (t) => { stdout += t; } },
          service,
        },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("PR #81 ensured");
      expect(service.ensurePr).toHaveBeenCalled();
    });

    it("executes ensure command with --json", async () => {
      let stdout = "";
      const service = createServiceMock();
      const code = await runDeliveryCli(
        ["ensure", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81", "--json"],
        {
          stdout: { write: (t) => { stdout += t; } },
          service,
        },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.number).toBe(81);
    });

    it("executes checks command: returns 0 when passing, 2 when failing", async () => {
      const passingService = createServiceMock({ readChecks: vi.fn(async () => mockChecksPass) });
      const passCode = await runDeliveryCli(
        ["checks", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stdout: { write: () => {} },
          service: passingService,
        },
      );
      expect(passCode).toBe(0);

      const failingService = createServiceMock({ readChecks: vi.fn(async () => mockChecksFail) });
      const failCode = await runDeliveryCli(
        ["checks", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stdout: { write: () => {} },
          service: failingService,
        },
      );
      expect(failCode).toBe(2);
    });

    it("executes land command: requires --opt-in", async () => {
      let stderr = "";
      const service = createServiceMock();
      const code = await runDeliveryCli(
        ["land", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stderr: { write: (t) => { stderr += t; } },
          service,
        },
      );
      expect(code).toBe(1);
      expect(stderr).toContain("land requires explicit opt-in (--opt-in)");
      expect(service.landPr).not.toHaveBeenCalled();
    });

    it("executes land command with --opt-in and merges", async () => {
      let stdout = "";
      const service = createServiceMock();
      const code = await runDeliveryCli(
        ["land", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81", "--opt-in"],
        {
          stdout: { write: (t) => { stdout += t; } },
          service,
        },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("successfully merged");
      expect(service.landPr).toHaveBeenCalled();
    });

    it("executes verify command: returns 0 when merged, 2 when not merged", async () => {
      const mergedService = createServiceMock({
        verifyMerged: vi.fn(async () => ({
          merged: true,
          prNumber: 81,
          headSha: "sha81",
          mergeCommitSha: "squash81",
          mergedAt: "2026-10-04T09:00:00Z",
        })),
      });
      const passCode = await runDeliveryCli(
        ["verify", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stdout: { write: () => {} },
          service: mergedService,
        },
      );
      expect(passCode).toBe(0);

      const unmergedService = createServiceMock({
        verifyMerged: vi.fn(async () => ({
          merged: false,
          prNumber: 81,
          headSha: "sha81",
          mergeCommitSha: null,
          mergedAt: null,
        })),
      });
      const failCode = await runDeliveryCli(
        ["verify", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stdout: { write: () => {} },
          service: unmergedService,
        },
      );
      expect(failCode).toBe(2);
    });

    it("sanitizes error output when DeliveryError is thrown", async () => {
      let stderr = "";
      const token = "ghp_secrettoken12345678901234567890";
      const failingService = createServiceMock({
        ensurePr: vi.fn(async () => {
          throw new DeliveryError(`Auth failed with token ${token}`, { code: "auth_failure" });
        }),
      });

      const code = await runDeliveryCli(
        ["ensure", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stderr: { write: (t) => { stderr += t; } },
          service: failingService,
        },
      );
      expect(code).toBe(1);
      expect(stderr).toContain("auth_failure");
      expect(stderr).not.toContain(token);
      expect(stderr).toContain("***");
    });

    it("outputs valid JSON for diagnostics --json", async () => {
      let stdout = "";
      const service = createServiceMock({ readChecks: vi.fn(async () => mockChecksFail) });
      const code = await runDeliveryCli(
        ["diagnostics", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81", "--json"],
        {
          stdout: { write: (t) => { stdout += t; } },
          service,
        },
      );
      expect(code).toBe(2);
      const parsed = JSON.parse(stdout);
      expect(parsed.canAutoMerge).toBe(false);
      expect(parsed.status).toBe("pending");
      expect(parsed.diagnostics).toBeDefined();
    });

    it("sanitizes tokens in unrecognized action", async () => {
      let stderr = "";
      const token = "ghp_secrettoken12345678901234567890";
      const code = await runDeliveryCli(
        [token, "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81"],
        {
          stderr: { write: (t) => { stderr += t; } },
        },
      );
      expect(code).toBe(1);
      expect(stderr).not.toContain(token);
      expect(stderr).toContain("***");
    });

    it("outputs structured JSON errors for missing args and opt-in", async () => {
      let stderrMissing = "";
      const codeMissing = await runDeliveryCli(["--json"], {
        stderr: { write: (t) => { stderrMissing += t; } },
      });
      expect(codeMissing).toBe(1);
      const parsedMissing = JSON.parse(stderrMissing);
      expect(parsedMissing.error).toBe("missing_action");

      let stderrOptIn = "";
      const codeOptIn = await runDeliveryCli(
        ["land", "--repo", "org/repo", "--issue", "81", "--workspace-key", "ws-81", "--json"],
        {
          stderr: { write: (t) => { stderrOptIn += t; } },
        },
      );
      expect(codeOptIn).toBe(1);
      const parsedOptIn = JSON.parse(stderrOptIn);
      expect(parsedOptIn.error).toBe("opt_in_required");
    });
  });
});
