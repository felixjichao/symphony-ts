# GitHub delivery dogfood target template

Synthetic target repository for the opt-in real GitHub + real Codex end-to-end
dogfood (NEST-94 / #83). It is intentionally tiny and credential-free:

```text
open issue + symphony-ready
  → Symphony dispatch + workspace bootstrap
  → real Codex implements + validates
  → delivery skill commits / pushes / opens PR
  → GitHub Actions CI
       ├─ failure → real Codex repair (`npm run ci:fix`) → push → green
       └─ green
  → automatic squash merge (opt-in)
  → `Fixes #N` closes the issue
  → Symphony terminal reconciliation + workspace cleanup
```

## Layout

- `src/math.mjs`, `test/math.test.mjs` — the feature the dogfood issue asks for.
- `scripts/lint.mjs` — a CI-only lint gate that rejects `console.log` in `src/`.
  The local `gate` runs only the unit tests, so CI is stricter than the local
  gate; the `repair` scenario injects a `console.log` fault into this repository
  before dispatch, forcing one real CI failure that real Codex must fix.
- `scripts/ci-fix.mjs` — the real Codex repair entry, run by the delivery skill
  with `SYMPHONY_CI_FAILURE_DIAGNOSTICS`.
- `WORKFLOW.md` — the reference profile, with `<owner/repo>` rendered by the
  harness (`symphony dogfood github`) or replaced by hand.
- `.github/workflows/ci.yml` — runs `npm test` and the CI-only `npm run lint`.

The product repository's harness documentation is in
[docs/github-delivery-dogfood.md](../../docs/github-delivery-dogfood.md).

## Manual use

1. Create an isolated repository and copy this directory's contents into it.
2. Replace `<owner/repo>` in `WORKFLOW.md` with the target slug and commit.
3. Export `GITHUB_TOKEN`, then run `symphony <path-to-WORKFLOW.md>`.
4. Create an issue labeled `symphony-ready` that asks for `subtract(a, b)`.

Do not point this template at a production repository.
