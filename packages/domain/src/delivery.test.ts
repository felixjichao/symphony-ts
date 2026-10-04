import { describe, expect, it } from "vitest";

import {
  evaluateCiChecksPolicy,
  formatDeliveryHandoffMarkdown,
  formatPrBody,
  parsePrOwnershipMarker,
  serializePrOwnershipMarker,
  validatePrOwnership,
  type CiCheckItem,
  type DeliveryContext,
  type DeliveryHandoff,
  type PrOwnershipMarker,
} from "./delivery";

describe("Delivery Domain Contracts", () => {
  const sampleContext: DeliveryContext = {
    repo: "felixjichao/symphony-ts",
    issueNumber: 80,
    workspaceKey: "GH-80",
    headBranch: "symphony/GH-80",
    baseBranch: "main",
  };

  const sampleMarker: PrOwnershipMarker = {
    repo: "felixjichao/symphony-ts",
    issueNumber: 80,
    workspaceKey: "GH-80",
    headBranch: "symphony/GH-80",
    baseBranch: "main",
  };

  describe("PrOwnershipMarker", () => {
    it("serializes and parses ownership marker accurately", () => {
      const serialized = serializePrOwnershipMarker(sampleMarker);
      expect(serialized).toContain("<!-- symphony-delivery-marker:");
      expect(serialized).toContain("GH-80");

      const parsed = parsePrOwnershipMarker(serialized);
      expect(parsed).toEqual(sampleMarker);
    });

    it("returns null for malformed or missing marker", () => {
      expect(parsePrOwnershipMarker("plain body text")).toBeNull();
      expect(parsePrOwnershipMarker("<!-- symphony-delivery-marker: {not-json} -->")).toBeNull();
      expect(parsePrOwnershipMarker("<!-- symphony-delivery-marker: {\"repo\":123} -->")).toBeNull();
    });

    it("validates PR ownership against context", () => {
      expect(validatePrOwnership(sampleMarker, sampleContext)).toBe(true);
      expect(validatePrOwnership(null, sampleContext)).toBe(false);

      const mismatchedIssue: PrOwnershipMarker = { ...sampleMarker, issueNumber: 99 };
      expect(validatePrOwnership(mismatchedIssue, sampleContext)).toBe(false);

      const mismatchedRepo: PrOwnershipMarker = { ...sampleMarker, repo: "other/repo" };
      expect(validatePrOwnership(mismatchedRepo, sampleContext)).toBe(false);

      const mismatchedBranch: PrOwnershipMarker = { ...sampleMarker, headBranch: "symphony/other" };
      expect(validatePrOwnership(mismatchedBranch, sampleContext)).toBe(false);
    });
  });

  describe("formatPrBody", () => {
    it("prepends Fixes #N and appends marker", () => {
      const body = formatPrBody({
        description: "Implemented feature details",
        issueNumber: 80,
        repo: "felixjichao/symphony-ts",
        workspaceKey: "GH-80",
        headBranch: "symphony/GH-80",
        baseBranch: "main",
      });

      expect(body.startsWith("Fixes #80\n\nImplemented feature details")).toBe(true);
      expect(body).toContain("<!-- symphony-delivery-marker:");

      const parsed = parsePrOwnershipMarker(body);
      expect(parsed).toEqual(sampleMarker);
    });

    it("avoids duplicate Fixes #N if already present", () => {
      const body = formatPrBody({
        description: "Fixes #80 already in text",
        issueNumber: 80,
        repo: "felixjichao/symphony-ts",
        workspaceKey: "GH-80",
        headBranch: "symphony/GH-80",
        baseBranch: "main",
      });

      const matches = body.match(/Fixes #80/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe("evaluateCiChecksPolicy", () => {
    it("rejects when zero checks are observed", () => {
      const res = evaluateCiChecksPolicy([]);
      expect(res.canLand).toBe(false);
      expect(res.reason).toBe("zero_checks_observed");
    });

    it("rejects when failing checks exist", () => {
      const checks: CiCheckItem[] = [
        { name: "lint", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
        { name: "test", status: "failure", conclusion: "failure", detailsUrl: "https://ci/test", isRequired: true },
      ];
      const res = evaluateCiChecksPolicy(checks);
      expect(res.canLand).toBe(false);
      expect(res.reason).toContain("failing_checks_detected");
      expect(res.failedChecks).toHaveLength(1);
      expect(res.failedChecks[0]?.name).toBe("test");
    });

    it("rejects when pending checks exist", () => {
      const checks: CiCheckItem[] = [
        { name: "lint", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
        { name: "test", status: "pending", conclusion: null, detailsUrl: null, isRequired: false },
      ];
      const res = evaluateCiChecksPolicy(checks);
      expect(res.canLand).toBe(false);
      expect(res.reason).toContain("pending_checks_detected");
      expect(res.pendingChecks).toHaveLength(1);
    });

    it("approves when all observed checks succeed without explicit required checks", () => {
      const checks: CiCheckItem[] = [
        { name: "build", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
        { name: "test", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
      ];
      const res = evaluateCiChecksPolicy(checks);
      expect(res.canLand).toBe(true);
      expect(res.reason).toBe("all_observed_checks_succeeded");
    });

    it("approves when all required and observed checks succeed", () => {
      const checks: CiCheckItem[] = [
        { name: "build", status: "success", conclusion: "success", detailsUrl: null, isRequired: true },
        { name: "test", status: "success", conclusion: "success", detailsUrl: null, isRequired: true },
        { name: "doc", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
      ];
      const res = evaluateCiChecksPolicy(checks);
      expect(res.canLand).toBe(true);
      expect(res.reason).toBe("all_required_and_observed_checks_succeeded");
    });

    it("rejects when non-successful (neutral or skipped) checks are present", () => {
      const checks: CiCheckItem[] = [
        { name: "build", status: "success", conclusion: "success", detailsUrl: null, isRequired: true },
        { name: "optional-doc", status: "neutral", conclusion: "neutral", detailsUrl: null, isRequired: false },
      ];
      const res = evaluateCiChecksPolicy(checks);
      expect(res.canLand).toBe(false);
      expect(res.reason).toContain("non_successful_checks_present");
    });

    it("rejects when configured required check is missing", () => {
      const checks: CiCheckItem[] = [
        { name: "build", status: "success", conclusion: "success", detailsUrl: null, isRequired: false },
      ];
      const res = evaluateCiChecksPolicy(checks, { requiredChecks: ["gate"] });
      expect(res.canLand).toBe(false);
      expect(res.reason).toContain("missing_required_checks (gate)");
    });
  });

  describe("formatDeliveryHandoffMarkdown", () => {
    it("formats operator-visible handoff report with label removal notice", () => {
      const handoff: DeliveryHandoff = {
        reason: "ci_failed_max_repairs",
        details: "Test suite 'gate' failed on head commit abcdef1234",
        repo: "felixjichao/symphony-ts",
        issueNumber: 80,
        headBranch: "symphony/GH-80",
        prNumber: 85,
        prUrl: "https://github.com/felixjichao/symphony-ts/pull/85",
        headSha: "abcdef1234567890",
        spentRepairs: 3,
        maxRepairs: 3,
        spentWaitSeconds: 120,
        maxWaitSeconds: 600,
        readyLabel: "symphony-ready",
      };

      const markdown = formatDeliveryHandoffMarkdown(handoff);
      expect(markdown).toContain("Symphony Delivery Handoff Report");
      expect(markdown).toContain("ci_failed_max_repairs");
      expect(markdown).toContain("[#85](https://github.com/felixjichao/symphony-ts/pull/85)");
      expect(markdown).toContain("3 / 3 次上限");
      expect(markdown).toContain("移除 `symphony-ready` 标签");
      expect(markdown).toContain("已自动停止当前任务派发与 Continuation 循环");
      expect(markdown).toContain("重新添加 `symphony-ready` 标签以恢复 Symphony 自动调度");
    });
  });
});
