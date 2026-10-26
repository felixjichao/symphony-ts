# Agent Note: Execution-continuity acceptance evidence
Status: proposed

## Problem

Merged native recovery components need reproducible cross-boundary acceptance.
Historical live browser runs and credential-free fixtures have different provenance.

## Decision

Reuse native host, Decision store, Delivery lock, subprocess and reporter suites;
extend the real host restart path to read back the same authentication incident via
CLI after restart and tracker outage. Index all #151 scenarios in a durable matrix.
Record exact source/artifact identity and separate automated, historical and current
live results. Keep real browser/provider checks opt-in and explicitly unaccepted
when the required page, account or isolated target is unavailable.

## Alternatives considered

A new simulated recovery engine would test a parallel implementation, so it is
rejected. Treating historical browser runs or fixture receipts as current live
passes is rejected because installed artifacts and real boundaries differ. Adding
credential-dependent cases to default gate would make local validation unavailable
without proving the missing live profile, so the profile remains independent.

## Consequences

Default gate remains reproducible without credentials. The matrix exposes live
gaps and parent #145 cannot be declared ready to close from local gate alone.
No product recovery semantics or control authority changes in this acceptance slice.
