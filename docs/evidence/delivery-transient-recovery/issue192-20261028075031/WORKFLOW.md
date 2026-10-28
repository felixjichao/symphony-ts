---
tracker:
  kind: github
  provider:
    repo: felixjichao/symphony-delivery-dogfood
    token: $GITHUB_TOKEN
  required_labels: [symphony-ready, dogfood-issue192-20261028075031]
  active_states: [open]
  terminal_states: [closed]
polling:
  interval_ms: 5000
workspace:
  root: /private/tmp/symphony192-live-vgUvzM/workspaces
hooks:
  after_create: |
    set -eu
    /private/tmp/symphony192-live-vgUvzM/bin/symphony repo-bootstrap --repo https://github.com/felixjichao/symphony-delivery-dogfood.git --workspace-key "$SYMPHONY_WORKSPACE_KEY"
    git config credential.helper '!gh auth git-credential'
    mkdir -p .symphony
    printf 'real runtime file\n' > .symphony/runtime-probe.json
  after_run: |
    set -eu
    test -f test/issue192_20261028075031.test.mjs
    /private/tmp/symphony192-live-vgUvzM/bin/symphony delivery-skill run --repo felixjichao/symphony-delivery-dogfood --issue 29 --workspace-key GH-29 --head "$(git branch --show-current)" --base main --validate "npm run gate" --repair-cmd "npm run ci:fix" --required-checks gate --max-wait 1800 --max-repairs 3 --opt-in > /private/tmp/symphony192-live-vgUvzM/delivery-cli.log 2>&1
    cat /private/tmp/symphony192-live-vgUvzM/delivery-cli.log
  timeout_ms: 1800000
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
After implementation and validation, finish your coding turn. Do not invoke Delivery inside the coding sandbox and do not commit, push, merge, reset, rebase or edit runtime state. The trusted operator-owned after_run hook runs the native Delivery CLI outside the coding sandbox and owns all index/history and remote writes.
