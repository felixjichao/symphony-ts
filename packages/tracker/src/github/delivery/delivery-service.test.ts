import { describe, expect, it, vi } from "vitest";
import {
  formatPrBody,
  type DeliveryContext,
  type PrOwnershipMarker,
  DeliveryError,
} from "@symphony/domain";
import { GitHubDeliveryService } from "./delivery-service";
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
              {
                number: 101,
                title: "PR Title",
                body: validBody,
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                headRefName: context.headBranch,
                headRefOid: "sha101",
                baseRefName: context.baseBranch,
                url: "https://github.com/felixjichao/symphony-ts/pull/101",
                mergedAt: null,
                mergeCommit: null,
              },
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
              {
                number: 99,
                title: "Existing PR",
                body: validBody,
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                headRefName: context.headBranch,
                headRefOid: "sha99",
                baseRefName: context.baseBranch,
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
                mergedAt: null,
                mergeCommit: null,
              },
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
              {
                number: 99,
                title: "Foreign PR",
                body: "Hand-crafted PR without marker Fixes #81",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                headRefName: context.headBranch,
                headRefOid: "sha99",
                baseRefName: context.baseBranch,
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              },
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
              {
                number: 99,
                title: "PR on dev",
                body: validBody,
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                headRefName: context.headBranch,
                headRefOid: "sha99",
                baseRefName: "development",
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
              },
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
              {
                number: 99,
                title: "Closed PR",
                body: validBody,
                state: "CLOSED",
                isDraft: false,
                mergeable: "MERGEABLE",
                headRefName: context.headBranch,
                headRefOid: "sha99",
                baseRefName: context.baseBranch,
                url: "https://github.com/felixjichao/symphony-ts/pull/99",
                mergedAt: null,
                mergeCommit: null,
              },
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
              { number: 98, headRefName: context.headBranch, baseRefName: context.baseBranch },
              { number: 99, headRefName: context.headBranch, baseRefName: context.baseBranch },
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
            stdout: JSON.stringify({
              number: 84,
              title: "PR 84",
              body: validBody,
              state: "MERGED",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefName: context.headBranch,
              headRefOid: "sha84",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/84",
              mergedAt: "2026-10-04T09:00:00Z",
              mergeCommit: { oid: "commit84" },
            }),
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
            stdout: JSON.stringify({
              number: 81,
              title: "PR 81",
              body: validBody,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefName: context.headBranch,
              headRefOid: "sha81",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/81",
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
            }),
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
            stdout: JSON.stringify({
              number: 81,
              title: "PR 81",
              body: validBody,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefName: context.headBranch,
              headRefOid: "sha81",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/81",
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
            }),
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
        stdout: JSON.stringify({
          number: 81,
          title: "PR 81",
          body: validBody,
          state: "OPEN",
          headRefName: context.headBranch,
          headRefOid: "freshHeadSha",
          baseRefName: context.baseBranch,
          url: "https://github.com/felixjichao/symphony-ts/pull/81",
        }),
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
            stdout: JSON.stringify({
              number: 81,
              title: "PR 81",
              body: validBody,
              state: "OPEN",
              isDraft: false,
              mergeable: "CONFLICTING",
              headRefName: context.headBranch,
              headRefOid: "sha81",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/81",
            }),
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
            stdout: JSON.stringify({
              number: 81,
              title: "PR 81",
              body: validBody,
              state: mergedState ? "MERGED" : "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefName: context.headBranch,
              headRefOid: "sha81",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/81",
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
            }),
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
        stdout: JSON.stringify({
          number: 81,
          title: "PR 81",
          body: validBody,
          state: "MERGED",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: context.headBranch,
          headRefOid: "sha81",
          baseRefName: context.baseBranch,
          url: "https://github.com/felixjichao/symphony-ts/pull/81",
          mergedAt: "2026-10-04T09:10:00Z",
          mergeCommit: { oid: "squashcommit81" },
        }),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      const result = await service.verifyMerged(context, { prNumber: 81 });

      expect(result.merged).toBe(true);
      expect(result.mergeCommitSha).toBe("squashcommit81");
    });

    it("throws verification_unknown when merged PR lacks mergeCommitSha or mergedAt", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify({
          number: 81,
          title: "PR 81",
          body: validBody,
          state: "MERGED",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: context.headBranch,
          headRefOid: "sha81",
          baseRefName: context.baseBranch,
          url: "https://github.com/felixjichao/symphony-ts/pull/81",
          mergedAt: null,
          mergeCommit: null,
        }),
        stderr: "",
        exitCode: 0,
      }));

      const service = new GitHubDeliveryService(runner);
      await expect(service.landPr(context, { optIn: true, prNumber: 81 })).rejects.toMatchObject({
        code: "verification_unknown",
      });
    });
  });

  describe("security boundaries and regression guards", () => {
    it("refuses PR from a cross-repository fork", async () => {
      const runner = createMockRunner(async () => ({
        stdout: JSON.stringify({
          number: 81,
          title: "PR 81",
          body: validBody,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: context.headBranch,
          headRefOid: "sha81",
          baseRefName: context.baseBranch,
          url: "https://github.com/felixjichao/symphony-ts/pull/81",
          isCrossRepository: true,
        }),
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
        stdout: JSON.stringify({
          number: 81,
          title: "PR 81",
          body: validBody,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: "unrelated-branch",
          headRefOid: "sha81",
          baseRefName: context.baseBranch,
          url: "https://github.com/felixjichao/symphony-ts/pull/81",
          isCrossRepository: false,
        }),
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
            stdout: JSON.stringify({
              number: 81,
              title: "PR 81",
              body: validBody,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              headRefName: context.headBranch,
              headRefOid: "sha81",
              baseRefName: context.baseBranch,
              url: "https://github.com/felixjichao/symphony-ts/pull/81",
              statusCheckRollup: [
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
              ],
            }),
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
  });
});
