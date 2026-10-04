---
# Symphony reference profile — closed-loop GitHub delivery.
#
# Copy this file to the root of a target repository as `WORKFLOW.md`, then replace
# every `<owner/repo>` placeholder and export `GITHUB_TOKEN` before starting
# `symphony <path-to-WORKFLOW.md>`. See the sibling README.md for the copy
# procedure and docs/github-delivery-workflow.md for the full lifecycle.
tracker:
  kind: github
  provider:
    repo: <owner/repo> # REQUIRED: repository Symphony reads issues from (owner/repo)
    token: $GITHUB_TOKEN # REQUIRED: export a token with repo scope
  # Dispatch gate: only issues carrying this label are picked up. The delivery
  # skill removes it on a handoff, which stops further dispatch without closing
  # the issue.
  required_labels:
    - symphony-ready
  active_states:
    - open
  terminal_states:
    - closed

polling:
  interval_ms: 30000

workspace:
  # Per-issue isolated checkout, resolved relative to this WORKFLOW.md.
  root: ./workspaces

hooks:
  # Populate a fresh workspace: clone the target repository, create/reuse the
  # deterministic issue branch, and install the delivery skill where Codex can
  # discover it. Idempotent — re-running a populated workspace is safe.
  after_create: |
    set -eu
    symphony repo-bootstrap \
      --repo https://github.com/<owner/repo>.git \
      --workspace-key "$SYMPHONY_WORKSPACE_KEY"
    mkdir -p .agents/skills/github-delivery
    cp skills/github-delivery/SKILL.md .agents/skills/github-delivery/SKILL.md
  timeout_ms: 120000

agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
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
2. Run the project's validation gate — the same command the delivery skill is
   configured with through `--validate` below — until it passes. Do not commit,
   push, or merge while validation fails.
3. Deliver the change end to end with the delivery skill. It commits, pushes,
   creates or reuses the pull request, watches CI, repairs failures within a
   bounded budget, and squash-merges only when every required check is green:

   ```sh
   set -eu
   delivery_branch="$(git branch --show-current)"
   delivery_key="${delivery_branch#symphony/}"
   test -n "$delivery_key" && test "$delivery_branch" != "$delivery_key"
   base_branch="${SYMPHONY_DELIVERY_BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')}"
   base_branch="${base_branch:-main}"
   # A previous CI blocker pauses delivery; continue it instead of refusing to run.
   resume_flag=""
   if [ -f .symphony/delivery-state.json ] && grep -q '"isPaused"[[:space:]]*:[[:space:]]*true' .symphony/delivery-state.json; then
     resume_flag="--resume"
   fi
   symphony delivery-skill run \
     --repo {{ issue.native_ref.repo }} \
     --issue {{ issue.native_ref.number }} \
     --workspace-key "$delivery_key" \
     --head "$delivery_branch" \
     --base "$base_branch" \
     --validate "${SYMPHONY_DELIVERY_VALIDATE:-npm run gate}" \
     --repair-cmd "${SYMPHONY_DELIVERY_REPAIR_CMD:-npm run ci:fix}" \
     $resume_flag \
     --opt-in
   ```

   `--repair-cmd` is the repair entry: on a CI failure the skill runs it with the
   failure logs in `SYMPHONY_CI_FAILURE_DIAGNOSTICS`, re-runs `--validate`,
   commits, pushes, and re-checks CI — up to `--max-repairs` attempts. `--base`,
   `--validate`, and `--repair-cmd` are repo-specific; override them with the
   `SYMPHONY_DELIVERY_*` environment variables or edit this command.

   The `--opt-in` flag is what authorizes the automatic squash merge, and it only
   applies to the pull request this workspace opened for the current issue.

4. If the delivery skill halts with a handoff report — the CI repair budget is
   exhausted, the pull request conflicts or cannot be merged, or the change needs
   an ambiguous or destructive product decision — summarize the blocker and stop.
   Do not guess, and never merge by hand.
