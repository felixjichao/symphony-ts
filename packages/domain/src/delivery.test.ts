import { describe, expect, it } from "vitest";
import {
  evaluateChecksAutoMergePolicy,
  formatPrBody,
  parsePrOwnershipMarker,
  serializePrOwnershipMarker,
  validatePrOwnership,
  type DeliveryContext,
  type PrCheck,
  type PrOwnershipMarker,
} from "./delivery";

describe("delivery domain contracts", () => {
  const sampleContext: DeliveryContext = {
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

  it("serializes and parses PR ownership marker cleanly", () => {
    const serialized = serializePrOwnershipMarker(sampleMarker);
    expect(serialized).toContain("<!-- symphony-delivery-marker:");
    expect(serialized).toContain("-->");

    const parsed = parsePrOwnershipMarker(serialized);
    expect(parsed).toEqual(sampleMarker);
  });

  it("returns null for malformed or missing marker", () => {
    expect(parsePrOwnershipMarker("plain body text")).toBeNull();
    expect(parsePrOwnershipMarker("<!-- symphony-delivery-marker: not json -->")).toBeNull();
    expect(parsePrOwnershipMarker("<!-- symphony-delivery-marker: {\"schemaVersion\":2} -->")).toBeNull();
    expect(parsePrOwnershipMarker("<!-- symphony-delivery-marker: {\"schemaVersion\":1,\"repo\":\"abc\"} -->")).toBeNull();
  });

  it("formats PR body with closing issue reference and marker", () => {
    const formatted = formatPrBody({
      body: "Implement GitHub delivery capability",
      context: sampleContext,
    });
    expect(formatted).toContain("Implement GitHub delivery capability");
    expect(formatted).toContain("Fixes felixjichao/symphony-ts#81");
    expect(formatted).toContain("<!-- symphony-delivery-marker:");

    const validation = validatePrOwnership(formatted, sampleContext);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.marker.issueNumber).toBe(81);
      expect(validation.marker.workspaceKey).toBe("nest-92-c67d34d77de5");
    }
  });

  it("validates PR ownership and detects tampering or context mismatch", () => {
    const validBody = formatPrBody({ context: sampleContext });

    // Missing marker
    expect(validatePrOwnership("Fixes #81", sampleContext)).toEqual({
      valid: false,
      reason: "missing_or_malformed_symphony_marker",
    });

    // Mismatched issue
    expect(validatePrOwnership(validBody, { ...sampleContext, issueNumber: 99 })).toEqual({
      valid: false,
      reason: "issue_mismatch: expected 99, got 81",
    });

    // Mismatched repo
    expect(validatePrOwnership(validBody, { ...sampleContext, repo: "other/repo" })).toEqual({
      valid: false,
      reason: "repo_mismatch: expected other/repo, got felixjichao/symphony-ts",
    });

    // Mismatched workspaceKey
    expect(validatePrOwnership(validBody, { ...sampleContext, workspaceKey: "wrong-ws" })).toEqual({
      valid: false,
      reason: "workspace_key_mismatch: expected wrong-ws, got nest-92-c67d34d77de5",
    });

    // Mismatched headBranch
    expect(validatePrOwnership(validBody, { ...sampleContext, headBranch: "wrong-branch" })).toEqual({
      valid: false,
      reason: "head_branch_mismatch: expected wrong-branch, got symphony/nest-92-c67d34d77de5",
    });

    // Mismatched baseBranch
    expect(validatePrOwnership(validBody, { ...sampleContext, baseBranch: "dev" })).toEqual({
      valid: false,
      reason: "base_branch_mismatch: expected dev, got main",
    });

    // Marker present but closing issue reference stripped
    const markerOnly = serializePrOwnershipMarker(sampleMarker);
    expect(validatePrOwnership(markerOnly, sampleContext)).toEqual({
      valid: false,
      reason: "missing_issue_association_in_body: #81",
    });

    // Multiple conflicting markers
    const multipleMarkersBody = `${validBody}\n${serializePrOwnershipMarker({ ...sampleMarker, issueNumber: 99 })}`;
    expect(validatePrOwnership(multipleMarkersBody, sampleContext)).toEqual({
      valid: false,
      reason: "conflicting_multiple_markers_found",
    });

    // Loose issue reference or unrelated repo mention without closing keyword
    const looseMentionBody = `Mention other/repo#810\n${serializePrOwnershipMarker(sampleMarker)}`;
    expect(validatePrOwnership(looseMentionBody, sampleContext)).toEqual({
      valid: false,
      reason: "missing_issue_association_in_body: #81",
    });

    // Closing keyword with unrelated repo
    const foreignRepoBody = `Fixes other/repo#81\n${serializePrOwnershipMarker(sampleMarker)}`;
    expect(validatePrOwnership(foreignRepoBody, sampleContext)).toEqual({
      valid: false,
      reason: "missing_issue_association_in_body: #81",
    });

    // Exact closing keyword with matching full repo slug
    const matchingRepoSlugBody = `Fixes felixjichao/symphony-ts#81\n${serializePrOwnershipMarker(sampleMarker)}`;
    expect(validatePrOwnership(matchingRepoSlugBody, sampleContext)).toEqual({
      valid: true,
      marker: sampleMarker,
    });
  });

  describe("evaluateChecksAutoMergePolicy (user-approved CI policy)", () => {
    const successCheck = (name: string, isRequired = false): PrCheck => ({
      name,
      state: "COMPLETED",
      conclusion: "SUCCESS",
      isRequired,
    });

    const failedCheck = (name: string, isRequired = false): PrCheck => ({
      name,
      state: "COMPLETED",
      conclusion: "FAILURE",
      isRequired,
    });

    const pendingCheck = (name: string, isRequired = false): PrCheck => ({
      name,
      state: "PENDING",
      conclusion: null,
      isRequired,
    });

    const skippedCheck = (name: string, isRequired = false): PrCheck => ({
      name,
      state: "COMPLETED",
      conclusion: "SKIPPED",
      isRequired,
    });

    describe("with required checks configured", () => {
      it("passes auto-merge when all required and current checks succeed", () => {
        const required = [successCheck("ci/lint", true), successCheck("ci/test", true)];
        const current = [...required, successCheck("ci/docs")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(true);
        expect(result.status).toBe("passed");
        expect(result.failedOrPendingChecks).toHaveLength(0);
      });

      it("refuses auto-merge when a required check is pending", () => {
        const required = [successCheck("ci/lint", true), pendingCheck("ci/test", true)];
        const current = [...required];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("pending");
        expect(result.reason).toContain("ci/test");
        expect(result.failedOrPendingChecks).toHaveLength(1);
      });

      it("refuses auto-merge when a required check fails", () => {
        const required = [successCheck("ci/lint", true), failedCheck("ci/test", true)];
        const current = [...required];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("failing");
        expect(result.reason).toContain("ci/test");
      });

      it("refuses auto-merge when a non-required current check fails", () => {
        const required = [successCheck("ci/test", true)];
        const current = [...required, failedCheck("optional-lint")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("failing");
        expect(result.reason).toContain("optional-lint");
      });

      it("refuses auto-merge when a non-required current check is pending", () => {
        const required = [successCheck("ci/test", true)];
        const current = [...required, pendingCheck("optional-lint")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("pending");
      });
    });

    describe("without required checks (fallback mode)", () => {
      it("passes auto-merge when at least one current check exists and all succeed", () => {
        const required: readonly PrCheck[] = [];
        const current = [successCheck("gate")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(true);
        expect(result.status).toBe("passed");
      });

      it("refuses auto-merge when zero checks exist", () => {
        const required: readonly PrCheck[] = [];
        const current: readonly PrCheck[] = [];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("none");
        expect(result.reason).toContain("No checks found");
      });

      it("refuses auto-merge when any check is pending", () => {
        const required: readonly PrCheck[] = [];
        const current = [successCheck("gate"), pendingCheck("audit")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("pending");
      });

      it("refuses auto-merge when any check is skipped, neutral, or non-success", () => {
        const required: readonly PrCheck[] = [];
        const current = [successCheck("gate"), skippedCheck("deploy-preview")];

        const result = evaluateChecksAutoMergePolicy(required, current);
        expect(result.canAutoMerge).toBe(false);
        expect(result.status).toBe("failing");
        expect(result.reason).toContain("deploy-preview");
      });
    });
  });
});
