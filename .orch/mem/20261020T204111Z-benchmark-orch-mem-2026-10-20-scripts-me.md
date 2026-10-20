---
id: 20261020T204111Z-benchmark-orch-mem-2026-10-20-scripts-me
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T20:41:11.498Z
tags: memoire, benchmark
supersedes: 20261020T201139Z-orch-mem-benchmark-2026-10-20-scripts-me
---

Benchmark orch mem (2026-10-20, scripts/mem-bench.ts, facturé, sur demande seulement) : 20 décisions privées d'un projet fictif Atlas dont 4 corrigées, une session neuve par question, même prompt avec notes et mémoire vide. Réponses justes avec notes / sans : Claude haiku 20/20 / 0/20, Grok 20/20 / 0/20, Codex gpt-6-luna low 16/20 puis 20/20 après la règle 'notes dans la langue de l'opérateur' (il écrivait en anglais pour des questions en français, le rappel par mots-clés ratait). Corrections 4/4 partout, 0 réponse périmée. Tokens par session de rappel plus bas avec notes : Claude 80k contre 117k, Grok 47k contre 163k, Codex 41k contre 46k ; Grok 0,65 contre 1,57 USD pour 20 questions. Apprentissage unique : Claude 0,02 USD, Grok 0,35 USD. Campagne complète environ 2,8 USD plus quota Codex. La mémoire elle-même coûte environ 150 tokens par recherche : le coût vient du préfixe fixe du harness relu à chaque tour. Leviers suivants, non faits : search affiche le corps de la meilleure note (un tour de moins, gain estimé 20 à 30 %), règle 'aucune note : répondre unknown sans fouiller' (Grok fouille 163k tokens). Pas de vectoriel tant qu'un échec de paraphrase dans la même langue n'est pas mesuré ; FTS5 via bun:sqlite si les notes dépassent quelques milliers.
