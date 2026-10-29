# Agent Note: Dashboard operational views
Status: accepted

## Problem
Operators need executor ownership and observation health without interpreting missing source data as a healthy empty inventory or mixing transport errors with source health.

## Decision
For #175 / SPEC §13 adjacent, render the supplied snapshot and polling state in dedicated Dashboard pages. Use full WorkKey links and keep source, snapshot and transport observations separate. Group work anomalies by supplied WorkKey and retain detailed evidence in Work Detail.

## Alternatives considered
Deriving executor liveness or a combined health indicator in the browser would introduce a second authority and conceal partial failures, so it was rejected.

## Consequences
The pages remain read-only and useful with partial data. Their conclusions depend on the supplied observations; the browser does not repair sources or infer liveness.
