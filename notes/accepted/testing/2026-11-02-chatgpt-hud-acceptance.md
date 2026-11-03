# Agent Note: ChatGPT HUD browser acceptance
Status: accepted

## Problem
The per-tab admission checkbox can disappear under host-page CSS even when DOM tests pass. SPEC §4 Decision extension and §17/§18 require meaningful presentation evidence.

## Decision
Exercise the built userscript in credential-free Chromium against hostile form styles, with a separate live ChatGPT/Tampermonkey smoke procedure. Keep admission authority and persistence unchanged.

## Alternatives considered
DOM-only tests cannot establish rendered visibility or pointer and keyboard interaction. Automated live ChatGPT tests require credentials and an unstable external service.

## Consequences
CI retains checkout-labelled screenshots and a report. The deterministic fixture cannot certify future ChatGPT styles or replace the live smoke check.
