import { describe, expect, it, vi } from "vitest";
import {
  formatPrBody,
  type DeliveryContext,
  type DeliveryReviewGate,
  type PrOwnershipMarker,
  DeliveryError,
} from "@symphony/domain";
import {
  GitHubDeliveryService,
  parseJsonStream,
  extractAppId,
  matchesAppConstraint,
} from "./delivery-service";
import type { GhExecOptions, GhExecResult, GhRunner } from "./gh-cli";

describe("GitHubDeliveryService", () => {
  const context: DeliveryContext = {
    repo: "felixjichao/symphony-ts",
    issueNumber: 81,
    workspaceKey: "nest-92-c67d34d77de5",
    headBranch: "symphony/nest-92-c67d34d77de5",
    baseBranch: "main",
  };

  const approvedMockReviewGate: DeliveryReviewGate = {
    ensureReviewTask: vi.fn(),
    getReviewStatus: vi.fn(),
    verifyReviewApproval: vi.fn().mockResolvedValue({
      approved: true,
      reason: "Review approved",
      headSha: "sha81",
      verdict: "approve",
    }),
  };

  const sampleMarker: PrOwnershipMarker = {
    schemaVersion: 1,
    repo: "felixjichao/symphony-ts",
    issueNumber: 81,
    workspaceKey: "nest-92-c67d34d77de5",
    headBranch: "symphony/nest-92-c67d34d77de5",
    baseBranch: "main",
  };

  const validBody = formatPrBody({
    body: "Delivery implementation",
    context,
  });

  const defaultMockPr = (overrides: Record<string, unknown> = {}) => ({
    number: 81,
    title: "PR Title",
    body: validBody,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefName: context.headBranch,
    headRefOid: "sha81",
    baseRefName: context.baseBranch,
    url: "https://github.com/felixjichao/symphony-ts/pull/81",
    mergedAt: null,
    mergeCommit: null,
    isCrossRepository: false,
    headRepositoryOwner: { login: "felixjichao" },
    headRepository: { name: "symphony-ts" },
    ...overrides,
  });

  const createMockRunner = (handler: (args: readonly string[], options?: GhExecOptions) => Promise<GhExecResult>): GhRunner => ({
    exec: vi.fn(handler),
  });

  describe("ensurePr", () => {
    it("creates a new PR when zero candidates exist", async () => {
      let createdPr = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          if (!createdPr) {
            return { stdout: "[]", stderr: "", exitCode: 0 };
          }
          return {
            stdout: JSON.stringify([
              defaultMockPr({
                number: 101,
                title: "PR Title",
                headRefOid: "sha101",
                url: "https://github.com/felixjichao/symphony-ts/pull/101",
              }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "create") {
          createdPr = true;
          return { stdout: "https://github.com/felixjichao/symphony-ts/pull/101\n", stderr: "", exitCode: 0 };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const pr = await service.ensurePr(context, { title: "Custom Title" });

      expect(pr.number).toBe(101);
      expect(pr.state).toBe("OPEN");
      expect(pr.marker).toEqual(sampleMarker);
      expect(runner.exec).toHaveBeenCalledWith(
        expect.arrayContaining(["pr", "create", "--repo", context.repo, "--head", context.headBranch]),
      );
    });

    it("reuses existing PR when exactly one valid matching PR exists", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: JSON.stringify([
              defaultMockPr({
                number: 99,
                title: "Existing PR",
                headRefOid: "sha99",
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const pr = await service.ensurePr(context);

      expect(pr.number).toBe(99);
      expect(pr.headSha).toBe("sha99");
    });

    it("rejects candidate when Symphony marker is missing (foreign PR refusal)", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: JSON.stringify([
              defaultMockPr({
                number: 99,
                title: "Foreign PR",
                body: "Hand-crafted PR without marker Fixes #81",
                headRefOid: "sha99",
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.ensurePr(context)).rejects.toThrowError(DeliveryError);
      try {
        await service.ensurePr(context);
      } catch (err) {
        expect((err as DeliveryError).code).toBe("ownership_refusal");
      }
    });

    it("rejects candidate when base branch mismatches", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: JSON.stringify([
              defaultMockPr({
                number: 99,
                title: "PR on dev",
                baseRefName: "development",
                headRefOid: "sha99",
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      try {
        await service.ensurePr(context);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("ownership_refusal");
      }
    });

    it("rejects when PR is closed without being merged", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: JSON.stringify([
              defaultMockPr({
                number: 99,
                title: "Closed PR",
                state: "CLOSED",
                headRefOid: "sha99",
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      try {
        await service.ensurePr(context);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("pr_closed_unmerged");
      }
    });

    it("rejects when multiple candidates exist for the same head branch", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return {
            stdout: JSON.stringify([
              defaultMockPr({ number: 98, headRefOid: "sha98" }),
              defaultMockPr({ number: 99, headRefOid: "sha99" }),
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      try {
        await service.ensurePr(context);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("ownership_refusal");
      }
    });
  });

  describe("readPr", () => {
    it("reads PR and verifies marker", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 84,
              title: "PR 84",
              state: "MERGED",
              headRefOid: "sha84",
              url: "https://github.com/felixjichao/symphony-ts/pull/84",
              mergedAt: "2026-10-04T09:00:00Z",
              mergeCommit: { oid: "commit84" },
            })),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const pr = await service.readPr(context, { prNumber: 84 });

      expect(pr.number).toBe(84);
      expect(pr.state).toBe("MERGED");
      expect(pr.mergeCommitSha).toBe("commit84");
      expect(pr.marker).toEqual(sampleMarker);
    });
  });

  describe("readChecks and diagnoseFailedChecks", () => {
    it("evaluates green checks and allows auto-merge under fallback policy", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              title: "PR 81",
              headRefOid: "sha81",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: "https://github.com/runs/1",
                  workflowName: "CI",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: null,
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81, expectedHeadSha: "sha81" });

      expect(report.canAutoMerge).toBe(true);
      expect(report.status).toBe("passed");
      expect(report.currentChecks).toHaveLength(1);
      expect(report.requiredChecks).toHaveLength(0);

      const diag = service.diagnoseFailedChecks(report);
      expect(diag).toContain("All checks passed");
    });

    it("evaluates required checks when configured and detects pending check", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusCheckContexts: ["gate"],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              title: "PR 81",
              headRefOid: "sha81",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "IN_PROGRESS",
                  conclusion: null,
                  detailsUrl: "https://github.com/runs/1",
                  workflowName: "CI",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });

      expect(report.canAutoMerge).toBe(false);
      expect(report.status).toBe("pending");
      expect(report.requiredChecks).toHaveLength(1);
      expect(report.requiredChecks[0]!.name).toBe("gate");

      const diag = service.diagnoseFailedChecks(report);
      expect(diag).toContain("CI Check Policy Evaluation: PENDING");
      expect(diag).toContain("[REQUIRED] gate (CI): PENDING");
    });

    it("throws head_changed when expected head SHA does not match PR head", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          title: "PR 81",
          headRefOid: "freshHeadSha",
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      try {
        await service.readChecks(context, { expectedHeadSha: "oldHeadSha" });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("head_changed");
      }
    });

    it("throws checks_unknown when statusCheckRollup item has unknown __typename", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: null },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "UnknownCheckType",
                  name: "unexpected",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("paginates branch rulesets API and accumulates required checks across pages", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: null },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          expect(args).toContain("--paginate");
          // Return concatenated JSON arrays simulating gh api --paginate multi-page response
          const page1 = [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "build" }],
              },
            },
          ];
          const page2 = [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "test" }],
              },
            },
          ];
          return {
            stdout: `${JSON.stringify(page1)}${JSON.stringify(page2)}`,
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });

      expect(report.canAutoMerge).toBe(true);
      expect(report.requiredChecks).toHaveLength(2);
      expect(report.requiredChecks.map(c => c.name).sort()).toEqual(["build", "test"]);
    });

    it("fails closed with checks_unknown when rulesets API returns malformed non-array JSON", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: null },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "{}", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when rulesets API encounters 403 or network failure", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: null },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          throw new DeliveryError("GitHub CLI command failed with HTTP 403 (exit code 1)", {
            code: "auth_failure",
            details: { httpStatus: 403 },
          });
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when GraphQL branch protection response is missing baseRef", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({ data: {} }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({ number: 81 })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });
  });

  describe("landPr", () => {
    it("rejects merge when optIn is not set", async () => {
      const runner = createMockRunner(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const service = new GitHubDeliveryService(runner);

      try {
        await service.landPr(context, { optIn: false });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("opt_in_required");
      }
    });

    it("rejects merge when PR is conflicting or in draft", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              title: "PR 81",
              mergeable: "CONFLICTING",
            })),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      try {
        await service.landPr(context, { optIn: true, reviewGate: approvedMockReviewGate });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("merge_rejected");
      }
    });

    it("rejects merge when reviewGate is missing", async () => {
      const runner = createMockRunner(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const service = new GitHubDeliveryService(runner);

      await expect(service.landPr(context, { optIn: true, prNumber: 81 })).rejects.toMatchObject({
        code: "review_gate_required",
      });
    });

    it("rejects merge when reviewGate verification fails", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              title: "PR 81",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return {
            stdout: JSON.stringify({
              data: { repository: { pullRequest: { baseRef: { branchProtectionRule: null } } } },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const rejectedGate: DeliveryReviewGate = {
        ensureReviewTask: vi.fn(),
        getReviewStatus: vi.fn(),
        verifyReviewApproval: vi.fn().mockResolvedValue({
          approved: false,
          reason: "Changes requested by reviewer",
        }),
      };
      await expect(
        service.landPr(context, { optIn: true, prNumber: 81, reviewGate: rejectedGate })
      ).rejects.toMatchObject({
        code: "review_not_approved",
      });
    });

    it("derives review gate session from context.issueNumber when PR number differs", async () => {
      let merged = false;
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 104,
              title: "PR 104",
              state: merged ? "MERGED" : "OPEN",
              mergedAt: merged ? "2026-10-04T09:10:00Z" : null,
              mergeCommit: merged ? { oid: "squash104" } : null,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return {
            stdout: JSON.stringify({
              data: { repository: { pullRequest: { baseRef: { branchProtectionRule: null } } } },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }
        if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/pulls/104/merge")) {
          merged = true;
          return { stdout: JSON.stringify({ sha: "squash104", merged: true }), stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const verifyFn = vi.fn().mockResolvedValue({ approved: true, verdict: "approve" });
      const mockGate: DeliveryReviewGate = {
        ensureReviewTask: vi.fn(),
        getReviewStatus: vi.fn(),
        verifyReviewApproval: verifyFn,
      };

      // context.issueNumber is 81, PR is 104
      await service.landPr(context, { optIn: true, prNumber: 104, reviewGate: mockGate });
      expect(verifyFn).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: context.repo,
          prNumber: 104,
          sessionId: `github:${context.repo}#${context.issueNumber}`,
        })
      );
    });

    it("rejects merge when options.sessionId does not match root issue session", async () => {
      const runner = createMockRunner(async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 104,
              title: "PR 104",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && args[1] === "graphql") {
          return {
            stdout: JSON.stringify({
              data: { repository: { pullRequest: { baseRef: { branchProtectionRule: null } } } },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(
        service.landPr(context, {
          optIn: true,
          prNumber: 104,
          sessionId: `github:${context.repo}#104`, // Mismatched session (PR-based instead of Issue-based)
          reviewGate: approvedMockReviewGate,
        })
      ).rejects.toMatchObject({
        code: "session_mismatch",
      });
    });

    it("merges with squash and verifies merged state", async () => {
      let mergedState = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              title: "PR 81",
              state: mergedState ? "MERGED" : "OPEN",
              mergedAt: mergedState ? "2026-10-04T09:10:00Z" : null,
              mergeCommit: mergedState ? { oid: "squashcommit81" } : null,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: null,
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/pulls/81/merge")) {
          expect(args).toContain("merge_method=squash");
          expect(args).toContain("sha=sha81");
          mergedState = true;
          return { stdout: JSON.stringify({ sha: "squashcommit81", merged: true }), stderr: "", exitCode: 0 };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const result = await service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate });

      expect(result.merged).toBe(true);
      expect(result.prNumber).toBe(81);
      expect(result.mergeCommitSha).toBe("squashcommit81");
      expect(result.mergedAt).toBe("2026-10-04T09:10:00Z");
    });
  });

  describe("verifyMerged", () => {
    it("reports whether PR is merged", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          title: "PR 81",
          state: "MERGED",
          mergedAt: "2026-10-04T09:10:00Z",
          mergeCommit: { oid: "squashcommit81" },
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      const result = await service.verifyMerged(context, { prNumber: 81 });

      expect(result.merged).toBe(true);
      expect(result.mergeCommitSha).toBe("squashcommit81");
    });

    it("throws verification_unknown when merged PR lacks mergeCommitSha or mergedAt in verifyMerged and landPr", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          title: "PR 81",
          state: "MERGED",
          mergedAt: null,
          mergeCommit: null,
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "verification_unknown",
      });
      await expect(service.verifyMerged(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "verification_unknown",
      });
    });
  });

  describe("security boundaries and regression guards", () => {
    it("refuses PR from a cross-repository fork", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          isCrossRepository: true,
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.readPr(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "ownership_refusal",
      });
    });

    it("refuses OPEN PR with unverified/missing crossRepository identity", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          isCrossRepository: null,
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.readPr(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "ownership_refusal",
      });
    });

    it("refuses PR with mismatched head repository identity", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          headRepositoryOwner: { login: "attacker" },
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.readPr(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "ownership_refusal",
      });
    });

    it("refuses PR with mismatched head branch", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify(defaultMockPr({
          number: 81,
          headRefName: "unrelated-branch",
        })),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.readPr(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "ownership_refusal",
      });
    });

    it("fails closed with checks_unknown when branch protection GraphQL query fails (e.g. 403)", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && sub === "graphql") {
          throw new DeliveryError("GraphQL query failed: 403 Forbidden", {
            code: "cli_malformed_response",
          });
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when rulesets API returns HTTP 404", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: null,
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          throw new DeliveryError("gh: HTTP 404: Not Found (https://api.github.com/repos/org/repo/rules/branches/main)", {
            code: "cli_malformed_response",
            details: { httpStatus: 404 },
          });
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when GraphQL baseRef is missing branchProtectionRule", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {},
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({ number: 81 })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when GraphQL branchProtectionRule is empty object {}", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: {} },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({ number: 81 })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when GraphQL requiredStatusChecks has entry missing context", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusCheckContexts: [],
                        requiredStatusChecks: [{}],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({ number: 81 })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });

    it("fails closed with checks_unknown when REST ruleset has required_status_checks entry missing context", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusCheckContexts: [],
                        requiredStatusChecks: [],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return {
            stdout: JSON.stringify([
              {
                type: "required_status_checks",
                parameters: {
                  required_status_checks: [{}],
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({ number: 81 })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });
    });
  });

  describe("parseJsonStream", () => {
    it("rejects empty or whitespace-only stdout", () => {
      expect(() => parseJsonStream("")).toThrow("Empty response");
      expect(() => parseJsonStream("   \n\t  ")).toThrow("Empty response");
    });

    it("rejects trailing garbage after JSON array", () => {
      expect(() => parseJsonStream('[{"type":"required_signatures"}] trailing-garbage')).toThrow("Unexpected character");
    });

    it("rejects leading garbage before JSON array", () => {
      expect(() => parseJsonStream('leading-garbage [{"type":"required_signatures"}]')).toThrow("Unexpected character");
    });

    it("rejects non-array JSON chunk", () => {
      expect(() => parseJsonStream('{"type":"required_signatures"}')).toThrow("Expected JSON array");
    });

    it("successfully parses concatenated JSON arrays with whitespace", () => {
      const input = '[{"type":"a"}]\n\n[{"type":"b"}]';
      expect(parseJsonStream(input)).toEqual([{ type: "a" }, { type: "b" }]);
    });
  });

  describe("Required check source App constraints (SPEC §11.5 / Blockers)", () => {
    const makeRunnerForAppTest = (options: {
      requiredIntegrationId?: number | null;
      checkAppId?: number | null;
      checkConclusion?: string;
    }) => {
      let mergedCalled = false;
      let prState = "OPEN";
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return {
            stdout: JSON.stringify([defaultMockPr({ number: 81 })]),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              state: prState,
              mergedAt: prState === "MERGED" ? "2026-10-04T10:00:00Z" : null,
              mergeCommit: prState === "MERGED" ? { oid: "sha-merge-123" } : null,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: options.checkConclusion ?? "SUCCESS",
                  app: options.checkAppId !== null && options.checkAppId !== undefined ? { id: options.checkAppId } : null,
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: { branchProtectionRule: null },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return {
            stdout: JSON.stringify([
              {
                type: "required_status_checks",
                parameters: {
                  required_status_checks: [
                    {
                      context: "lint",
                      integration_id: options.requiredIntegrationId ?? null,
                    },
                  ],
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          prState = "MERGED";
          return {
            stdout: JSON.stringify({
              merged: true,
              sha: "sha-merge-123",
              message: "Merged successfully",
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      return { runner, getMergedCalled: () => mergedCalled };
    };

    it("正确来源成功：检查来自指定 App integration_id 且 SUCCESS 时，readChecks 允许合并且 landPr 发送 merge 请求", async () => {
      const { runner, getMergedCalled } = makeRunnerForAppTest({
        requiredIntegrationId: 123,
        checkAppId: 123,
        checkConclusion: "SUCCESS",
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });

      expect(report.canAutoMerge).toBe(true);
      expect(report.status).toBe("passed");
      expect(report.requiredChecks).toHaveLength(1);
      expect(report.requiredChecks[0]!.appId).toBe(123);
      expect(report.requiredChecks[0]!.isRequired).toBe(true);

      // landPr should proceed and call merge API
      const landResult = await service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate });
      expect(landResult.merged).toBe(true);
      expect(getMergedCalled()).toBe(true);
    });

    it("错误来源同名成功：配置要求 App 123，而仅 App 999 的同名检查成功时，readChecks 返回 pending 并阻止 landPr 合并", async () => {
      const { runner, getMergedCalled } = makeRunnerForAppTest({
        requiredIntegrationId: 123,
        checkAppId: 999, // wrong app!
        checkConclusion: "SUCCESS",
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });

      // Auto-merge must be REFUSED because App 123 is missing/pending
      expect(report.canAutoMerge).toBe(false);
      expect(report.status).toBe("pending");
      expect(report.reason).toContain("Required check(s) pending: lint");

      // landPr must throw checks_waiting and MUST NOT invoke merge API
      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_waiting",
      });
      expect(getMergedCalled()).toBe(false);
    });

    it("来源缺失：配置要求 App 123，而同名检查缺少 App 来源时，readChecks 返回 pending 并阻止 landPr 合并", async () => {
      const { runner, getMergedCalled } = makeRunnerForAppTest({
        requiredIntegrationId: 123,
        checkAppId: null, // missing source!
        checkConclusion: "SUCCESS",
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });

      expect(report.canAutoMerge).toBe(false);
      expect(report.status).toBe("pending");

      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_waiting",
      });
      expect(getMergedCalled()).toBe(false);
    });

    it("GraphQL branchProtectionRule 包含 App 约束时正确区分来源", async () => {
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusCheckContexts: [],
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            app: { databaseId: 456, id: "app-456", slug: "custom-builder" },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  checkSuite: { app: { databaseId: 456 } },
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });
      expect(report.canAutoMerge).toBe(true);
      expect(report.status).toBe("passed");
      expect(report.requiredChecks[0]!.appId).toBe(456);
    });

    it.each([null, { databaseId: 123 }])("GraphQL branchProtectionRule 明确 app: %j 时匹配成功检查并允许合并", async (app) => {
      let mergedCalled = false;
      let prState = "OPEN";
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return { stdout: JSON.stringify([defaultMockPr({ number: 81 })]), stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            app,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              state: prState,
              mergedAt: prState === "MERGED" ? "2026-10-04T10:00:00Z" : null,
              mergeCommit: prState === "MERGED" ? { oid: "sha-merge-123" } : null,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  ...(app === null ? {} : { checkSuite: { app } }),
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          prState = "MERGED";
          return {
            stdout: JSON.stringify({
              merged: true,
              sha: "sha-merge-123",
              message: "Merged successfully",
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });
      expect(report.canAutoMerge).toBe(true);
      expect(report.status).toBe("passed");
      expect(report.requiredChecks[0]!.appId).toBe(app?.databaseId ?? null);

      const landResult = await service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate });
      expect(landResult.merged).toBe(true);
      expect(mergedCalled).toBe(true);
    });

    it("GraphQL branchProtectionRule 缺失 app 字段时返回 checks_unknown 且阻止合并", async () => {
      let mergedCalled = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return { stdout: JSON.stringify([defaultMockPr({ number: 81 })]), stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            // app field is completely omitted!
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          return {
            stdout: JSON.stringify({ merged: true, sha: "sha-1", message: "Merged" }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });

      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_unknown",
      });
      expect(mergedCalled).toBe(false);
    });

    it.each([
      {},
      [],
      "invalid-app",
      { databaseId: 0 },
      { databaseId: -1 },
      { databaseId: 1.5 },
      { id: "0" },
      { id: "-1" },
      { id: "1.5" },
      { id: " ", slug: " " },
    ])("GraphQL branchProtectionRule 中无有效身份 app: %j 时返回 checks_unknown 且阻止合并", async (app) => {
      let mergedCalled = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return { stdout: JSON.stringify([defaultMockPr({ number: 81 })]), stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            app,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          return {
            stdout: JSON.stringify({ merged: true, sha: "sha-1", message: "Merged" }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });

      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_unknown",
      });
      expect(mergedCalled).toBe(false);
    });

    it("GraphQL branchProtectionRule 中 app: { databaseId: null, id: null } 时返回 checks_unknown 且阻止合并", async () => {
      let mergedCalled = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return { stdout: JSON.stringify([defaultMockPr({ number: 81 })]), stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            app: { databaseId: null, id: null, slug: "" },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          return {
            stdout: JSON.stringify({ merged: true, sha: "sha-1", message: "Merged" }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      await expect(service.readChecks(context, { prNumber: 81 })).rejects.toMatchObject({
        code: "checks_unknown",
      });

      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_unknown",
      });
      expect(mergedCalled).toBe(false);
    });

    it("真实 gh pr view 常见输出（CheckRun 缺失 app 字段）在要求特定 App 时保持 pending 并阻止合并", async () => {
      let mergedCalled = false;
      const runner = createMockRunner(async (args) => {
        const cmd = args[0];
        const sub = args[1];

        if (cmd === "pr" && sub === "list") {
          return { stdout: JSON.stringify([defaultMockPr({ number: 81 })]), stderr: "", exitCode: 0 };
        }

        if (cmd === "api" && sub === "graphql") {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRef: {
                      branchProtectionRule: {
                        requiredStatusChecks: [
                          {
                            context: "ci/build",
                            app: { databaseId: 123 },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/rules/branches/")) {
          return { stdout: "[]", stderr: "", exitCode: 0 };
        }

        // Standard gh pr view output from gh 2.45.0 (no app information in CheckRun)
        if (cmd === "pr" && sub === "view") {
          return {
            stdout: JSON.stringify(defaultMockPr({
              number: 81,
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "ci/build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  workflowName: "CI",
                  // Notice: no checkSuite.app or app field
                },
              ],
            })),
            stderr: "",
            exitCode: 0,
          };
        }

        if (cmd === "api" && typeof args[1] === "string" && args[1].includes("/merge")) {
          mergedCalled = true;
          return {
            stdout: JSON.stringify({ merged: true, sha: "sha-1", message: "Merged" }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${args.join(" ")}`);
      });

      const service = new GitHubDeliveryService(runner);
      const report = await service.readChecks(context, { prNumber: 81 });
      // Missing app on check run cannot satisfy App 123 requirement -> stays pending
      expect(report.canAutoMerge).toBe(false);
      expect(report.status).toBe("pending");
      expect(report.requiredChecks).toHaveLength(1);
      expect(report.requiredChecks[0]!.appId).toBe(123);
      expect(report.requiredChecks[0]!.state).toBe("PENDING");

      await expect(service.landPr(context, { optIn: true, prNumber: 81, reviewGate: approvedMockReviewGate })).rejects.toMatchObject({
        code: "checks_waiting",
      });
      expect(mergedCalled).toBe(false);
    });
  });

  describe("matchesAppConstraint & extractAppId unit tests", () => {
    it("extractAppId extracts from various GitHub API schema variants", () => {
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", integration_id: 123 })).toBe(123);
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", integrationId: 456 })).toBe(456);
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", app: { databaseId: 789 } })).toBe(789);
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", app: { id: "101" } })).toBe(101);
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", app: { slug: "my-app" } })).toBe("my-app");
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED", checkSuite: { app: { databaseId: 202 } } })).toBe(202);
      expect(extractAppId({ __typename: "StatusContext", context: "test", state: "SUCCESS", creator: { databaseId: 303 } })).toBe(303);
      expect(extractAppId({ __typename: "CheckRun", name: "test", status: "COMPLETED" })).toBeNull();
    });

    it("matchesAppConstraint behaves correctly with null, number, and string representations", () => {
      expect(matchesAppConstraint(123, null)).toBe(true);
      expect(matchesAppConstraint(null, null)).toBe(true);
      expect(matchesAppConstraint(null, 123)).toBe(false);
      expect(matchesAppConstraint(123, 123)).toBe(true);
      expect(matchesAppConstraint("123", 123)).toBe(true);
      expect(matchesAppConstraint(123, "123")).toBe(true);
      expect(matchesAppConstraint(999, 123)).toBe(false);
      expect(matchesAppConstraint("slug-a", "slug-a")).toBe(true);
      expect(matchesAppConstraint("slug-a", "slug-b")).toBe(false);
    });
  });
});
