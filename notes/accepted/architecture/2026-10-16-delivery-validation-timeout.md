# Agent Note: Delivery validation timeout
Status: accepted

## Problem

GitHub delivery (SPEC §17/§18 adjacent host extension) invoked project validation
without a timeout override. The CLI subprocess runner defaulted to 60 seconds,
while self-hosted #137's complete passing gate took 115 seconds. Valid work was
therefore halted before PR creation.

## Decision

The domain-owned DeliverySkillConfig exposes optional validationTimeoutMs.
The CLI accepts --validation-timeout in integer seconds and converts once to
milliseconds. The agent uses the configured timeout (default 600000 ms) for all
three project validation paths: initial, CI repair, and review repair. Values must
be positive integers within Node timer range; invalid API values fail before I/O.
CLI seconds are capped at 2147483. The full validation command is unchanged.
Git/gh defaults, repair timeouts, persisted CI deadlines and budgets are unchanged.

## Alternatives considered

- Increase every subprocess timeout: rejected because ordinary git/gh calls and
  project gates have different lifetimes.
- Reuse max-wait: rejected because CI polling deadlines are a separate budget.
- Skip or shorten the gate: rejected because it weakens validation.

## Consequences

Operators can give complete gates enough time without disabling bounded process
group termination. Timeout or failure still halts delivery. Increasing this limit
does not replenish budgets or extend an already-persisted deadline.
