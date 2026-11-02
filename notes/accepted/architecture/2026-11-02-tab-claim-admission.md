# Agent Note: Tab-scoped claim admission
Status: accepted

## Problem
Multiple ChatGPT Web tabs sharing a Bridge can claim work without explicit per-tab consent (§4 Decision extension, #180).

## Decision
Gate new claims per Bridge URL and tab identity, independently of shared Start/Stop. Web Locks detect a concurrently live inherited identity; a duplicate rotates identity. A successful in-flight claim is checkpointed immediately and remains recoverable when admission is disabled.

## Alternatives considered
A shared preference would implicitly enable other tabs. Session storage alone is copied by browser tab duplication and cannot safely distinguish a duplicate.

## Consequences
The Bridge retains lease and session authority. Without Web Locks identity rotates on each page load to fail closed, so checkpoint recovery across navigation requires Web Locks.
