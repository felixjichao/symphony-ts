# Agent Note: Attention-first Overview
Status: accepted

## Problem
#171 / SPEC §13 adjacent requires an operator landing page showing intervention, waiting and observational trust without creating a second Operational Read Model projector.

## Decision
Render Overview from the supplied snapshot only. A fingerprint-locked identity selector partitions work into needs-human/failed, degraded or explicitly anomaly-associated, waiting, and remaining current work. These are presentation buckets; the original attention badge remains unchanged even when an anomaly association changes its bucket. Normal current work is not reclassified as active from its phase; the active aggregate comes directly from summary.active. Stable ordering uses complete WorkKey identity. Show source posture even for empty work, supplied health and executor ownership, and compact global/work anomaly summaries. Full diagnostic evidence stays in System / Work Detail, avoiding duplicate interactive diagnostic IDs. The existing persistent notice owns receipt/error state separately from snapshot generated time.

## Alternatives considered
Deriving active/waiting/health from execution, CI or review facts would duplicate the projector and is rejected. Reusing full anomaly evidence cards on both Overview and hidden detail surfaces duplicates diagnostic IDs and interactive state; compact noninteractive summaries provide visibility while keeping evidence navigation stable.

## Consequences
The browser gains no source reads or mutation capability. Selection does not infer anomaly severity or alter supplied conclusions. Empty buckets say only that this snapshot reports no matching work; they never claim global health. Source metadata and explicit production scope remain visible. Adversarial tests and extended renderer guards constrain this boundary. Controlled HTML artifacts and optional browser rendering use actual mounted components; production self-hosting, CI and exact-HEAD review remain operator-host evidence.
