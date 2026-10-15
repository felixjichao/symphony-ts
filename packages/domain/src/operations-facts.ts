/**
 * Operational Read Model — provider-neutral normalized facts (NEST-113 / GitHub #109).
 *
 * Read-only observation contracts. A future reader turns GitHub / orchestrator runtime /
 * Decision Store / executor observations into these shapes; a future projector derives
 * operational meaning from them. Nothing in this file mutates GitHub, the Decision Plane,
 * the orchestrator, a workspace, or a filesystem, and no provider-specific API object,
 * persistence record, browser DOM node or executor session handle may leak into it.
 *
 * Provenance and observation timestamps are first-class so freshness and explainability
 * can be layered on later without re-reading raw sources.
 */
import type { UtcTimestampMs } from "./time";
import type {
  DecisionReviewTarget,
  DecisionSessionStatus,
  DecisionTaskStatus,
  DecisionWorkItemRef,
} from "./decision";
import type { RunAttemptStatus } from "./run";

/**
 * Stable work-item identity rooted in a GitHub Issue. This aliases the existing
 * provider-neutral work root {@link DecisionWorkItemRef}; GitHub values are canonical
 * `{ provider: "github", key: "owner/repo#N" }`. It is never derived from a pull
 * request, an executor session, a machine host, a workspace path or a conversation.
 */
export type WorkKey = DecisionWorkItemRef;

/**
 * Which class of source a fact came from. `executor` covers heartbeat / binding
 * observations; `runtime` covers the in-process orchestrator.
 */
export type OperationSourceKind = "github" | "runtime" | "decision" | "executor";

/**
 * Where a fact came from and when it was observed. `instance` identifies the source
 * instance (e.g. `github:owner/repo`); it is never a machine or host identity.
 */
export interface FactProvenance {
  readonly source: OperationSourceKind;
  readonly instance: string;
  readonly observedAt: UtcTimestampMs;
}

/**
 * GitHub work-item identity helpers. They reuse the canonical Decision root validation
 * so there is exactly one definition of a GitHub work key in the repository.
 */
export { githubDecisionRoot as githubWorkKey, validateRoot as parseWorkKey, decisionSessionId as formatWorkKey } from "./decision";

// ---------------------------------------------------------------------------
// Source freshness
// ---------------------------------------------------------------------------

/**
 * Freshness is part of the state semantics, not cosmetic metadata: `offline`, `stale`,
 * `unknown` and `unavailable` are deliberately distinct and MUST NOT be merged.
 */
export type SourceFreshnessStatus = "fresh" | "stale" | "unavailable" | "unknown";

/** A successful observation recent enough to be trusted. */
export interface FreshSourceFreshness {
  readonly status: "fresh";
  /** When the successful observation was made. */
  readonly observedAt: UtcTimestampMs;
  /** When the source was last attempted (>= observedAt). */
  readonly lastAttemptAt: UtcTimestampMs;
}

/**
 * A successful observation that is now older than the freshness bound. `observedAt`
 * still carries the real observation time; it MUST NOT be refreshed to "now".
 */
export interface StaleSourceFreshness {
  readonly status: "stale";
  readonly observedAt: UtcTimestampMs;
  readonly lastAttemptAt: UtcTimestampMs;
}

/**
 * The most recent read failed. `observedAt` retains the previous successful observation
 * time when one exists (`null` otherwise) so stale data is never disguised as fresh.
 */
export interface UnavailableSourceFreshness {
  readonly status: "unavailable";
  readonly observedAt: UtcTimestampMs | null;
  readonly lastAttemptAt: UtcTimestampMs;
  /** Stable machine-readable failure code, never a raw provider error. */
  readonly reason: string;
}

/** No usable observation has been made yet. */
export interface UnknownSourceFreshness {
  readonly status: "unknown";
  readonly lastAttemptAt: UtcTimestampMs | null;
  readonly reason: string | null;
}

export type SourceFreshness =
  | FreshSourceFreshness
  | StaleSourceFreshness
  | UnavailableSourceFreshness
  | UnknownSourceFreshness;

/** Per-source freshness reported in a system-level snapshot. */
export interface SourceStatus {
  readonly source: OperationSourceKind;
  readonly instance: string;
  readonly freshness: SourceFreshness;
  readonly workKey?: WorkKey | null | undefined;
}

// ---------------------------------------------------------------------------
// Normalized facts
// ---------------------------------------------------------------------------

export type GitHubIssueStateFacts = "open" | "closed";
export type GitHubPullRequestStateFacts = "open" | "closed" | "merged";
export type GitHubCiStatusFacts = "pending" | "success" | "failure";

export interface GitHubIssueFacts {
  readonly state: GitHubIssueStateFacts;
  readonly url: string;
}

export interface GitHubPullRequestFacts {
  readonly number: number;
  readonly state: GitHubPullRequestStateFacts;
  readonly url: string;
  /** Exact full lowercase 40-hex HEAD SHA observed for this pull request. */
  readonly headSha: string;
  readonly isDraft: boolean;
}

export interface GitHubCiFacts {
  readonly headSha?: string;
  readonly status: GitHubCiStatusFacts;
}

/**
 * Normalized facts for one GitHub-rooted work item.
 *
 * Absence is expressed as `null` on the nested field, which means "the read succeeded
 * and there is no such object". A failed read is expressed by the surrounding
 * {@link SourceFreshness}, never by a fabricated empty fact.
 */
export interface GitHubWorkFacts {
  readonly workKey: WorkKey;
  readonly issue: GitHubIssueFacts;
  /** `null` = read succeeded and this work item has no pull request. */
  readonly pullRequest: GitHubPullRequestFacts | null;
  /** `null` = no CI signal observed; never means "CI passed". */
  readonly ci: GitHubCiFacts | null;
  readonly provenance: FactProvenance;
}

