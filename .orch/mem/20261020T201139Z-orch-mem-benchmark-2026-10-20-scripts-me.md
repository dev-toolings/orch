---
id: 20261020T201139Z-orch-mem-benchmark-2026-10-20-scripts-me
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T20:11:39.867Z
tags: memory, benchmark
status: superseded
superseded_by: 20261020T204111Z-benchmark-orch-mem-2026-10-20-scripts-me
---

orch mem benchmark (2026-10-20, scripts/mem-bench.ts, 20 private facts with 4 corrections, fresh session per question, same prompt with and without notes). Correct answers with notes vs empty store: Claude haiku 20/20 vs 0/20, Grok 20/20 vs 0/20, Codex gpt-6-luna low 16/20 then 20/20 after the rule 'write notes in the operator's language' (it had written English notes for French questions; keyword recall missed them). Corrections 4/4 everywhere, 0 stale answers. Recall sessions cost less with notes: tokens -31% Claude (80k vs 117k), -71% Grok (47k vs 163k), -9% Codex; Grok USD 0.65 vs 1.57 for 20 questions. One learn session: Claude 0.02 USD, Grok 0.35 USD. Whole campaign about 2.8 USD plus Codex quota. Not the same corpus as KonohaOS full/S (0/20 learned, +149% to +238% cost).
