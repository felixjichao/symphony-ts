# Agent Note: Work Detail Why presentation
Status: accepted

## Problem
Operators need evidence and contradictions behind the supplied Work projection without reproducing the projector or misattributing foreign observations (SPEC §13 adjacent, #174).

## Decision
Display supplied conclusion, source freshness, exact review identities and grouped source/role evidence as distinct surfaces. Show evidence detail and provenance in the common path and retain native disclosure for raw fields. Select nested evidence by full WorkKey; global diagnostics remain separately labelled in System. The read model remains the sole authority for approval, freshness and anomalies.

## Alternatives considered
Recomputing mismatch or freshness in the browser would create a second semantic authority and could disagree with partial source observations. Showing raw JSON alone would obscure the supplied explanation.

## Consequences
The UI can explain only what the read model supplies; missing fields remain explicitly missing. Stable disclosure identities preserve focus and open state across refresh where possible. Tests guard the presentation boundary and isolation.
