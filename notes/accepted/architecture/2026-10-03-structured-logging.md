# Agent Note: Structured logging and committed runtime facts
Status: accepted

## Problem

SPEC §13.1/§13.2/§17.6 requires operator-visible issue/session context without making logging a scheduler dependency. Existing observation ports lacked dispatch/retry/reconciliation facts, and tracker omission observers could fail an otherwise successful candidate batch.

## Decision

Domain owns the service/issue/session `StructuredLogEvent` union. Observability owns a synchronous logger and default stderr sink, accepting scalar whitelist fields only. Render order is fixed; strings use JSON quoting. Registered raw, JSON and URL secret forms are redacted before escaped UTF-8 limits: reason 128 bytes, message 896, error 1024, stderr 2048, other strings 4096. Message plus reason is at most 1024 bytes. Oversized identity fails closed rather than silently changing it; raw text beyond 65536 code units is omitted. Failures produce fixed `logging_format_failed`/`logging_sink_failed` diagnostics with explicit null identity keys and no original payload. Each sink is isolated, remaining sinks receive one failure warning without recursive fallback. Stream write callbacks and error listeners isolate asynchronous stderr failures; after backpressure, subsequent lines are dropped until drain rather than accumulating a private queue.

Authority exposes frozen scalar `OrchestratorEvent` facts after dispatch/retry commit or worker acceptance; reconciliation distinguishes a stopped worker from retiring an already exited lifecycle. Existing outcome and cleanup ports remain intact, with optional outcome session/URL metadata and successful cleanup diagnostics added. No callback return affects scheduling, and no runtime/snapshot diff reconstructs facts. Tracker catches malformed omission observer failures; ID refresh continues to fail malformed requested records.

`apps/cli/src/logging.ts` adapts owner ports, preserves agent reduction callbacks and wraps tracker operations while rethrowing the original error. Thread-only starts are issue-level `agent_thread_started`; session lifecycle requires actual session identity. Hook output, AgentEvent.summary, raw protocol/provider payloads, Error causes and stacks are never copied. Hosts register candidate raw/resolved profile secrets and declared env values before failure logging and retain old values until logger close. Initial validation logs only fixed classifications, before secrets are available.

## Alternatives considered

Snapshot/state diffs lose transient facts and expose scheduler internals; owner commit-point events are explicit and testable. Importing owner packages into observability violates its domain-only dependency boundary; adapters belong in CLI. Dumping Error/AgentEvent/hook objects risks leaking secrets, including prefixes already truncated upstream; fixed templates are the approved MVP. Stdout would compete with future CLI output, so stderr is the default with injectable sinks.

## Consequences

Logger and snapshot exports accumulate independently. Rendering and callback failures cannot alter retry or outcome classification. Tests cover actual temp workflows, real app-server subprocess sessions, fragmented/oversized stderr, hooks and worker completion, plus ownership/event boundaries. Registered secret forms are supported; unknown arbitrary secret transformations are not inferred. §13.6 richer humanization remains conditional/deferred. The helpers and harness are not a production CLI host; argv, start/stop/signal entrypoints and effective-runtime reload commit remain M6.3–M6.5 responsibilities. Watcher acceptance logs explicitly describe watcher acceptance, not host runtime commit.
