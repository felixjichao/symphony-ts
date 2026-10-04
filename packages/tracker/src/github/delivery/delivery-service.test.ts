import { describe, expect, it, vi } from "vitest";
import {
  formatPrBody,
  type DeliveryContext,
  type PrOwnershipMarker,
  DeliveryError,
} from "@symphony/domain";
import { GitHubDeliveryService, parseJsonStream } from "./delivery-service";
import type { GhExecOptions, GhExecResult, GhRunner } from "./gh-cli";

describe("GitHubDeliveryService", () => {
  const context: DeliveryContext = {
    repo: "felixjichao/symphony-ts",
    issueNumber: 81,
    workspaceKey: "nest-92-c67d34d77de5",
    headBranch: "symphony/nest-92-c67d34d77de5",
    baseBranch: "main",
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
        await service.landPr(context, { optIn: true });
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as DeliveryError).code).toBe("merge_rejected");
      }
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
      const result = await service.landPr(context, { optIn: true, prNumber: 81 });

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
      await expect(service.landPr(context, { optIn: true, prNumber: 81 })).rejects.toMatchObject({
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
});
