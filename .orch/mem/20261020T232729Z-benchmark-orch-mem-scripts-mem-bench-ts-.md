---
id: 20261020T232729Z-benchmark-orch-mem-scripts-mem-bench-ts-
scope: project
harness: claude
session: claude-mvh8fmh5
date: 2026-10-20T23:27:29.537Z
tags: 
status: superseded
supersedes: 20261020T204111Z-benchmark-orch-mem-2026-10-20-scripts-me
superseded_by: 20261021T001337Z-benchmark-orch-mem-scripts-mem-bench-ts-
---

Benchmark orch mem (scripts/mem-bench.ts, facturé, sur demande seulement ; options BENCH_EFFORT, BENCH_TAGS=1, BENCH_CONTROL=0 ; Grok épinglé sur grok-4.7-build-fast). 20 décisions d'un projet fictif Atlas, dont 4 corrigées. Run du 2026-10-20 avec mémoire vide : 0/20 partout, donc la mémoire est indispensable. Matrice du 2026-10-20 (3 harnais x effort low/medium/high x tags oui/non, 18 cellules, environ 7,4 USD plus le quota Codex) : sans tags 173/180, avec tags 178/180. Raté F14 (question « outil d'accès à la base », note « ORM, SQL brut, Kysely », aucun mot commun) : 5 cellules sur 9 sans tags, 0 sur 9 avec tags. L'effort ne change rien de mesurable (low 116/120, medium 116/120, high 119/120, écart dans le bruit pour n=20). Coût par question stable selon l'effort (Claude haiku 0,005 USD, Grok 0,035 à 0,04 USD) ; seul l'apprentissage Grok double (0,24 USD en low, 0,58 USD en high). Les notes de correction (supersede) restent sans tags. Ratés restants : Codex répond « unknown » après une recherche trop faible. Leviers non faits : search affiche le corps de la meilleure note, règle « aucune note : unknown sans fouiller ». Pas de vectoriel ni de tree-sitter : l'index de Cursor accélère grep mais ne relie pas des mots différents.
