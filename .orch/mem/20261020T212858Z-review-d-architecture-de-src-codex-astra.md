---
id: 20261020T212858Z-review-d-architecture-de-src-codex-astra
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T21:28:58.443Z
tags: architecture, review
---

Review d'architecture de src/ (Codex Astra high, 2026-10-20, à d4205fe) : pas de DDD complet pour une CLI Bun de 2 100 lignes sans base ni service ; axe retenu C, rester à plat et extraire quelques coutures. Vocabulaire DDD gardé pour les contextes (exécution des lanes, mémoire, installation, docs), fonctions de politique sans I/O, ports étroits seulement là où la substitution paie. Plan en 4 étapes, make check vert à chacune : 1) extraire src/worktree.ts de lane.ts (git, statusEntries, statusPaths, SNAPSHOT_LIMITS, workerBase) ; 2) déplacer bound dans src/output.ts (orch.ts n'importe lane.ts que pour ça) avec un contrôle d'import ; 3) validation et épinglage Grok dans src/grok-runtime.ts (doctor.ts importe lane.ts pour ça) ; 4) formatage du rapport dans src/report.ts. Doublons vérifiés : stateDir répété (lane.ts:15, orch.ts:21, mem.ts:49), appels git dispersés (lane.ts, docs.ts, mem.ts). À ne pas faire : hexagonal complet, agrégats, repositories, supprimer les tests à faux binaires, sortir l'allowlist d'env de proc.ts. Non commencé : attend le merge de feat/lane-orca-channel (session tanship) puis le go de l'opérateur.
