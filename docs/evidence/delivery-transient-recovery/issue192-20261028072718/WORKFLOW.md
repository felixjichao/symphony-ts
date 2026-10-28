---
tracker:
  kind: github
  provider:
    repo: felixjichao/symphony-delivery-dogfood
    token: $GITHUB_TOKEN
  required_labels: [symphony-ready, dogfood-issue192-20261028072718]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 5000
workspace:
  root: /private/tmp/symphony192-live-gExxRI/workspaces
hooks:
  after_create: |
    set -eu
    /private/tmp/symphony192-live-gExxRI/bin/symphony repo-bootstrap --repo https://github.com/felixjichao/symphony-delivery-dogfood.git --workspace-key "$SYMPHONY_WORKSPACE_KEY"
    git config credential.helper '!gh auth git-credential'
    mkdir -p .symphony
    printf 'real runtime file\n' > .symphony/runtime-probe.json
  timeout_ms: 120000
agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server
  approval_policy: never
  turn_timeout_ms: 1800000
  read_timeout_ms: 120000
  stall_timeout_ms: 600000
---
Implement GitHub issue {{ issue.native_ref.number }}. Follow AGENTS.md and the accepted published plan.
{{ issue.description }}
After implementing source and tests, run npm run gate and npm run lint.
Then run the following exact native Delivery entry and wait for it to finish (allow at least 1200 seconds). Do not commit/push/merge yourself:
/private/tmp/symphony192-live-gExxRI/bin/symphony delivery-skill run --repo felixjichao/symphony-delivery-dogfood --issue {{ issue.native_ref.number }} --workspace-key GH-{{ issue.native_ref.number }} --head "$(git branch --show-current)" --base main --validate "npm run gate" --repair-cmd "npm run ci:fix" --required-checks gate --max-wait 1800 --max-repairs 3 --opt-in
If the native entry reports a blocker, preserve all state and stop. Do not restart or edit delivery state.
