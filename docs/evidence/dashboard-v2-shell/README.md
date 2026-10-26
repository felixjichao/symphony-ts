# Dashboard V2 shell browser acceptance (#169 / #178)

Host acceptance on 2026-10-26 uses the repository Chromium smoke with the already
installed Microsoft Edge 156.0.4314.42 and Playwright 1.62.1. Browser dependencies
were not downloaded or added to the project. [JSON](smoke.json) records all 23
successful scenarios, snapshot GET requests and the built asset SHA-256 hashes.
[Image hashes](screenshots.sha256.json) identify retained screenshots.

The first host run exposed two harness races: the initial Overview heading already
matched before hashchange completed, and the beta WorkKey detail was read before
its heading appeared. The smoke now waits for the original focus and detail
conditions before retaining the original assertions. No product source, assertion,
transport contract or projection semantics changed during this acceptance follow-up.

Desktop: [Overview](overview.png), [Work](work.png), [Executors](executors.png),
[System](system.png). At 390px: [Overview](narrow-overview.png), [Work](narrow-work.png),
[Executors](narrow-executors.png), [System](narrow-system.png),
[Work Detail](narrow-detail.png). Narrow tables retain horizontal scrolling inside
their panel; screenshots do not substitute for behavioral assertions.

This is built-product controlled/demo consumer acceptance, including real loopback
transport failure/recovery. It does not claim external production provider acceptance.
The issue/PR trail records the final exact HEAD, formal smoke exit status and
independent Review. Earlier coding-sandbox SIGABRT remains failure provenance.
