# Agent Note: Operator Console shell
Status: accepted

## Problem
GitHub #169 (parent #168, SPEC §13 adjacent) needs durable navigation before independent Dashboard V2 pages. V1 WorkKey links and read-only projection boundaries must survive.

## Decision
Keep framework-free DOM/Vite and native hash history. A presentation-only route module owns Overview, Work, Executors and System; every other hash retains legacy encoded WorkKey lookup, including explicit invalid/out-of-scope handling. Work Detail belongs to Work. Persistent chrome owns environment labeling, navigation and refresh notice. Snapshot panels share one main landmark, with inactive panels hidden from keyboard/accessibility navigation. Existing inventory and global diagnostics live in Executors and System respectively.

Deliberate navigation focuses the page/detail heading; polling restores surviving identified controls and expanded diagnostics. Missing focused diagnostics fall back to the visible heading. Native anchors support keyboard activation and browser history. Active links use aria-current, an outline, weight and underline. Narrow navigation wraps and only the Work table scrolls horizontally.

## Alternatives considered
A router/framework migration adds dependencies and churn without improving this structural slice. Path routes require static-serving changes and break existing hash links. Deriving route ownership from phase, executor status or evidence violates the frontend boundary; ownership depends only on the requested route and WorkKey identity.

## Consequences
No transport, domain or operations changes. Hidden panels remain in DOM for refresh state retention, but have no interactive accessibility presence. Later V2 pages can replace panel content independently. Browser smoke captures desktop/narrow screenshots; full host validation, independent exact-HEAD review and delivery remain host-owned.
