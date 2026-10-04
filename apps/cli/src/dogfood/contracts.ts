/**
 * GitHub delivery dogfood harness — pure contracts (SPEC §17.8 Real Integration,
 * NEST-94 / #83).
 *
 * This module deliberately contains no process spawning or network access: it is
 * the credential-free, fixture-testable surface that the default gate validates.
 * Argument parsing, opt-in gating, target safety, scenario outcome classification
 * and evidence redaction all live here so they can be unit tested without any
 * external credential or GitHub mutation.
 */

/** Scenarios the harness can drive. */
export const DOGFOOD_SCENARIOS = ["happy", "repair", "reuse", "foreign", "conflict"] as const;
export type DogfoodScenario = (typeof DOGFOOD_SCENARIOS)[number];

/** The product repository must never be used as a dogfood target. */
export const PRODUCT_REPOSITORY = "felixjichao/symphony-ts";

/** Default, explicitly authorized isolated dogfood target (NEST-94 user decision). */
export const AUTHORIZED_TARGET_REPOSITORY = "felixjichao/symphony-delivery-dogfood";

/** Dispatch label the reference profile uses. */
export const DOGFOOD_READY_LABEL = "symphony-ready";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface DogfoodArgs {
  readonly scenario: DogfoodScenario;
  readonly target?: string | undefined;
  readonly templatePath: string;
  readonly workflowPath?: string | undefined;
  readonly hostBinary: string;
  readonly evidenceDir: string;
  readonly runId?: string | undefined;
  readonly timeoutSeconds: number;
  readonly yes: boolean;
  readonly keep: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export const DEFAULT_TEMPLATE_PATH = "examples/github-delivery-dogfood";
export const DEFAULT_EVIDENCE_DIR = "dogfood-artifacts";

function parsePositiveInteger(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid value for ${flag}: '${raw}' must be a positive integer`);
  }
  return n;
}

function parseScenario(raw: string): DogfoodScenario {
  const found = DOGFOOD_SCENARIOS.find((s) => s === raw);
  if (found === undefined) {
    throw new Error(`Invalid value for --scenario: '${raw}' (expected one of ${DOGFOOD_SCENARIOS.join(", ")})`);
  }
  return found;
}

/** Parse `symphony dogfood github [flags]` arguments. Throws on invalid input. */
export function parseDogfoodArgs(argv: readonly string[]): DogfoodArgs {
  let i = 0;
  if (argv[i] === "github") {
    i += 1;
  }
  let scenario: DogfoodScenario = "happy";
  let target: string | undefined;
  let templatePath = DEFAULT_TEMPLATE_PATH;
  let workflowPath: string | undefined;
  let hostBinary = "symphony";
  let evidenceDir = DEFAULT_EVIDENCE_DIR;
  let runId: string | undefined;
  let timeoutSeconds = 1800;
  let yes = false;
  let keep = false;
  let json = false;
  let help = false;

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scenario" && i + 1 < argv.length) {
      scenario = parseScenario(argv[++i]!);
    } else if (arg === "--target" && i + 1 < argv.length) {
      target = argv[++i];
    } else if (arg === "--template" && i + 1 < argv.length) {
      templatePath = argv[++i]!;
    } else if (arg === "--workflow" && i + 1 < argv.length) {
      workflowPath = argv[++i];
    } else if (arg === "--host" && i + 1 < argv.length) {
      hostBinary = argv[++i]!;
    } else if (arg === "--evidence-dir" && i + 1 < argv.length) {
      evidenceDir = argv[++i]!;
    } else if (arg === "--run-id" && i + 1 < argv.length) {
      runId = argv[++i];
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      timeoutSeconds = parsePositiveInteger(argv[++i]!, "--timeout");
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown dogfood argument: '${arg}'`);
    }
  }

  return {
    scenario,
    ...(target !== undefined ? { target } : {}),
    templatePath,
    ...(workflowPath !== undefined ? { workflowPath } : {}),
    hostBinary,
    evidenceDir,
    ...(runId !== undefined ? { runId } : {}),
    timeoutSeconds,
    yes,
    keep,
    json,
    help,
  };
}

