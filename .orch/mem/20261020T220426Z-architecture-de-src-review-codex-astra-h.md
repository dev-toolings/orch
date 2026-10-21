---
id: 20261020T220426Z-architecture-de-src-review-codex-astra-h
scope: project
harness: claude
session: claude-mvgsnbac
date: 2026-10-20T22:04:26.112Z
tags: architecture, review
status: superseded
supersedes: 20261020T212858Z-review-d-architecture-de-src-codex-astra
superseded_by: 20261020T220813Z-architecture-de-src-dossiers-par-context
---

Architecture de src/ (review Codex Astra high du 2026-10-20) : pas de DDD complet pour une CLI Bun d'environ 2 100 lignes ; axe C, rester à plat et extraire des coutures, avec le vocabulaire DDD pour les contextes (lanes, mémoire, installation, docs) et des fonctions de règles sans I/O. Réalisé le même jour (commit addb86e, lane Codex) : src/paths.ts (un seul stateDir), src/git.ts (un seul helper git, docs garde son wrapper qui lève), src/worktree.ts (snapshot et statut), src/output.ts (bound, tail), src/grok-runtime.ts (profils et épinglage Grok), src/report.ts (rapports de lane et de review, texte identique). orch.ts et doctor.ts n'importent plus lane.ts, un test le garde. lane.ts passe de 703 à 514 lignes, 107 tests. À ne pas faire : hexagonal complet, agrégats, repositories, supprimer les tests à faux binaires, sortir l'allowlist d'env de proc.ts.
