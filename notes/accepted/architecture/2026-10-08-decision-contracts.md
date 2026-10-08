# Agent Note: Provider-neutral Decision contracts
Status: accepted

## Problem

GitHub #94 / NEST-99 needs durable planning and review facts rooted in an Issue,
with exact HEAD approval and executor continuity that cannot become workflow truth.
Existing Symphony SPEC §7 state and delivery budget storage serve different purposes.

## Decision

Extend `@symphony/domain` with readonly versioned session/task/result/binding contracts,
strict hand-written validators and pure protocol transitions. Root identities are
work-item scoped; review identity includes session, repository, PR, HEAD and revision.
Store-facing lease generation/token fencing and binding generation are independent.
Result validation and approval compare exact identity; completed approvals can be
superseded. Rebinding never changes historical verdict validity by itself.

See [protocol v1](../../../docs/decision-protocol.md) for field sets, transition tables,
serialization and caller/store preconditions. This is an extension adjacent to §4
shared contracts, not a change to official Core conformance or §7 orchestration.

## Alternatives considered

- PR-root sessions or executor conversation IDs as workflow identity: rejected because
  replacement PRs and executor rollover must retain the same work-item semantics.
- Embedding the transitions in orchestrator or reusing delivery budget storage:
  rejected because this task only defines a protocol and must preserve Core behavior.
- Runtime schema dependency: rejected for this small closed v1 contract; strict
  validators keep domain dependency-free, with negative tests guarding type drift.
- Approval based on session continuity or PR number alone: rejected because only an
  exact HEAD result can establish a current review condition.

## Consequences

Future stores/adapters share one public contract. Strict versioning requires explicit
migration for shape changes. Pure helpers cannot enforce atomicity, revision allocation
or completeness of a session task list; stores must implement those preconditions.
No durable store, bridge, executor integration, dispatch policy or merge gate ships here.
