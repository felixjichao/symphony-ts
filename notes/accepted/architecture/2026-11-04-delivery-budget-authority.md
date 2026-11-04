# Agent Note: Delivery budget authority
Status: accepted

## Problem
GitHub Delivery (SPEC §10, §13 and §17/§18 adjacent, #203) uses one persisted wall-clock deadline for validation, CI, Review and repairs. A restart cannot safely infer a new allowance, and the old timeout name can misidentify the exhausted budget.

## Decision
Model the total deadline as durable authority and each CI, Review, repair and validation phase as a separately bounded, durable checkpoint. A phase is identified by its work identity and authorization generation; re-entering it retains its deadline. A new HEAD or Review revision may start a distinct phase but never extends the total deadline. Explicit, exclusive, compare-and-swap operator authorization must record a durable receipt before extending authority; spent repairs and recovery evidence remain intact. In-process `repairFn` is rejected before any delivery operation because arbitrary callbacks cannot be terminated safely; repair commands run through the existing bounded subprocess runner.

## Alternatives considered
Resetting the deadline on resume or deleting the state would silently grant new authority and discard recovery evidence. A single per-invocation timeout would refresh on crash and does not bound total wall-clock time. Racing an in-process callback against a timer would return while its side effects may continue; cooperative cancellation cannot guarantee termination of existing callbacks.

## Consequences
Budget state must be validated before use and every side effect must respect persisted authority. Legacy migration fails closed when the prior authority cannot be established. CLI planning eligibility checks run after the total deadline is recorded, with bounded GitHub reads and cancellable Bridge requests. Review Bridge requests receive cancellation signals; the persisted operation key permits reconciliation of an uncertain task-creation outcome. Successful validation is durably recorded before subsequent work, but the receipt is not proof that workspace contents and validation inputs are unchanged. A restart before the CI checkpoint revalidates under the original phase deadline; an exhausted phase requires explicit renewal. A recorded CI or Review stage resumes only after verifying the PR, local HEAD and clean source workspace, without replaying the initial push. This conservative replay does not authorize repeating a repair or an uncertain GitHub effect.
