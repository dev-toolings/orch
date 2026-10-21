---
id: 20261020T220813Z-architecture-de-src-dossiers-par-context
scope: project
harness: claude
session: claude-mvh8fmh5
date: 2026-10-20T22:08:13.244Z
tags: 
supersedes: 20261020T220426Z-architecture-de-src-review-codex-astra-h
---

Architecture de src/ : dossiers par contexte depuis le 2026-10-20, à la demande de l'opérateur (remplace « rester à plat »). La racine de src/ ne garde que les trois points d'entrée installés (orch.ts, lane.ts, lead.ts, liés depuis ~/.local/bin, donc pas de orch install à refaire). Dossiers : core/ (paths, git, output, profile ; ROOT remonte de deux niveaux), harness/ (harness, grok-runtime, proc), lanes/ (worktree, report, slots, spec), install/ (render, manifest, doctor), mem/, docs/, checks/ (parity, smoke). Coutures de la review Codex Astra (commit addb86e) conservées. À ne pas faire : hexagonal complet, agrégats, repositories, couches domain/infra, supprimer les tests à faux binaires, sortir l'allowlist d'env de proc.ts.
