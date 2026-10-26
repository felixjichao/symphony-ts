# Agent Note: Separate evidence failure from code review verdicts
Status: accepted

## Problem

Decision extension (§4, §17/§18): `changes_requested` enters code repair, requiring a
mutation and spending repair budget. Missing review evidence is not a code defect.
Generic `execution_failed` deliberately lacks a safe continuity classification.

## Decision

Keep Plan and Review verdict policies separate. Add the shared executor error
`evidence_unavailable`, classified as recoverable/retry. ChatGPT Web recognizes a
strict task-bound failure envelope in its final `symphony-result` block, including
exact target for Review. It raises that adapter error rather than a DecisionResult;
the existing controller submits a lease-fenced failure receipt. The delivery runner
stops via its existing failed-task handoff without code repair. After evidence/access
is restored, a fresh review revision may evaluate the same HEAD.

## Alternatives considered

Using `changes_requested` would waste repairs and demand unrelated code changes.
Using `needs_human` would misrepresent an operational failure as a product decision.
Blindly classifying all generic executor errors as retryable would weaken continuity
safety. Automatic retries/new review orchestration are outside this policy fix.

## Consequences

The Bridge result schema and SHA/CI/ownership/merge gates are unchanged. The Web
failure response is adapter-local; the domain remains the sole error-code authority.
The legacy delivery reason `manual_intervention_required` remains an operational
handoff, not a product verdict. Retryability is classification, not a promise of
automatic retries. Fixture acceptance covers failure admission and fresh review;
real-browser automatic landing still needs separate acceptance.
