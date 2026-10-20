---
id: 20261020T174759Z-konohaos-code-graph-trial-2026-10-20-dec
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T17:47:59.445Z
tags: 
supersedes: 20261020T174340Z-konohaos-code-graph-trial-2026-10-20-dec
---

KonohaOS code_graph trial (2026-10-20), decision: not re-plugged. On iautos-front: graph index ignores its path argument and walks the whole repo, does not honor .gitignore (it parsed apps/pro-v2/.output build bundles), and one minified file (apps/web/public/vendor/maplibre-gl-worker.mjs) aborts the whole index (sqlite UNIQUE on code_symbols). With .output and vendor excluded by hand: 2,692 files, 15.8 s. Callers of 4 pro-v2 functions vs grep (26 true callers): default INFERRED finds 1; with AMBIGUOUS, recall about 62 percent and precision about 50 percent, mixing same-name symbols of apps/pro and apps/web, because the 1,342 path-alias imports (@/...) are not resolved; 2.5 to 9 k chars per answer. On orch (no aliases) it was right 3 of 4. Revisit only once KonohaOS resolves tsconfig path aliases, honors .gitignore and skips bad files instead of aborting; grep or Explore meanwhile.
