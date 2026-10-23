# Agent Note: Production read-only status composition
Status: accepted

## Problem

The operations query, HTTP transport and Dashboard had separate acceptance but no production host wiring. #140 requires an observable, scoped local surface without adding authority or changing orchestration.

## Decision

The CLI owns opt-in loopback status composition and built static assets. Operator-provided canonical WorkKeys define scope. Narrow observation functions feed existing reader factories and the sole operations query. Runtime reuses the same host snapshot. Local Decision reuses its open service; authenticated Bridge observation reads the same committed whitelist with an abort budget. GitHub reuses marker-verified observeWork under a whole-read subprocess deadline and canonical delivery naming. Inventory remains explicitly configured or unknown. HTML hosting selects a display-only production label; demo remains labeled.

Status failures are caught independently. Stop fences admission synchronously and drains pending observations before shared store close, preserving native cleanup. Browser code receives serialized projections and no authority objects.

## Alternatives considered

Opening another Decision store risks lock conflicts and inconsistent reads. Continuity APIs are not the operational whitelist and can carry recovery semantics. Combining multiple task/result reads loses committed-state consistency. Guessing PR ownership or scanning all issues changes scope and can misassociate work. Running the demo/Vite in production gives false provenance and extra runtime capabilities. Browser projection duplicates domain authority. Persistent caches, streaming and operator actions exceed this closeout.

## Consequences

Both existing Decision backend modes remain observable. Assets must be built with the CLI; missing assets disable status without disabling the host. Nonstandard delivery naming is unavailable rather than guessed. Explicit small scopes bound external read volume, but independent clients still generate independent queries. Cross-source observations are non-atomic; loopback exposure and source freshness remain explicit. Controlled acceptance does not establish authenticated public-provider live acceptance.
