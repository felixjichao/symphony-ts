# Bounded recovery and incidents

The CLI host bounds failed worker operations and work-continuity delegations while
preserving exponential backoff and the existing Decision/Web safety limits.
Configure finite counters in WORKFLOW.md:

```yaml
agent:
  recovery:
    max_attempts: 6
    max_strategy_attempts: 2
```

Supported capabilities determine the strategy. Workers retry through the existing
fresh-admission launch path; continuity delegates native resume, claim reclamation
or handoff compensation. Decision/Web retain their resume/rebind behavior and
native 3/6 limits. A component with one safe primitive exhausts its total budget
rather than inventing an unsupported action. Normal continuation, pending CI,
valid leases, browser-page availability and capacity waits do not spend failure
budget. Successful process exit alone does not erase unresolved worker history.

A task/revision/HEAD or handoff change can re-scope the related stage budget.
Lease/binding changes, page reload, heartbeat and timer reconstruction do not.
Authentication/infrastructure blocks do not disappear just because a PR HEAD changes.
Existing snapshots retain their native counts; legacy worker retry attempts are
conservatively inherited when they next fail. Hot reload uses the same ledger.
If changing the workspace root between host runs, retain/migrate the host recovery
files with the native state; moving to an empty directory is not an unblock API.

## Inspect and authorize

The host writes `.symphony-host/recovery-ledger.json` beneath its initial workspace
root. Incidents include work/action, owner, safe fencing/target, classification,
last progress, attempts, tried actions, blocked reason and the unblock condition.
No lease credentials, raw exceptions or conversation text are included.

```bash
symphony recovery list /path/to/workspaces/.symphony-host/recovery-ledger.json
symphony recovery show /path/to/workspaces/.symphony-host/recovery-ledger.json <incident-id>
```

Resolve the cause and verify current native facts before authorizing that exact
current host-policy incident:

```bash
symphony recovery authorize /path/to/workspaces/.symphony-host/recovery-ledger.json <incident-id>
```

This advances the policy epoch and preserves incident history. For a worker-launch
incident with an exact retry token, invoking this command attests that the old
executor was inspected and is stopped: it removes only that native reservation and
the live host reconciles its cached owner. A successor token cannot be released.
For other incidents it does not release a Decision lease, log into ChatGPT, repeat Send,
rerun a repair, or opt into merging. Decision blocks use the existing exact-fence
`continuity/unblock` control API after receipt/conversation inspection. Delivery
blocks retain their native verification requirements. If authorization is interrupted
after native removal, repeat the same exact-ID authorization; policy stays blocked
until that commit succeeds.
A modeled ownership conflict can clear automatically after fresh native facts prove
the conflict is gone; its prior incident remains in history and its old epoch cannot
commit. A failed atomic reclaim can retry within budget only after exact unchanged
claim readback proves no commit. Unknown subprocess/Send/merge outcomes still block.
Old incident IDs cannot authorize a newer block. Reconciliation re-reads authority
facts before any newly admitted action; elapsed time and file deletion grant no
permission. Keep both native records and host recovery files during restarts.

## GitHub reporting

For a GitHub Work, the host reporter publishes the durable incident to its Issue
with `symphony:recovery-incident:<id>`. It refreshes native facts before publishing
and acknowledging the current incident. The adjacent `.outbox` file records POST
intent/receipt. Reconciliation checks the stable marker before publication;
unknown POST acknowledgement only permits marker verification, never a blind
resend. All comment pages are queried.

Reporting gets three automatic attempts, including receipt verification. An
unavailable provider, ambiguous POST, concurrent claim or crash before POST can
leave a local incident without a remote comment. Inspect the ledger and outbox;
the original blocked work and its evidence are retained, and reporter failure
never creates another incident. The Dashboard does not own reporting or recovery.

These guarantees apply to the CLI host composition. Library embedders must provide
the `authorizeFailureRetry` and work-continuity policy ports plus durable storage.
Fixtures are not live GitHub/browser acceptance; see [testing](testing.md).