export type TargetDecision =
  | { readonly ok: true; readonly repo: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

/**
 * Validate a dogfood target. The product repository, malformed values and the
 * implicit/empty target are all rejected. A target other than the authorized
 * isolated repository is only accepted when it looks like a dedicated dogfood
 * repository, so accidental production targets never enter the loop.
 */
export function validateDogfoodTarget(
  target: string | undefined,
  authorizedTarget: string = AUTHORIZED_TARGET_REPOSITORY,
): TargetDecision {
  const value = (target ?? "").trim();
  if (value === "") {
    return { ok: false, reason: "missing_target", message: "a dogfood --target <owner/repo> is required" };
  }
  if (!REPO_RE.test(value)) {
    return { ok: false, reason: "malformed_target", message: `'${value}' is not a valid owner/repo slug` };
  }
  if (value.toLowerCase() === PRODUCT_REPOSITORY.toLowerCase()) {
    return {
      ok: false,
      reason: "forbidden_product_repo",
      message: `refusing to dogfood against the product repository '${PRODUCT_REPOSITORY}'`,
    };
  }
  if (value.toLowerCase() !== authorizedTarget.toLowerCase()) {
    return {
      ok: false,
      reason: "unauthorized_target",
      message: `target '${value}' is not the authorized isolated dogfood repository '${authorizedTarget}'`,
    };
  }
  return { ok: true, repo: value };
}

export type DogfoodGate =
  | { readonly kind: "skip"; readonly reason: string; readonly message: string }
  | { readonly kind: "error"; readonly reason: string; readonly message: string }
  | { readonly kind: "run"; readonly repo: string };

/**
 * Decide whether a run may start. Without explicit opt-in the harness always
 * reports SKIP (never a pass). A forbidden/invalid target is a hard error.
 */
export function decideDogfoodGate(args: DogfoodArgs): DogfoodGate {
  if (!args.yes) {
    return {
      kind: "skip",
      reason: "explicit_opt_in_required",
      message: "dogfood is opt-in; pass --yes to authorize real GitHub/Codex mutation",
    };
  }
  const target = validateDogfoodTarget(args.target);
  if (!target.ok) {
    if (target.reason === "missing_target") {
      return { kind: "error", reason: target.reason, message: target.message };
    }
    return { kind: "error", reason: target.reason, message: target.message };
  }
  return { kind: "run", repo: target.repo };
}

export type CheckConclusion = "pending" | "success" | "failure" | "unknown";
export type PrState = "none" | "open" | "merged" | "closed";

/** `symphony pr land` refusal codes that count as a genuine safety refusal. */
export const FOREIGN_REFUSAL_CODE = "ownership_refusal";
/**
 * `GitHubDeliveryService.landPr()` rejects a conflicting PR with the real
 * `merge_rejected` code (it also uses the same code for draft/UNKNOWN, so the
 * conflict scenario must additionally verify the PR is actually `CONFLICTING`).
 */
export const CONFLICT_REFUSAL_CODE = "merge_rejected";

export interface DogfoodFacts {
  /** Issue was closed by the merge (terminal state observed after landing). */
  readonly issueClosed: boolean;
  /** Primary (owned) PR state for the issue branch, if any. */
  readonly ownedPrState: PrState;
  /** Number of all-state PRs associated with the issue/branch. */
  readonly linkedPrCount: number;
  /** Required + observed checks on the current head. */
  readonly checks: CheckConclusion;
  /** Whether the owned PR was mergeable at evaluation time. */
  readonly mergeable: boolean;
  /** At least one failing CI run was observed before a green run (repair path). */
  readonly repairObserved: boolean;
  /** A foreign/non-Symphony PR for the same base exists and must stay untouched. */
  readonly foreignPrOpen: boolean;
  /** The owned PR conflicts with base and must not be merged. */
  readonly conflicting: boolean;
  /**
   * Symphony logged a terminal `workspace_cleanup` completion associated with
   * this issue, and the issue workspace directory was observed, then removed,
   * while the workspace root sentinel survived.
   */
  readonly workspaceCleanupObserved: boolean;
  /**
   * Structured error code returned by the real `symphony pr land` entry for the
   * safety scenarios (null when land unexpectedly succeeded or failed for a
   * transport/other reason). Only the specific refusal code counts as safe.
   */
  readonly safetyRefusalCode: string | null;
  /**
   * The restart-reuse flow proved a bounded pre-merge window, reused the same PR
   * after restart, persisted delivery state, and completed without timing out.
   */
  readonly reuseVerified: boolean;
  /** Real squash-merge commit SHA read back after landing. */
  readonly mergeSha: string | null;
  /**
   * A recorded GitHub Actions run matches the merged PR head SHA with a
   * successful conclusion (ties the CI evidence to the exact delivered head).
   */
  readonly ciRunMatched: boolean;
}

export type DogfoodVerdict =
  | { readonly status: "passed"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

function verdict(ok: boolean, passReason: string, failReason: string): DogfoodVerdict {
  return ok ? { status: "passed", reason: passReason } : { status: "failed", reason: failReason };
}

/**
 * Classify a scenario outcome from observed GitHub/Symphony facts. This mirrors
 * the acceptance criteria one-to-one and is intentionally strict: any missing or
 * ambiguous fact fails closed.
 */
export function classifyDogfoodOutcome(scenario: DogfoodScenario, facts: DogfoodFacts): DogfoodVerdict {
  switch (scenario) {
    case "happy":
      return verdict(
        facts.ownedPrState === "merged" && facts.issueClosed && facts.checks === "success" &&
          facts.linkedPrCount === 1 && facts.workspaceCleanupObserved && facts.ciRunMatched,
        "issue closed by a single merged PR with green checks tied to the head SHA and terminal workspace cleanup",
        `happy path incomplete (pr=${facts.ownedPrState}, issueClosed=${facts.issueClosed}, checks=${facts.checks}, linkedPrs=${facts.linkedPrCount}, cleanup=${facts.workspaceCleanupObserved}, ciRunMatched=${facts.ciRunMatched})`,
      );
    case "repair":
      return verdict(
        facts.ownedPrState === "merged" && facts.issueClosed && facts.checks === "success" &&
          facts.repairObserved && facts.workspaceCleanupObserved && facts.ciRunMatched,
        "CI failure observed and repaired by a later green run tied to the head SHA, then merged and cleaned up",
        `repair path incomplete (repairObserved=${facts.repairObserved}, pr=${facts.ownedPrState}, checks=${facts.checks}, cleanup=${facts.workspaceCleanupObserved}, ciRunMatched=${facts.ciRunMatched})`,
      );
    case "reuse":
      return verdict(
        facts.ownedPrState === "merged" && facts.linkedPrCount === 1 && facts.reuseVerified,
        "restart reused the same PR without creating a duplicate",
        `reuse not verified (pr=${facts.ownedPrState}, linkedPrs=${facts.linkedPrCount}, reuseVerified=${facts.reuseVerified})`,
      );
    case "foreign":
      return verdict(
        facts.foreignPrOpen && facts.ownedPrState !== "merged" && !facts.issueClosed &&
          facts.safetyRefusalCode === FOREIGN_REFUSAL_CODE,
        "real land entry refused the foreign PR with an ownership refusal and left it unmerged",
        `foreign PR safety not proven (foreignOpen=${facts.foreignPrOpen}, merged=${facts.ownedPrState === "merged"}, refusalCode=${facts.safetyRefusalCode ?? "none"})`,
      );
    case "conflict":
      return verdict(
        facts.conflicting && facts.ownedPrState !== "merged" && !facts.issueClosed &&
          facts.safetyRefusalCode === CONFLICT_REFUSAL_CODE,
        "real land entry refused the conflicting PR as unmergeable and left it unmerged",
        `conflict safety not proven (conflicting=${facts.conflicting}, merged=${facts.ownedPrState === "merged"}, refusalCode=${facts.safetyRefusalCode ?? "none"})`,
      );
  }
}

export interface DogfoodEvidence {
  readonly runId: string;
  readonly scenario: DogfoodScenario;
  readonly target: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly reason: string;
  readonly facts: DogfoodFacts | null;
  readonly artifacts: Readonly<Record<string, string>>;
}

/** Build the sanitized evidence manifest written outside the cleaned workspace. */
export function buildEvidenceManifest(input: {
  runId: string;
  scenario: DogfoodScenario;
  target: string;
  startedAtMs: number;
  finishedAtMs: number;
  status: "passed" | "failed" | "skipped";
  reason: string;
  facts: DogfoodFacts | null;
  artifacts: Readonly<Record<string, string>>;
}): DogfoodEvidence {
  return {
    runId: input.runId,
    scenario: input.scenario,
    target: input.target,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(input.finishedAtMs).toISOString(),
    status: input.status,
    reason: input.reason,
    facts: input.facts,
    artifacts: input.artifacts,
  };
}

/** Serialize an evidence manifest with all credential material redacted. */
export function serializeEvidence(evidence: DogfoodEvidence, redact: (text: string) => string): string {
  return redact(JSON.stringify(evidence, null, 2));
}

/** True when the scenario needs the real Symphony host (not just delivery CLI). */
export function scenarioNeedsHost(scenario: DogfoodScenario): boolean {
  return scenario === "happy" || scenario === "repair" || scenario === "reuse";
}
