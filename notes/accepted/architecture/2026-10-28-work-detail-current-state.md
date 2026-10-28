# Agent Note: Work Detail current-state presentation
Status: accepted

## Problem
Operators need the current conclusion and execution identities without expanding diagnostic evidence; source observations and review targets may disagree.

## Decision
For §13 adjacent / #173, render supplied WorkProjection fields in separate conclusion, execution and identity, freshness and WorkKey-scoped executor regions. Keep every exact review target independent and preserve the existing Why area. Links accept HTTP(S) only. Browser presentation does not evaluate review validity or freshness.

## Alternatives considered
Combining review targets into an approval badge would hide mismatches and imply a client-side validity decision. Raw JSON alone forces operators through implementation details.

## Consequences
Missing fields are explicit and complete SHA text remains selectable. New presentation helpers remain fingerprinted and subject to the existing observation guards; future projection fields require deliberate presentation and validation.
