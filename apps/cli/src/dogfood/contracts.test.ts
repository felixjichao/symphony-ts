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
    safetyRefusalCode: null,
    reuseVerified: false,
    mergeSha: null,
    ciRunMatched: false,
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
    const complete = { ownedPrState: "merged", issueClosed: true, checks: "success", linkedPrCount: 1, workspaceCleanupObserved: true, ciRunMatched: true } as const;
    expect(classifyDogfoodOutcome("happy", facts(complete)).status).toBe("passed");
    expect(classifyDogfoodOutcome("happy", facts({ ...complete, ownedPrState: "open" })).status).toBe("failed");
    expect(classifyDogfoodOutcome("happy", facts({ ...complete, linkedPrCount: 2 })).status).toBe("failed");
    // Terminal workspace cleanup is mandatory for happy (acceptance 5).
    expect(classifyDogfoodOutcome("happy", facts({ ...complete, workspaceCleanupObserved: false })).status).toBe("failed");
    // CI evidence must be tied to the delivered head SHA.
    expect(classifyDogfoodOutcome("happy", facts({ ...complete, ciRunMatched: false })).status).toBe("failed");
  });

  it("requires an observed repair and cleanup for the repair scenario", () => {
    const base = { ownedPrState: "merged", issueClosed: true, checks: "success", workspaceCleanupObserved: true, ciRunMatched: true } as const;
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: false })).status).toBe("failed");
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: true })).status).toBe("passed");
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: true, workspaceCleanupObserved: false })).status).toBe("failed");
    expect(classifyDogfoodOutcome("repair", facts({ ...base, repairObserved: true, ciRunMatched: false })).status).toBe("failed");
  });

  it("requires verified restart reuse of the same single PR", () => {
    expect(classifyDogfoodOutcome("reuse", facts({ ownedPrState: "merged", linkedPrCount: 1, reuseVerified: true })).status).toBe("passed");
    expect(classifyDogfoodOutcome("reuse", facts({ ownedPrState: "merged", linkedPrCount: 1, reuseVerified: false })).status).toBe("failed");
    expect(classifyDogfoodOutcome("reuse", facts({ ownedPrState: "merged", linkedPrCount: 2, reuseVerified: true })).status).toBe("failed");
  });

  it("passes foreign only on a real ownership refusal, not merely an unmerged PR", () => {
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: true, safetyRefusalCode: "ownership_refusal" })).status).toBe("passed");
    // The exact false positive the reviewer reproduced: a transport error leaves
    // the PR open but is NOT a safety refusal.
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: true, safetyRefusalCode: null })).status).toBe("failed");
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: false, safetyRefusalCode: "ownership_refusal" })).status).toBe("failed");
    expect(classifyDogfoodOutcome("foreign", facts({ foreignPrOpen: true, safetyRefusalCode: "ownership_refusal", ownedPrState: "merged", issueClosed: true })).status).toBe("failed");
  });

  it("passes conflict only on a real merge_rejected refusal with a verified conflict", () => {
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "open", safetyRefusalCode: "merge_rejected" })).status).toBe("passed");
    // merge_rejected is also returned for draft/UNKNOWN; without the verified
    // conflict fact it must not count.
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: false, ownedPrState: "open", safetyRefusalCode: "merge_rejected" })).status).toBe("failed");
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "open", safetyRefusalCode: null })).status).toBe("failed");
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "open", safetyRefusalCode: "timeout" })).status).toBe("failed");
    expect(classifyDogfoodOutcome("conflict", facts({ conflicting: true, ownedPrState: "merged", safetyRefusalCode: "merge_rejected" })).status).toBe("failed");
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
