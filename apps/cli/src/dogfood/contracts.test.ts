import { describe, expect, it } from "vitest";

import { sanitizeCredentials } from "@symphony/agent";

import {
  AUTHORIZED_TARGET_REPOSITORY,
  PRODUCT_REPOSITORY,
  buildEvidenceManifest,
  classifyDogfoodOutcome,
  decideDogfoodGate,
  parseDogfoodArgs,
  scenarioNeedsHost,
  serializeEvidence,
  validateDogfoodTarget,
  type DogfoodFacts,
} from "./contracts";

function facts(overrides: Partial<DogfoodFacts> = {}): DogfoodFacts {
  return {
    issueClosed: false,
    ownedPrState: "none",
    linkedPrCount: 0,
    checks: "unknown",
    mergeable: false,
    repairObserved: false,
    foreignPrOpen: false,
    conflicting: false,
    workspaceCleanupObserved: false,
    ...overrides,
  };
}

describe("parseDogfoodArgs", () => {
  it("defaults to the happy scenario, 1800s timeout and no opt-in", () => {
    const args = parseDogfoodArgs(["github"]);
    expect(args.scenario).toBe("happy");
    expect(args.timeoutSeconds).toBe(1800);
    expect(args.yes).toBe(false);
    expect(args.hostBinary).toBe("symphony");
    expect(args.target).toBeUndefined();
  });

  it("parses an explicit scenario, target and opt-in", () => {
    const args = parseDogfoodArgs(["github", "--scenario", "repair", "--target", "o/r", "--yes", "--timeout", "60", "--json"]);
    expect(args.scenario).toBe("repair");
    expect(args.target).toBe("o/r");
    expect(args.yes).toBe(true);
    expect(args.timeoutSeconds).toBe(60);
    expect(args.json).toBe(true);
  });

  it("rejects an unknown scenario and unknown flags", () => {
    expect(() => parseDogfoodArgs(["--scenario", "nope"])).toThrow(/Invalid value for --scenario/);
    expect(() => parseDogfoodArgs(["--bogus"])).toThrow(/Unknown dogfood argument/);
    expect(() => parseDogfoodArgs(["--timeout", "0"])).toThrow(/positive integer/);
  });
});

describe("validateDogfoodTarget", () => {
  it("accepts the explicitly authorized isolated target", () => {
    const decision = validateDogfoodTarget(AUTHORIZED_TARGET_REPOSITORY);
    expect(decision).toEqual({ ok: true, repo: AUTHORIZED_TARGET_REPOSITORY });
  });

  it("refuses the product repository", () => {
    const decision = validateDogfoodTarget(PRODUCT_REPOSITORY);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("forbidden_product_repo");
  });

  it("refuses a missing, malformed or unauthorized target", () => {
    expect(validateDogfoodTarget(undefined)).toMatchObject({ ok: false, reason: "missing_target" });
    expect(validateDogfoodTarget("not-a-slug")).toMatchObject({ ok: false, reason: "malformed_target" });
    expect(validateDogfoodTarget("someone/production")).toMatchObject({ ok: false, reason: "unauthorized_target" });
  });
});

describe("decideDogfoodGate", () => {
  it("skips without explicit opt-in, even for a valid target", () => {
    const gate = decideDogfoodGate(parseDogfoodArgs(["--target", AUTHORIZED_TARGET_REPOSITORY]));
    expect(gate.kind).toBe("skip");
    if (gate.kind === "skip") expect(gate.reason).toBe("explicit_opt_in_required");
  });

  it("errors when opt-in is given but the target is forbidden", () => {
    const gate = decideDogfoodGate(parseDogfoodArgs(["--yes", "--target", PRODUCT_REPOSITORY]));
    expect(gate.kind).toBe("error");
    if (gate.kind === "error") expect(gate.reason).toBe("forbidden_product_repo");
  });

  it("runs only with opt-in and the authorized target", () => {
    const gate = decideDogfoodGate(parseDogfoodArgs(["--yes", "--target", AUTHORIZED_TARGET_REPOSITORY]));
    expect(gate).toEqual({ kind: "run", repo: AUTHORIZED_TARGET_REPOSITORY });
  });
});

describe("classifyDogfoodOutcome", () => {
  it("passes a complete happy path and fails an incomplete one", () => {
    expect(classifyDogfoodOutcome("happy", facts({ ownedPrState: "merged", issueClosed: true, checks: "success", linkedPrCount: 1 })).status).toBe("passed");
    expect(classifyDogfoodOutcome("happy", facts({ ownedPrState: "open", issueClosed: true, checks: "success", linkedPrCount: 1 })).status).toBe("failed");
    expect(classifyDogfoodOutcome("happy", facts({ ownedPrState: "merged", issueClosed: true, checks: "success", linkedPrCount: 2 })).status).toBe("failed");
  });

  it("requires an observed repair for the repair scenario", () => {
    const base = { ownedPrState: "merged", issueClosed: true, checks: "success" } as const;
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: false })).status).toBe("failed");
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: true })).status).toBe("passed");
  });

  it("requires a single PR for reuse", () => {
    expect(classifyDogfoodOutcome("reuse", facts({ linkedPrCount: 1, ownedPrState: "merged" })).status).toBe("passed");
    expect(classifyDogfoodOutcome("reuse", facts({ linkedPrCount: 2, ownedPrState: "merged" })).status).toBe("failed");
  });

  it("requires the foreign PR to stay open and unmerged", () => {
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: true, ownedPrState: "none" })).status).toBe("passed");
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: false })).status).toBe("failed");
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: true, ownedPrState: "merged", issueClosed: true })).status).toBe("failed");
  });

  it("requires the conflicting PR to stay unmerged", () => {
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "open" })).status).toBe("passed");
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "merged" })).status).toBe("failed");
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: false, ownedPrState: "open" })).status).toBe("failed");
  });
});

describe("evidence", () => {
  it("redacts credential material from the serialized manifest", () => {
    const manifest = buildEvidenceManifest({
      runId: "run-1",
      scenario: "happy",
      target: AUTHORIZED_TARGET_REPOSITORY,
      startedAtMs: 0,
      finishedAtMs: 1000,
      status: "passed",
      reason: "ok",
      facts: facts({ ownedPrState: "merged", issueClosed: true, checks: "success", linkedPrCount: 1 }),
      artifacts: { "log.txt": "log.txt" },
    });
    const withSecret = { ...manifest, reason: "token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789AB" };
    const serialized = serializeEvidence(withSecret, sanitizeCredentials);
    expect(serialized).not.toContain("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(serialized).toContain("***REDACTED_TOKEN***");
    expect(manifest.startedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(manifest.finishedAt).toBe("1970-01-01T00:00:01.000Z");
  });
});

describe("scenarioNeedsHost", () => {
  it("separates host-driven from CLI-driven scenarios", () => {
    expect(scenarioNeedsHost("happy")).toBe(true);
    expect(scenarioNeedsHost("repair")).toBe(true);
    expect(scenarioNeedsHost("reuse")).toBe(true);
    expect(scenarioNeedsHost("foreign")).toBe(false);
    expect(scenarioNeedsHost("conflict")).toBe(false);
  });
});
