---
id: 20261021T001337Z-benchmark-orch-mem-scripts-mem-bench-ts-
scope: project
harness: claude
session: claude-mvh8fmh5
date: 2026-10-21T00:13:37.064Z
tags: benchmark, bench, vitesse, coût, effort, fast, tags, mémoire
supersedes: 20261020T232729Z-benchmark-orch-mem-scripts-mem-bench-ts-
---

Benchmark orch mem (scripts/mem-bench.ts, facturé, sur demande seulement ; options BENCH_EFFORT, BENCH_TAGS=0, BENCH_CONTROL=0, BENCH_FAST=0 ; rapport sans appel modèle : bun scripts/mem-bench-report.ts <dossier>). 20 décisions d'un projet fictif Atlas, dont 4 corrigées ; avec une mémoire vide, 0/20 partout. Matrice tags (2026-10-20) : sans tags 173/180, avec tags 178/180 ; F14 (paraphrase sans mot commun) ratée dans 5 cellules sur 9 sans tags, dans aucune avec tags. Règle des tags livrée dans catalog/lead.md. Bench vitesse (2026-10-21, tags activés, 15 cellules, 5,06 USD plus le quota Codex), par question : Claude haiku 20/20 à tous les efforts, 7 à 7,6 s, 0,0052 USD ; Codex gpt-6-luna fast 18, 19, 20 (low, medium, high), 5,8 à 6,3 s, en standard 19, 17, 20, 5,8 à 6,9 s, donc le mode Fast ne gagne presque rien sur des sessions courtes ; Grok grok-4.7-build-fast 20/20, 6,1 / 7,1 / 8,1 s, 0,034 à 0,037 USD ; grok-4.7 20/20, 7,6 / 8,6 / 9,7 s, 0,017 à 0,019 USD, soit deux fois moins cher pour environ 1,5 s de plus. L'effort augmente la durée et les tokens de raisonnement sans gain mesurable pour Claude et Grok ; Codex n'est stable qu'en high. Pas de vectoriel ni de tree-sitter.
