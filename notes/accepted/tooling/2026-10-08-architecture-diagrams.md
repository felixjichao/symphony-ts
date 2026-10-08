# Agent Note: Canonical architecture diagrams — committed HTML sources, derived SVGs

Status: accepted

## Problem

The repository already carried strong textual architecture documentation
(`README.md`, `docs/architecture.md`, `docs/github-delivery-workflow.md`), but the
system model, package boundaries and GitHub delivery loop were only expressed as
tables and ASCII flow. GitHub #91 (NEST-96) asked for a small canonical visual
layer based on the `cathrynlavery/diagram-design` visual grammar, without turning
the pictures into a competing specification and without adding a heavy rendering
dependency to the default gate. The text must stay authoritative; the diagrams
must remain editable, deterministic to regenerate, and diffable in review.

## Decision

Add four canonical diagrams under `docs/diagrams/`: `runtime-architecture`,
`package-dependencies`, `github-delivery-loop` and `delivery-trust-boundary`.
Each ships as an editable `docs/diagrams/source/<name>.html` and a committed
`docs/diagrams/<name>.svg`. The whole diagram — markup and styles — lives inside
a single `<svg>` element in the source HTML; `scripts/export-diagrams.mjs`
extracts that element verbatim and prepends an XML declaration, so a regeneration
is deterministic and needs no browser, canvas, rasterizer or network.

`npm run docs:diagrams` regenerates the artifacts and `npm run docs:diagrams:check`
verifies the committed SVGs match their sources. `scripts/docs-check.mjs` (part of
`npm run gate`) additionally fails when a source/artifact pair is missing, when a
committed SVG is stale, or when one of the authoritative documents stops
referencing its diagram. Only the `diagram-design` visual grammar is reused
(one reading direction, orthogonal connectors, limited density, 1–2 accent
elements, dashed tier / trust-boundary zones), pinned at commit
`f4547ee95f88e5b28a52517feff6b6c11cc657f9` (v2.5.10, MIT); PNG export is out of
scope. A new tooling Agent Note is required before introducing any heavier
rendering path.

## Alternatives considered

1. **Use the upstream `diagram-design` exporter (`python3 scripts/export_svg.py`,
   Playwright for PNG).** Rejected: it would add Python, Playwright and a browser
   runtime to the repo and to CI for a static docs change, and its CSS
   carry-forward step exists because that skill keeps page-level CSS. We keep
   every style inside the SVG, so a verbatim extraction is both deterministic and
   dependency-free; the blocker for the upstream path is the dependency it drags
   in, not its output quality.
2. **Hand-author the `.svg` files directly, with no HTML source.** Rejected: the
   issue requires an editable source and a rendered artifact that stay in sync;
   hand-maintained SVG duplicates structure and drifts from the source of truth.
3. **Use Mermaid (or another GitHub-native code-block diagram).** Rejected: it
   produces no committed vector artifact, gives little control over layout or
   density, and does not match the diagram-design grammar the issue asked for.
4. **Render PNGs in CI.** Rejected: unnecessary (the SVG renders on GitHub and
   keeps text as vector) and it reintroduces a nondeterministic
   font/browser dependency into the default pipeline.
5. **Draw all direct package dependency edges (19) instead of the transitive
   reduction (10).** Rejected: it exceeds the diagram-design density and
   rank-layer budgets and reads as a hairball; the covering-relation reduction
   keeps the constraint story legible, while the authoritative direct dependency
   list stays in `docs/architecture.md` and `AGENTS.md`.

## Consequences

- Four diagrams are committed as source + artifact pairs; regeneration is
  documented in `docs/diagrams/README.md`, and the docs gate protects the pairing,
  freshness and required references with zero rendering dependency.
- The text documents remain authoritative for exact contracts. When a documented
  boundary or the delivery path changes, the same PR must update the matching
  diagram source and regenerate its SVG.
- Contributors must not hand-edit `docs/diagrams/*.svg`; the gate rejects a stale
  artifact, so the editable HTML is the only maintenance entry point.
- Visual layout quality is still a human review responsibility — the docs gate
  only checks pairing, freshness and references.
- Introducing real layout computation, PNG export or a browser into the default
  gate requires a new Note that justifies the added dependency.
