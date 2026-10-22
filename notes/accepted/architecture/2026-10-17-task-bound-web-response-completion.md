# Agent Note: Task-bound Web response completion under DOM windowing
Status: accepted

## Problem

The #137 Review revision 2 web page shows a completed response with a valid
symphony-result envelope and a displayed 42-second thinking duration, while the
Bridge recorded execution_failed after the 15-minute response wait. No historical
DOM trace survived, so the actual production cause is not proven. Deterministic
adapter tests reproduce the same symptom when old messages leave the DOM or a
persisted baseline exceeds the current message count. A separate fixture proves
that choosing only the first nonempty assistant selector hides modern messages
when a legacy message remains. This is a Decision Web executor extension adjacent
to SPEC §4 / §13, not a change to Core scheduler authority.

## Decision

Merge supported assistant selectors in DOM order, discarding nested duplicate
matches. Keep ordinary count/identity fencing for unstructured bootstrap replies.
For Plan/Review only, allow the latest result to qualify without count growth when
the canonical extractor validates the entire envelope against the exact task,
session, revision, target and timestamp/schema requirements. During a fresh send,
exclude matching results already present before sending from this fallback, even
after rerendering. A genuinely new count/identity-fenced response retains existing
behavior, including when a model repeats the same envelope.
The normal stop-button and text stabilization checks still apply. Checkpoint
recovery uses the exact task envelope, never an arbitrary JSON block or older
revision. The Bridge retains lease/generation/receipt authority.

Record bounded, per-tab local metadata for response waiting and result submission,
including current/baseline count, selector, candidate match and terminal reason.
Keep the last 50 entries across reload without retaining credentials, prompt,
response text or raw errors. Diagnostic storage/rendering failures are best effort
and cannot interrupt task execution. A response timeout preserves fail-closed
behavior and reports the existing safe reason code timeout.

## Alternatives considered

- Increase response timeout again: a completed unrecognized reply will still fail.
- Accept any new DOM node: rerendered historical messages can appear new.
- Accept any symphony-result block: stale revision or SHA must not authorize work.
- Manually import the completed failed-task reply into the Bridge: this bypasses
  normal attempt and lease fencing; retry must use a new authorized revision.

## Consequences

Positive fixtures cover modern code surfaces, count shrink, checkpoint baseline
mismatch, reused nodes and mixed selectors. Negative fixtures retain rejection of
stale/mismatched envelopes, malformed last blocks, pre-send results and active
streaming. Real #137 revision 3 subsequently confirmed baseline 5/current 4 at completed
response and a successful Bridge result receipt; see the
[live recovery evidence](../../../docs/evidence/self-hosting/driver-result-recovery-2026-10-17.md).
Historical failures are retained. Only an explicit operator authorization starts
a fresh delivery budget; this code patch does not reset budgets.
