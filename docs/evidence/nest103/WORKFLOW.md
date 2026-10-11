---
# Symphony reference profile — closed-loop GitHub delivery.
#
# `symphony dogfood github` renders this into a run directory with felixjichao/symphony-delivery-dogfood
# replaced by the authorized dogfood target. Operators may also copy it into the
# target repository and run `symphony <path-to-WORKFLOW.md>` by hand.
tracker:
  kind: github
  provider:
    repo: felixjichao/symphony-delivery-dogfood # REQUIRED: repository Symphony reads issues from (owner/repo)
    token: $GITHUB_TOKEN # REQUIRED: export a token with repo scope
  required_labels:
    - symphony-ready
  active_states:
    - open
  terminal_states:
    - closed

polling:
  interval_ms: 10000

workspace:
  root: /private/tmp/symphony-nest103-e2e/workspaces

hooks:
  after_create: |
    set -eu
    export GH_CONFIG_DIR=/private/tmp/symphony-nest103-e2e-auth
    unset GH_TOKEN GITHUB_TOKEN
    /private/tmp/symphony-nest103-e2e/bin/symphony repo-bootstrap \
      --repo https://github.com/felixjichao/symphony-delivery-dogfood.git \
      --workspace-key "$SYMPHONY_WORKSPACE_KEY"
  timeout_ms: 120000

agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server
  approval_policy: never
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are the coding agent for GitHub issue #{{ issue.native_ref.number }}
({{ issue.identifier }}).

Title: {{ issue.title }}

Body:
{{ issue.description }}

Work autonomously to completion. A human does not merge for you.

1. Inspect the repository and implement the change the issue asks for.
   This run is an explicit controlled-fault experiment for issue #18. On the FIRST
   coding pass only, seed `sortedCopy_nest103_20261010(values)` with exactly
   `return values.sort((a, b) => a - b);` and add ordering-only tests (including
   negatives and duplicates). This intentionally violates the non-mutation
   requirement; retain it until the independent Review detects it. Do not ask
   the reviewer for a particular verdict or fabricate a result. The repair
   command must fix the defect and add a non-mutation regression test before
   final delivery. Preserve all existing tests and exports. Do not manually
   commit, push, or merge: the delivery skill owns those effects.
2. Run the project's local gate — the same command the delivery skill is
   configured with through `--validate` below — until it passes.
3. Deliver the change end to end with the delivery skill:

   ```sh
   set -eu
   export GH_CONFIG_DIR=/private/tmp/symphony-nest103-e2e-auth
   unset GH_TOKEN GITHUB_TOKEN
   delivery_branch="$(git branch --show-current)"
   delivery_key="${delivery_branch#symphony/}"
   test -n "$delivery_key" && test "$delivery_branch" != "$delivery_key"
   base_branch="${SYMPHONY_DELIVERY_BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
   base_branch="${base_branch:-main}"
   resume_flag=""
   if [ -f .symphony/delivery-state.json ] && grep -q '"isPaused"[[:space:]]*:[[:space:]]*true' .symphony/delivery-state.json; then
     resume_flag="--resume"
   fi
   /private/tmp/symphony-nest103-e2e/bin/symphony delivery-skill run \
     --repo {{ issue.native_ref.repo }} \
     --issue {{ issue.native_ref.number }} \
     --workspace-key "$delivery_key" \
     --head "$delivery_branch" \
     --base "$base_branch" \
     --validate "${SYMPHONY_DELIVERY_VALIDATE:-npm run gate}" \
     --repair-cmd "node /private/tmp/symphony-nest103-e2e/repair.mjs" \
     --bridge-url http://127.0.0.1:4041 \
     --bridge-token <redacted-local-token> \
     --max-repairs 3 \
     --max-wait 3600 \
     $resume_flag \
     --opt-in
   ```

   `--repair-cmd` is the repair entry: on a CI failure the skill runs it with the
   failure logs in `SYMPHONY_CI_FAILURE_DIAGNOSTICS`, re-runs `--validate`,
   commits, pushes, and re-checks CI — up to `--max-repairs` attempts.

4. If the delivery skill hands back a blocker (budget exhausted, conflicting or
   unmergeable pull request, ambiguous requirement), summarize it and stop. Do
   not guess, and never merge by hand.
