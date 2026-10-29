# External delivery settlement validation

Credential-free Extension Conformance beside fixed SPEC §4/§11.5, §8/§14 and §17/§18. See [operator procedure](../../external-delivery-settlement.md) and [design note](../../../notes/accepted/architecture/2026-10-29-offline-external-delivery-settlement.md).

The 37 new cases span domain (2), tracker (3), agent (2), Decision (1), and CLI (29). CLI exercises actual temporary native stores, a real maintenance subprocess killed after its Decision transaction, all five interruption checkpoints, stale snapshots/leases/reservations, exact replay, remote identity drift, unmarked/foreign PR authorization, retained raw diagnostics/budgets/deadlines and accepted results/receipts, unrelated work, complete cleanup, post-cleanup admission fencing, and old/new host root exclusion across reload. GitHub is a strict GET-only fake; coding, Review, push and merge are forbidden by the fixture runner.

The first full gate exposed a custom-tracker regression: external admission checks passed `github_mock` / `profile_a` to the stricter Decision root parser. The fence now applies only to GitHub; a new regression plus the existing three secret-boundary tests passed before rerunning the full gate. The failed run is retained as a log digest in [validation.json](validation.json), alongside final result and source hashes.

This evidence does not claim production deployment, production-state settlement, real GitHub mutation or missing historical final-HEAD Review approval. The parallel edit to `scripts/cleanup-polluted-tasks.mjs` is outside the feature source fingerprint scope.
