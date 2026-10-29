# Agent Note: Bounded Delivery handoff comments
Status: accepted

## Problem

The #168/#176 closeout audit found persisted #173/#175/#176 handoff details near 280,000 characters. GitHub rejected the comment with a 65,536-character limit. Initial handoff and compensation both rendered the same full diagnostic text, so retries could not converge. SPEC §4/§11.5 Delivery extension; §17/§18 regression evidence.

## Decision

Keep `DeliveryHandoff.details` unchanged in the native state. The canonical domain formatter bounds the complete published Markdown to 60,000 UTF-16 code units, leaving headroom below the observed GitHub limit. Short reports retain their existing output. Long details become a prefix plus an explicit truncation notice, original UTF-16 length and SHA-256 over the original UTF-8 text. Truncation cannot split a surrogate pair. Identity, receipt marker, reason and budget sections remain outside the truncated prefix. If metadata alone cannot fit, fail explicitly rather than emitting an oversized comment or silently losing identity.

Initial publication and `recover-handoff` continue to call this one formatter with the same handoff identity. No persistence schema, retry budget, publication receipt or ownership policy changes. The formatter uses Node crypto, as the existing Node domain entrypoint already does; the browser-safe Decision entrypoint does not export this module.

## Alternatives considered

- Truncate inside each agent call site: rejected because first publication and compensation could diverge or leave another formatter consumer unbounded.
- Replace persisted details with the shortened report: rejected because it destroys the original failure evidence and changes the native record to solve a transport limit.
- Upload full logs or split them across several GitHub comments: rejected because this adds external publication effects, disclosure and receipt/deduplication semantics beyond this fix.
- Truncate the entire rendered document: rejected because receipt markers and operator instructions could disappear.

## Consequences

Large diagnostics remain available in configured native state; visible comments carry a verifiable digest and explicit omission. The original string is not mutated. Domain regressions cover ASCII, Unicode boundary positions and oversized metadata; agent regressions cover initial failure, compensation retry, accepted-comment ACK loss and repeated recovery without duplicate posts, executor restart or budget changes.

This fix does not settle externally merged work, authorize an old HEAD, recover missing Decision approvals or deploy into the supervising runtime. Those remain separate work under the closeout audit.
