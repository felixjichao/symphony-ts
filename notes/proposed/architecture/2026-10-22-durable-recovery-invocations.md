# Durable recovery invocation foundation (NEST-133 / GitHub #149)

Status: proposed; partial implementation only. SPEC §4 adjacent, §7/§8/§14 and §17/§18.

Baseline: `main@1a8eb105a29d6d4340cd05243644f8312ff3f8ca`.

## Implemented boundary

The work coordinator records a unique invocation before delegating to a native
Decision or Delivery authority. The host stores these requests under the workspace
root's `.symphony-host/recovery.json`, outside individual issue workspaces. Startup
loads them even when tracker inventory no longer contains their WorkKey. Failed
reads or unresolved authority outcomes retain suppression across restarts. Native
evidence of completion/invalidation or a certified no-commit refusal settles the
request. This does not make an ambiguous operation safe to replay.

Observation versions now hash the existing native-source snapshot rather than
persisting its JSON, which contains service configuration. Persisted requests retain
only the target, invocation ID, authority and relevant native fences. Snapshot files
are created with mode 0600. Ordinary Delivery state writes reuse the fsync + atomic
rename writer; budget and pause semantics otherwise remain unchanged.

A synchronous, exclusive file mutex serializes snapshot read/modify/write across
processes. An unresolved WorkKey cannot be overwritten. Acknowledgement compares
the entire request including its unique invocation ID, so an old acknowledgement
cannot delete a newer request. A crash inside the file commit may leave the mutex;
startup fails closed rather than guessing that the write succeeded. Atomic rename
alone is not the concurrency protocol.

## Additional dispatch boundary requiring a design amendment

The approved analysis proposes durable retry reservations, removed on dispatch,
with incarnation/token fencing. The existing authority still transitions from
reservation to `running` in a synchronous, process-local `commitDispatch`, and
`startWorker` launches an external coding process. A durable retry snapshot alone
cannot protect this boundary:

1. Remove the durable reservation before launching: process death after removal
   but before launch loses the reservation, its attempt and due-time evidence.
2. Keep it until launch: process death after launch but before acknowledgement
   leaves an ambiguous reservation and possibly a live orphan coding process.
3. Restore that reservation in a new host: a new incarnation prevents token
   reuse, but does not prove the old executor is dead or prevent its external
   mutations. Comparing a stored token is not executor revocation.

The host has no durable active-attempt/launch receipt or host ownership lease
that can establish the missing fact. `WorkerControl`, `active`, lifecycle
`generation`, and retry ownership are all process-local. Fresh GitHub and Decision
reads alone cannot prove that an unacknowledged local coding executor never
started. The Delivery authority lock is a separate boundary and does not fence
these coding workers.

Completing the retry guarantee therefore requires an explicit decision about a
**retry-to-coding dispatch intent and executor ownership/revocation contract**,
including orphan-child evidence and the point where a reservation can be settled.
That expands the approved design beyond serializing timer reservations. The
implementation agent has stopped this expansion and requested requirement
analysis. The retry prototype was withdrawn; no retry persistence is enabled by
this foundation. Review/result continuation, landing intent unification and safe
Delivery crash-lock reclamation also remain unimplemented.

## Alternatives considered

- Persist only `dueAtMs`: rejected because it belongs to the old monotonic clock.
- Clear the reservation immediately before `startWorker`: rejected because it
  leaves a durable gap before the external effect.
- Keep the reservation and restore it unconditionally: rejected because an old
  coding executor may still be acting externally.
- Use a fresh UUID alone as revocation: rejected because a process-local worker
  does not consult that UUID before each external mutation.
- Ship the invocation foundation as complete #149: rejected; durable suppression
  is one prerequisite, not stage continuation or retry recovery.
- Automatically steal a leftover filesystem mutex by age: rejected; time does
  not prove that an owner or its external mutation has stopped.

## Validation

`apps/cli/src/recovery-storage.test.ts` bundles the production storage writer,
starts it in a separate Node process, persists an intent, and SIGKILLs that child.
A fresh coordinator discovers the intent and refuses replay without native
resolution evidence. Other cases cover ambiguous effects, durable-write failure,
old acknowledgements, competing storage instances, invalid schema and atomic
replacement. Existing work-continuity tests continue to exercise native fences,
re-observation and shutdown. These are foundation tests, not #149 acceptance.