export interface RuntimeAttemptFacts {
  readonly sessionId?: string | null;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly issueId: string;
  readonly issueIdentifier: string;
  /** First attempt is `null`; retries / continuations are `>= 1` (§4.1.5). */
  readonly attempt: number | null;
  readonly status: RunAttemptStatus;
  readonly workspacePath: string;
  readonly startedAtMs: UtcTimestampMs;
}

export interface RuntimeRetryFacts {
  readonly issueId: string;
  readonly identifier: string | null;
  readonly attempt: number;
  /** Already-computed remaining delay; never a monotonic due instant. */
  readonly retryInMs: number;
  readonly error: string | null;
}

/**
 * Normalized orchestrator runtime facts for one runtime record.
 *
 * `workKey` is a best-effort link to the durable work item. When the runtime record
 * cannot be reliably mapped, it stays `null` (unlinked observation) rather than
 * inventing a key.
 */
export interface RuntimeWorkFacts {
  readonly workKey: WorkKey | null;
  readonly issueId: string;
  readonly attempt: RuntimeAttemptFacts | null;
  readonly retry: RuntimeRetryFacts | null;
  readonly provenance: FactProvenance;
}

export interface DecisionSessionFacts {
  readonly sessionId: string;
  readonly status: DecisionSessionStatus;
  readonly bindingGeneration: number;
  /** Executor adapter kind when bound; `null` when unbound or broken. */
  readonly adapter: string | null;
  readonly updatedAtMs: UtcTimestampMs;
}

interface DecisionTaskFactsBase {
  /** Omitted means unsupported; null means observed absent. Never contains a token. */
  readonly lease?: { readonly owner: string; readonly generation: number; readonly expiresAtMs: UtcTimestampMs } | null;
  readonly claimGeneration?: number;
  readonly claimBindingGeneration?: number | null;
  readonly taskId: string;
  readonly revision: number;
  readonly status: DecisionTaskStatus;
  readonly createdAtMs: UtcTimestampMs;
  readonly updatedAtMs: UtcTimestampMs;
}

/** A plan task carries no review target. */
export interface DecisionPlanTaskFacts extends DecisionTaskFactsBase {
  readonly kind: "plan";
}

/**
 * A review task always carries its exact repository / PR / HEAD target. Modeling this
 * as a discriminated union (rather than `kind` plus a nullable target) makes
 * `kind: "review", target: null` unrepresentable, so a normalized review fact can never
 * lose the target a projector must preserve. The target MAY differ from the current HEAD;
 * cross-source mismatch is a fact to retain, not a shape to reject.
 */
export interface DecisionReviewTaskFacts extends DecisionTaskFactsBase {
  readonly kind: "review";
  readonly target: DecisionReviewTarget;
}

export type DecisionTaskFacts = DecisionPlanTaskFacts | DecisionReviewTaskFacts;

export interface DecisionPlanVerdictFacts {
  readonly kind: "plan";
  readonly verdict: "ready" | "needs_clarification" | "needs_human";
}

export interface DecisionReviewVerdictFacts {
  readonly kind: "review";
  readonly verdict: "approve" | "changes_requested" | "needs_human";
  /** Exact target the verdict was produced against; MAY differ from the current HEAD. */
  readonly target: DecisionReviewTarget;
}

export type DecisionVerdictFacts = DecisionPlanVerdictFacts | DecisionReviewVerdictFacts;

export interface DecisionResultFacts {
  readonly taskId: string;
  readonly revision: number;
  readonly createdAtMs: UtcTimestampMs;
  readonly outcome: DecisionVerdictFacts;
}

/**
 * Normalized Decision Plane facts for one work item. Multiple tasks / results are
 * retained so later anomaly detection can compare historical and current review
 * targets instead of collapsing them to `unknown`.
 */
export interface DecisionWorkFacts {
  readonly workKey: WorkKey;
  /** `null` = read succeeded and no session exists for this work item. */
  readonly session: DecisionSessionFacts | null;
  readonly tasks: readonly DecisionTaskFacts[];
  readonly results: readonly DecisionResultFacts[];
  readonly provenance: FactProvenance;
}

/** Runtime-reported executor state; `offline` is an observation, not a derivation. */
export type ExecutorStatusFacts = "online" | "busy" | "stale" | "offline" | "unknown";

export type ExecutorRole = "planner" | "implementer" | "reviewer";

export interface ExecutorFacts {
  readonly bindingGeneration?: number | null;
  readonly id: string;
  readonly role: ExecutorRole | null;
  readonly adapter: string;
  /** Host / machine topology is observation metadata only; never work identity. */
  readonly host: string | null;
  readonly status: ExecutorStatusFacts;
  readonly lastHeartbeatAtMs: UtcTimestampMs | null;
  readonly currentWorkKey: WorkKey | null;
  readonly provenance: FactProvenance;
}

/** A source bundle distinguishes successful absence from unknown/unavailable reads. */
export interface OperationSourceResult<T> extends SourceStatus {
  readonly facts: T | null;
}
export interface OperationFactCollection {
  readonly github: OperationSourceResult<GitHubWorkFacts>;
  readonly runtime: OperationSourceResult<readonly RuntimeWorkFacts[]>;
  readonly decision: OperationSourceResult<DecisionWorkFacts>;
  readonly executor: OperationSourceResult<readonly ExecutorFacts[]>;
}
export type DecisionObservation = Omit<DecisionWorkFacts, "provenance">;
export type GitHubObservation = Omit<GitHubWorkFacts, "provenance">;
