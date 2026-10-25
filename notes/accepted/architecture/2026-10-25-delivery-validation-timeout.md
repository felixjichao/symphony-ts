# Agent Note: Delivery validation timeout across recovery
Status: accepted

## Problem
The self-hosted #169 delivery supplied `--validation-timeout 600`, but the CLI
ignored the flag and validation inherited the runner's 60-second default.

## Decision
Expose a positive seconds CLI option, convert it to `validationTimeoutMs` in the
shared Delivery configuration, and forward it to every validation invocation.
Persist the optional value in native continuation records and restore it through
the host. This is a SPEC §17/§18 Delivery extension, not a Core scheduler change.

## Alternatives considered
Increasing the generic runner timeout would affect Git/GitHub operations too.
Running validation separately and skipping delivery validation would weaken the
delivery gate. Neither is needed when the validation call has its own timeout.

## Consequences
Omission keeps the existing default; legacy continuation records remain valid.
The setting never resets or extends the durable CI/review wait deadline. New
budget rounds still need explicit operator authorization and preserved old state.
