# Canonical architecture diagrams

A small visual layer over the written architecture. The text in
[README.md](../../README.md), [docs/architecture.md](../architecture.md) and
[docs/github-delivery-workflow.md](../github-delivery-workflow.md) stays
authoritative for exact SPEC / conformance semantics; these diagrams only make
the current implementation understandable at a glance and must not become a
second source of truth.

## Files

Each diagram ships as an editable HTML source and a committed, GitHub-renderable
SVG artifact. The SVG is derived from the HTML, never hand-written.

| Diagram | Artifact | Editable source | Authoritative text |
|---|---|---|---|
| Symphony runtime architecture | [runtime-architecture.svg](runtime-architecture.svg) | [source/runtime-architecture.html](source/runtime-architecture.html) | [README](../../README.md), [architecture](../architecture.md) |
| Package dependencies | [package-dependencies.svg](package-dependencies.svg) | [source/package-dependencies.html](source/package-dependencies.html) | [architecture](../architecture.md) |
| GitHub delivery loop | [github-delivery-loop.svg](github-delivery-loop.svg) | [source/github-delivery-loop.html](source/github-delivery-loop.html) | [github-delivery-workflow](../github-delivery-workflow.md) |
| Delivery trust boundary (MVP) | [delivery-trust-boundary.svg](delivery-trust-boundary.svg) | [source/delivery-trust-boundary.html](source/delivery-trust-boundary.html) | [github-delivery-workflow](../github-delivery-workflow.md) |

## Regenerating

The whole diagram lives inside a single `<svg>` element in the source HTML, so
the exporter only extracts that element and adds an XML declaration. There is no
browser, canvas, or network dependency, and no rasterizer is required.

```sh
npm run docs:diagrams        # source/*.html  -> committed *.svg
npm run docs:diagrams:check  # verify every committed SVG matches its source
```

`npm run docs:check` (and therefore `npm run gate`) already fails when a source
or artifact is missing, when a committed SVG is stale relative to its source, or
when one of the authoritative documents stops referencing its diagram. Run
`npm run docs:diagrams` and commit the result whenever a source changes.

## Editing

1. Edit `docs/diagrams/source/<name>.html` — the diagram is one `<svg>` node
   inside the page; the surrounding page chrome is only for local previewing.
2. Run `npm run docs:diagrams` to regenerate `docs/diagrams/<name>.svg`.
3. Commit the HTML source and the regenerated SVG together.

Do not hand-edit the `.svg`: it is a derived artifact and the docs gate will
reject a copy that does not match its source. The exporter keeps every style
inside the SVG (via an internal `<style>` block and presentation attributes), so
the artifacts render on GitHub without external CSS or JavaScript.

## Design

The diagrams follow the visual grammar of
[cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design)
(MIT), pinned at commit `f4547ee95f88e5b28a52517feff6b6c11cc657f9` (skill
metadata version 2.6):
one primary reading direction per diagram, orthogonal connectors, a limited node
count, accent color reserved for one or two focal elements, and dashed zones for
tiers and trust boundaries. Only the grammar is reused — the diagrams are
authored in-repo and exported by our own zero-dependency script, so maintaining
them never requires the upstream skill, Figma, or Playwright. PNG export is out
of scope for this diagram set.
