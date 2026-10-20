---
id: 20261020T174340Z-konohaos-code-graph-trial-2026-10-20-dec
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T17:43:40.215Z
tags: konohaos, code-graph
---

KonohaOS code_graph trial (2026-10-20), decision: not re-plugged. Index crashed on iautos-front/apps/pro-v2 (sqlite3 UNIQUE constraint failed: code_symbols.workspace_id, path, qualname, kind, start_line) after 8.7 s. On orch (24 TS files, 0.2 s): callers/impact right for reserveSlot, statusEntries, workerBase (transitive included), 2 false callers out of 5 for leadGuard (parity.ts, mem.test.ts); about 4,300 chars per answer where grep gives the direct callers in a few hundred. Revisit only once KonohaOS indexes the operator's TS repos; grep or Explore meanwhile. Of 94 KonohaOS observations, one was worth importing (operator note 20261020T174221Z); the rest were repo-derivable, done or snapshots.
